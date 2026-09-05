import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MIGRATIONS } from './schema.ts';

/**
 * The store lives outside any repo: it spans every project on the machine,
 * and it must survive deleting a checkout. Override with TOKENVIZ_HOME.
 */
export function storePath(): string {
  return process.env.TOKENVIZ_HOME
    ? join(process.env.TOKENVIZ_HOME, 'tokenviz.db')
    : join(homedir(), '.tokenviz', 'tokenviz.db');
}

export function openDb(path = storePath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const applied = row.user_version;
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${i + 1} failed: ${(err as Error).message}`);
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
