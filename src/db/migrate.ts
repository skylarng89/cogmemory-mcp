// CogMemory MCP — Idempotent schema migration

import type Database from "better-sqlite3";

/**
 * Apply the full CogMemory schema idempotently.
 * All CREATE TABLE and CREATE INDEX statements use IF NOT EXISTS.
 */
export function migrate(db: Database.Database): void {
  db.exec(`
    -- ─── MEMORY: sessions ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      summary      TEXT
    );

    -- ─── MEMORY: decisions ────────────────────────────────
    CREATE TABLE IF NOT EXISTS decisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      rationale    TEXT,
      tags         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_session   ON decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_tags      ON decisions(tags);
    CREATE INDEX IF NOT EXISTS idx_decisions_created   ON decisions(created_at);

    -- ─── MEMORY: conventions ──────────────────────────────
    CREATE TABLE IF NOT EXISTS conventions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      category     TEXT NOT NULL,
      key          TEXT NOT NULL,
      value        TEXT,
      description  TEXT,
      tags         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(category, key)
    );
    CREATE INDEX IF NOT EXISTS idx_conventions_category ON conventions(category);
    CREATE INDEX IF NOT EXISTS idx_conventions_tags      ON conventions(tags);

    -- ─── MEMORY: errors ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS errors (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      error_signature  TEXT NOT NULL,
      description      TEXT,
      resolution       TEXT,
      tags             TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_errors_session    ON errors(session_id);
    CREATE INDEX IF NOT EXISTS idx_errors_signature  ON errors(error_signature);
    CREATE INDEX IF NOT EXISTS idx_errors_tags       ON errors(tags);

    -- ─── MEMORY: context ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS context (
      key          TEXT PRIMARY KEY,
      value        TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ─── MEMORY: changelog ────────────────────────────────
    CREATE TABLE IF NOT EXISTS changelog (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      summary      TEXT NOT NULL,
      ref          TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_changelog_session ON changelog(session_id);
    CREATE INDEX IF NOT EXISTS idx_changelog_created ON changelog(created_at);

    -- ─── MEMORY: plan ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS plan (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      phase        TEXT,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'planned',
      order_index  INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_plan_status ON plan(status);
    CREATE INDEX IF NOT EXISTS idx_plan_phase  ON plan(phase);

    -- ─── MEMORY: tasks ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      INTEGER REFERENCES plan(id) ON DELETE SET NULL,
      session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'todo',
      tags         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_plan     ON tasks(plan_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_session  ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_tags     ON tasks(tags);

    -- ─── KNOWLEDGE GRAPH: entities ────────────────────────
    CREATE TABLE IF NOT EXISTS entities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      type         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, type)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

    -- ─── KNOWLEDGE GRAPH: relations ───────────────────────
    CREATE TABLE IF NOT EXISTS relations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type  TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_entity_id, to_entity_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);

    -- ─── KNOWLEDGE GRAPH: observations ────────────────────
    CREATE TABLE IF NOT EXISTS observations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content      TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);

    -- ─── SPECS ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS specs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id    INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL,
      format       TEXT NOT NULL DEFAULT 'markdown',
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_specs_entity ON specs(entity_id);
    CREATE INDEX IF NOT EXISTS idx_specs_title  ON specs(title);

    -- ─── CODE GRAPH: symbols ──────────────────────────────
    CREATE TABLE IF NOT EXISTS symbols (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path    TEXT NOT NULL,
      symbol_name  TEXT NOT NULL,
      symbol_type  TEXT NOT NULL,
      start_line   INTEGER,
      end_line     INTEGER,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(file_path, symbol_name, start_line)
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(symbol_name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(symbol_type);

    -- ─── CODE GRAPH: edges ────────────────────────────────
    CREATE TABLE IF NOT EXISTS edges (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      to_symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      edge_type      TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_symbol_id, to_symbol_id, edge_type)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

    -- ─── CODE GRAPH: execution_traces ─────────────────────
    CREATE TABLE IF NOT EXISTS execution_traces (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      description       TEXT,
      symbol_sequence   TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_traces_name ON execution_traces(name);

    -- ─── CODE GRAPH: codemap_annotations ──────────────────
    CREATE TABLE IF NOT EXISTS codemap_annotations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_id    INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
      trace_id     INTEGER REFERENCES execution_traces(id) ON DELETE CASCADE,
      annotation   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (symbol_id IS NOT NULL OR trace_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_symbol ON codemap_annotations(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_annotations_trace  ON codemap_annotations(trace_id);
  `);
}
