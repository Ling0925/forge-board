import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../domain/index.js";

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function initializeDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      workspace_id TEXT NOT NULL,
      version TEXT PRIMARY KEY
    )`);
    const directory = new URL("../store/migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()) {
      if (
        db
          .prepare("SELECT version FROM schema_migrations WHERE version = ?")
          .get(file)
      )
        continue;
      db.exec(readFileSync(new URL(file, directory), "utf8"));
      db.prepare(
        "INSERT INTO schema_migrations (workspace_id, version) VALUES (?, ?)",
      ).run(DEFAULT_WORKSPACE_ID, file);
    }
    db.prepare(
      "INSERT INTO workspaces (id, workspace_id, name) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
    ).run(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, "Default");
  });
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  initializeDatabase(db);
  return db;
}
