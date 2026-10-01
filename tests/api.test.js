import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.js';

async function fixture(t) {
  const server = createApp({ dbPath: ':memory:', today: () => '2026-10-01', clientConfig: { mode: 'local' } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body, headers = {}) => fetch(`${base}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { request, base };
}

test('HTTP lifecycle: create, log, duplicate conflict, edit, report, archive and backup', async t => {
  const { request } = await fixture(t);
  const create = await request('/api/changes', 'POST', { title: '<script>alert(1)</script>', frequency: 'daily' });
  assert.equal(create.status, 201);
  const change = await create.json();
  assert.equal(change.title, '<script>alert(1)</script>');
  const saved = await request(`/api/changes/${change.id}/entries`, 'POST', { date: '2026-10-01', status: 'missed', explanation: 'רציתי להסביר' });
  assert.equal(saved.status, 201);
  const duplicate = await request(`/api/changes/${change.id}/entries`, 'POST', { date: '2026-10-01', status: 'done' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).entry.explanation, 'רציתי להסביר');
  const edited = await request(`/api/changes/${change.id}/entries`, 'PUT', { date: '2026-10-01', status: 'other', explanation: 'תיקון', version: 1 });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).version, 2);
  assert.equal((await request(`/api/changes/${change.id}`, 'DELETE', { version: 1 })).status, 200);
  const report = await request('/api/report?date=2026-10-01&period=weekly');
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-type'), /text\/plain/);
  assert.match(await report.text(), /נמחק בתאריך 2026-10-01/);
  const state = await (await request('/api/state')).json();
  assert.equal(state.changes.length, 1);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].explanation, 'תיקון');
  const backup = await request('/api/backup');
  assert.match(backup.headers.get('content-disposition'), /attachment/);
  assert.equal((await backup.json()).format, 'owntracker-v1');
});

test('rejects cross-origin requests and invalid payloads without altering data', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/changes', 'POST', { title: 'x', frequency: 'daily' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request('/api/state', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${base}/api/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'broken{' })).status, 400);
  assert.equal((await fetch(`${base}/api/changes`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request('/api/changes', 'POST', { title: 'x'.repeat(70000), frequency: 'daily' })).status, 413);
  assert.equal((await request('/api/report?date=2026-02-30&period=daily')).status, 400);
  assert.equal((await request('/api/report?date=2026-10-01&period=toString')).status, 400);
  assert.equal((await request('/data/owntracker.sqlite')).status, 404);
  assert.equal((await (await request('/api/state')).json()).changes.length, 0);
});

test('serves local assets with correct types and without exposing server source', async t => {
  const { request } = await fixture(t);
  const root = await request('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /lang="he" dir="rtl"/);
  assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const module = await request('/app.js');
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  assert.equal((await request('/server.js')).status, 404);
});

test('serves an installable manifest with correctly sized Android PNG icons', async t => {
  const { request } = await fixture(t);
  const response = await request('/manifest.webmanifest');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await response.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'he');
  assert.equal(manifest.start_url, '/#tracker');
  for (const icon of manifest.icons) {
    const image = await request(icon.src);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  assert.equal((await request('/install.js')).status, 200);
});
