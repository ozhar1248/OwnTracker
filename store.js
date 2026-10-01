import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDate, validDate, frequencies, statuses } from './public/domain.js';

export class AppError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}

function cleanText(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new AppError(400, `${label}: ${required ? 'יש להזין ערך, ' : ''}עד ${max} תווים.`);
  }
  return value.trim();
}

export function openStore(filename, { today = () => localDate() } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
      description TEXT NOT NULL DEFAULT '',
      frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
      active_from TEXT NOT NULL,
      archived_on TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      change_id INTEGER NOT NULL REFERENCES changes(id),
      date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('done','missed','other')),
      explanation TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(change_id, date)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
  `);

  function changeById(id) {
    const change = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
    if (!change) throw new AppError(404, 'השינוי לא נמצא.');
    return change;
  }
  function changeInput(input) {
    const title = cleanText(input.title, 'כותרת', 120, true);
    const description = cleanText(input.description ?? '', 'תיאור', 4000);
    if (!Object.hasOwn(frequencies, input.frequency)) throw new AppError(400, 'יש לבחור תדירות יומית, שבועית או חודשית.');
    return { title, description, frequency: input.frequency };
  }
  function snapshot() {
    return {
      changes: db.prepare('SELECT * FROM changes ORDER BY created_at, id').all(),
      entries: db.prepare('SELECT * FROM entries ORDER BY date, change_id').all(),
      today: today(),
    };
  }
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    snapshot,
    close: () => db.close(),
    createChange(input) {
      const { title, description, frequency } = changeInput(input);
      const now = new Date().toISOString();
      const result = db.prepare('INSERT INTO changes (title, description, frequency, active_from, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(title, description, frequency, today(), now, now);
      return changeById(Number(result.lastInsertRowid));
    },
    updateChange(id, input) {
      const change = changeById(id);
      if (change.archived_on) throw new AppError(400, 'השינוי נמחק; ההיסטוריה שלו נשמרת לצפייה ולעריכת דיווחים.');
      if (input.version !== change.version) throw new AppError(409, 'השינוי עודכן בחלון אחר. יש לפתוח אותו מחדש לפני שמירה.');
      const { title, description, frequency } = changeInput(input);
      db.prepare('UPDATE changes SET title=?, description=?, frequency=?, updated_at=?, version=version+1 WHERE id=?')
        .run(title, description, frequency, new Date().toISOString(), id);
      return changeById(id);
    },
    archiveChange(id, input) {
      const change = changeById(id);
      if (input.version !== change.version) throw new AppError(409, 'השינוי עודכן בחלון אחר. יש לפתוח אותו מחדש.');
      if (change.archived_on) throw new AppError(400, 'השינוי כבר נמחק.');
      db.prepare('UPDATE changes SET archived_on=?, updated_at=?, version=version+1 WHERE id=?')
        .run(today(), new Date().toISOString(), id);
      return changeById(id);
    },
    saveEntry(changeId, input, editing) {
      const change = changeById(changeId);
      if (!validDate(input.date)) throw new AppError(400, 'יש לבחור תאריך תקין.');
      if (input.date > today()) throw new AppError(400, 'אפשר למלא דיווח עד היום, ללא תאריכים עתידיים.');
      if (change.archived_on && input.date > change.archived_on) throw new AppError(400, 'התאריך מאוחר ממועד מחיקת השינוי.');
      if (!Object.hasOwn(statuses, input.status)) throw new AppError(400, 'יש לבחור בוצע, לא בוצע או אחר.');
      const explanation = cleanText(input.explanation ?? '', 'הסבר', 8000);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM entries WHERE change_id=? AND date=?').get(changeId, input.date);
        if (!editing && existing) throw new AppError(409, 'כבר קיים דיווח לתאריך הזה. אפשר לעבור לעריכתו.', { entry: existing });
        if (editing && !existing) throw new AppError(404, 'הדיווח לעריכה לא נמצא.');
        if (editing && input.version !== existing.version) throw new AppError(409, 'הדיווח עודכן בחלון אחר. יש לטעון את הגרסה העדכנית.', { entry: existing });
        const now = new Date().toISOString();
        if (editing) {
          db.prepare('UPDATE entries SET status=?, explanation=?, updated_at=?, version=version+1 WHERE id=?')
            .run(input.status, explanation, now, existing.id);
        } else {
          db.prepare('INSERT INTO entries (change_id, date, status, explanation, created_at, updated_at) VALUES (?,?,?,?,?,?)')
            .run(changeId, input.date, input.status, explanation, now, now);
        }
        // Backfilling extends the activity window without changing the creation timestamp.
        if (input.date < change.active_from) db.prepare('UPDATE changes SET active_from=? WHERE id=?').run(input.date, changeId);
        return db.prepare('SELECT * FROM entries WHERE change_id=? AND date=?').get(changeId, input.date);
      });
    },
  };
}
