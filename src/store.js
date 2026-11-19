import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureStoreHome, log } from './paths.js';

const SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key        TEXT NOT NULL,
  cwd                TEXT NOT NULL,
  source_session_id  TEXT NOT NULL,
  source_transcript  TEXT NOT NULL,
  trimmed_session_id TEXT,
  trimmed_transcript TEXT,
  trimmed_jsonl      BLOB,
  turns_json         TEXT NOT NULL,
  turn_count         INTEGER NOT NULL,
  prompt_uuids       TEXT NOT NULL,
  end_reason         TEXT,
  claude_version     TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_key, created_at DESC);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function dbPath() {
  return path.join(ensureStoreHome(), 'store.db');
}

function openAt(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  return db;
}

export function openStore() {
  const file = dbPath();
  let db;
  try {
    db = openAt(file);
  } catch (err) {
    if (!fs.existsSync(file)) throw err;
    const moved = `${file}.corrupt-${Date.now()}`;
    log(`store.db could not be opened (${err.message}); moved to ${moved}`);
    fs.renameSync(file, moved);
    db = openAt(file);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
  return new Store(db);
}

function toRow(r) {
  if (!r) return null;
  const row = { ...r };
  if (row.trimmed_jsonl != null) row.trimmed_jsonl = Buffer.from(row.trimmed_jsonl).toString('utf8');
  return row;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  insert(s) {
    const res = this.db
      .prepare(
        `INSERT INTO snapshots (project_key, cwd, source_session_id, source_transcript, trimmed_session_id,
          trimmed_transcript, trimmed_jsonl, turns_json, turn_count, prompt_uuids, end_reason, claude_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.projectKey,
        s.cwd,
        s.sourceSessionId,
        s.sourceTranscript,
        s.trimmedSessionId ?? null,
        s.trimmedTranscript ?? null,
        s.trimmedJsonl != null ? Buffer.from(s.trimmedJsonl, 'utf8') : null,
        JSON.stringify(s.turns),
        s.turns.length,
        JSON.stringify(s.promptUuids),
        s.endReason ?? null,
        s.claudeVersion ?? null,
        s.createdAt ?? new Date().toISOString()
      );
    return Number(res.lastInsertRowid);
  }

  latest(projectKey) {
    return toRow(
      this.db
        .prepare('SELECT * FROM snapshots WHERE project_key = ? ORDER BY created_at DESC, id DESC LIMIT 1')
        .get(projectKey)
    );
  }

  get(id) {
    return toRow(this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(Number(id)));
  }

  list(projectKey, limit = 20) {
    const cols =
      'id, project_key, cwd, source_session_id, trimmed_session_id, turns_json, turn_count, end_reason, created_at';
    const rows = projectKey
      ? this.db
          .prepare(`SELECT ${cols} FROM snapshots WHERE project_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
          .all(projectKey, limit)
      : this.db.prepare(`SELECT ${cols} FROM snapshots ORDER BY project_key, created_at DESC, id DESC`).all();
    return rows.map(toRow);
  }

  knownPromptUuids(projectKey) {
    const set = new Set();
    for (const r of this.db.prepare('SELECT prompt_uuids FROM snapshots WHERE project_key = ?').all(projectKey)) {
      try {
        for (const u of JSON.parse(r.prompt_uuids)) set.add(u);
      } catch {
        // ignore a bad row
      }
    }
    return set;
  }

  knownTrimmedSessionIds() {
    return new Set(
      this.db
        .prepare('SELECT trimmed_session_id FROM snapshots WHERE trimmed_session_id IS NOT NULL')
        .all()
        .map((r) => r.trimmed_session_id)
    );
  }

  prune(projectKey, keep) {
    return Number(
      this.db
        .prepare(
          `DELETE FROM snapshots WHERE project_key = ? AND id NOT IN (
             SELECT id FROM snapshots WHERE project_key = ? ORDER BY created_at DESC, id DESC LIMIT ?)`
        )
        .run(projectKey, projectKey, keep).changes
    );
  }

  forget(projectKey) {
    return Number(this.db.prepare('DELETE FROM snapshots WHERE project_key = ?').run(projectKey).changes);
  }
}
