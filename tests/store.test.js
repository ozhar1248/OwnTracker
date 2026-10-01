import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.js';
import { periodRange, shiftPeriod, createReport, validDate, localDate, activeOn, overlaps } from '../public/domain.js';

function fixture(t, initial = '2026-10-01') {
  let date = initial;
  const store = openStore(':memory:', { today: () => date });
  t.after(() => store.close());
  const change = store.createChange({ title: 'לא לאכול לפני השינה', description: 'שלוש שעות לפני', frequency: 'daily' });
  return { store, change, setDate: value => { date = value; } };
}
const entry = (date, status = 'done', explanation = '') => ({ date, status, explanation });
const fails = (action, status) => assert.throws(action, error => error.status === status);

test('calendar periods use Sunday through Saturday and handle leap years and year changes', () => {
  assert.deepEqual(periodRange('2026-10-01', 'weekly'), { start: '2026-09-27', end: '2026-10-03' });
  assert.deepEqual(periodRange('2024-02-20', 'monthly'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(periodRange('2026-12-31', 'weekly'), { start: '2026-12-27', end: '2027-01-02' });
  assert.deepEqual(periodRange('2026-10-01', 'daily'), { start: '2026-10-01', end: '2026-10-01' });
  assert.equal(shiftPeriod('2026-01-31', 'monthly', 1), '2026-02-01');
  assert.equal(shiftPeriod('2026-12-15', 'monthly', 1), '2027-01-01');
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(validDate('2026-10-01junk'), false);
  assert.equal(localDate(new Date(2026, 9, 1, 0, 1)), '2026-10-01');
});

test('creates and edits title, optional description and frequency, rejecting stale changes', t => {
  const { store, change } = fixture(t);
  const updated = store.updateChange(change.id, { title: '  הליכה  ', description: '', frequency: 'weekly', version: 1 });
  assert.equal(updated.title, 'הליכה');
  assert.equal(updated.description, '');
  assert.equal(updated.frequency, 'weekly');
  assert.equal(updated.version, 2);
  fails(() => store.updateChange(change.id, { title: 'stale', frequency: 'daily', version: 1 }), 409);
  assert.equal(store.snapshot().changes[0].title, 'הליכה');
});

test('validates changes and rejects invalid or oversized input', t => {
  const { store } = fixture(t);
  for (const title of ['', '    ', 'a'.repeat(121), 42]) fails(() => store.createChange({ title, frequency: 'daily' }), 400);
  for (const frequency of ['other', 'toString', '__proto__', null]) fails(() => store.createChange({ title: 'test', frequency }), 400);
  fails(() => store.createChange({ title: 'test', frequency: 'daily', description: 'x'.repeat(4001) }), 400);
  const monthly = store.createChange({ title: 'monthly', frequency: 'monthly' });
  assert.equal(monthly.description, '');
});

test('one entry per change and date; explicit edit preserves identity and increments version', t => {
  const { store, change } = fixture(t);
  const saved = store.saveEntry(change.id, entry('2026-10-01', 'missed', 'ארוחת ערב מאוחרת'), false);
  fails(() => store.saveEntry(change.id, entry('2026-10-01'), false), 409);
  assert.equal(store.snapshot().entries.length, 1);
  assert.equal(store.snapshot().entries[0].explanation, 'ארוחת ערב מאוחרת');
  const updated = store.saveEntry(change.id, { ...entry('2026-10-01', 'other', 'עדכון'), version: saved.version }, true);
  assert.equal(updated.id, saved.id);
  assert.equal(updated.created_at, saved.created_at);
  assert.equal(updated.version, 2);
  assert.equal(updated.status, 'other');
  fails(() => store.saveEntry(change.id, { ...entry('2026-10-01'), version: 1 }, true), 409);
  fails(() => store.saveEntry(change.id, { ...entry('2026-09-30'), version: 1 }, true), 404);
  assert.equal(store.snapshot().changes[0].active_from, '2026-10-01');
});

test('backfill extends activity interval and survives archive, including archive date', t => {
  const { store, change, setDate } = fixture(t);
  store.saveEntry(change.id, entry('2026-09-27'), false);
  assert.equal(store.snapshot().changes[0].active_from, '2026-09-27');
  const deleted = store.archiveChange(change.id, { version: 1 });
  assert.equal(deleted.archived_on, '2026-10-01');
  assert.equal(activeOn(deleted, '2026-10-01'), true);
  assert.equal(activeOn(deleted, '2026-10-02'), false);
  assert.equal(overlaps(deleted, '2026-09-20', '2026-09-26'), false);
  assert.equal(overlaps(deleted, '2026-09-27', '2026-10-03'), true);
  assert.equal(overlaps(deleted, '2026-10-04', '2026-10-10'), false);
  store.saveEntry(change.id, entry('2026-10-01', 'other'), false);
  setDate('2026-10-05');
  fails(() => store.saveEntry(change.id, entry('2026-10-02'), false), 400);
  const existing = store.snapshot().entries[0];
  store.saveEntry(change.id, { ...entry('2026-09-27', 'missed', 'תיקון'), version: existing.version }, true);
  assert.equal(store.snapshot().entries[0].status, 'missed');
  fails(() => store.updateChange(change.id, { title: 'new', frequency: 'daily', version: 2 }), 400);
});

test('entries reject future dates, impossible dates, invalid statuses and excessive explanations', t => {
  const { store, change } = fixture(t);
  for (const date of ['2026-10-02', '2026-02-30', '01/10/2026', '', null]) fails(() => store.saveEntry(change.id, entry(date), false), 400);
  for (const status of ['toString', 'unknown', null]) fails(() => store.saveEntry(change.id, entry('2026-10-01', status), false), 400);
  fails(() => store.saveEntry(change.id, entry('2026-10-01', 'done', 'x'.repeat(8001)), false), 400);
  fails(() => store.saveEntry(999, entry('2026-10-01'), false), 404);
  assert.equal(store.snapshot().entries.length, 0);
});

test('report distinguishes missing, other, future and inactive days and includes explanations', t => {
  const { store, change } = fixture(t);
  store.saveEntry(change.id, entry('2026-09-28', 'done', 'הכנתי מראש'), false);
  store.saveEntry(change.id, entry('2026-09-29', 'missed', 'אירוע משפחתי'), false);
  store.saveEntry(change.id, entry('2026-10-01', 'other', 'שינוי בתוכנית\nשורה שנייה'), false);
  const report = createReport(store.snapshot(), '2026-10-01', 'weekly');
  assert.match(report, /בוצע 1; לא בוצע 1; אחר 1; ימים ללא מילוי 1/);
  assert.match(report, /2026-09-30: חסר מילוי/);
  assert.match(report, /2026-10-02: יום עתידי/);
  assert.doesNotMatch(report, /- 2026-09-27:/);
  assert.match(report, /אירוע משפחתי/);
  assert.ok(report.includes('שינוי בתוכנית\\nשורה שנייה'));
  assert.match(report, /בשינוי שבועי או חודשי אין לצפות לביצוע בכל יום/);
});

test('daily, weekly and monthly reports include only changes active in the selected period', t => {
  const { store, change, setDate } = fixture(t);
  store.saveEntry(change.id, entry('2026-09-20'), false);
  store.archiveChange(change.id, { version: 1 });
  setDate('2026-10-10');
  const later = store.createChange({ title: 'שינוי חדש מאוחר', frequency: 'monthly' });
  for (const period of ['daily', 'weekly', 'monthly']) {
    const report = createReport(store.snapshot(), '2026-09-20', period);
    assert.ok(report.includes(`## שינוי ${change.id}:`));
    assert.match(report, /נמחק בתאריך 2026-10-01/);
    assert.ok(!report.includes(`## שינוי ${later.id}:`));
  }
  const after = createReport(store.snapshot(), '2026-10-10', 'daily');
  assert.ok(!after.includes(`## שינוי ${change.id}:`));
  assert.ok(after.includes(`## שינוי ${later.id}:`));
  assert.match(createReport(store.snapshot(), '2025-01-01', 'monthly'), /לא היו שינויים פעילים/);
});

test('SQLite persists real data across closing and reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'owntracker-test-'));
  const filename = join(directory, 'test.sqlite');
  let store;
  try {
    store = openStore(filename, { today: () => '2026-10-01' });
    const change = store.createChange({ title: 'נשמר אחרי הפעלה מחדש', frequency: 'daily' });
    store.saveEntry(change.id, entry('2026-10-01', 'done', 'טקסט בעברית'), false);
    store.close();
    store = openStore(filename, { today: () => '2026-10-01' });
    assert.equal(store.snapshot().changes[0].title, 'נשמר אחרי הפעלה מחדש');
    assert.equal(store.snapshot().entries[0].explanation, 'טקסט בעברית');
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
