-- CogMemory MCP — Migration 004: Symbol embeddings stub (Phase 2)
-- Created now to reserve the schema slot. Unused in v1.1.0.

CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id  INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  embedding  BLOB,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol_id, model)
);

PRAGMA user_version = 4;