// CogMemory MCP — Database connection with pragma setup

import Database from "better-sqlite3";
import { runMigrations } from "./migration-runner.js";

let db: Database.Database | null = null;

/**
 * Open (or return existing) database connection with WAL + foreign_keys pragmas.
 * Runs versioned schema migrations on every open (pending migrations only).
 */
export function openDatabase(dbPath: string): Database.Database {
  if (db) {
    return db;
  }

  db = new Database(dbPath);

  // Set pragmas on every connection open
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run versioned migrations (applies pending migrations only; idempotent for up-to-date DBs)
  runMigrations(db, dbPath);

  return db;
}

/**
 * Get the current database connection (throws if not opened).
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call openDatabase() first.");
  }
  return db;
}

/**
 * Close the current database connection.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
