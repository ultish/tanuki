import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const defaultPath =
  process.env.TANUKI_DB_PATH ??
  path.resolve(process.cwd(), "../../data/tanuki.db");

export function getDbPath(): string {
  return process.env.TANUKI_DB_PATH ?? defaultPath;
}

export function openDb(dbPath = getDbPath()): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function getJson<T>(db: Database.Database, key: string): T | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.value) as T;
}

export function setJson(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value));
}
