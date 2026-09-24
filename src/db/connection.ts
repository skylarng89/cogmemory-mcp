// CogMemory MCP — Database connections with serialized initialization.
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { runMigrations } from "./migration-runner.js";
import { withFileLock } from "../file-lock.js";

const connections = new Set<Database.Database>();

/** A connection is published only after migrations succeed. */
export function openDatabase(dbPath: string): Database.Database {
  const path = resolve(dbPath);
  return withFileLock(`${path}.init.lock`, () => {
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      runMigrations(db, path);
      connections.add(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
}

export function closeDatabase(connection?: Database.Database): void {
  for (const db of connections) {
    if (connection && connection !== db) continue;
    if (db.open) db.close();
    connections.delete(db);
  }
}
