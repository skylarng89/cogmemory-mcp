-- CogMemory MCP — Migration 003: Add index_errors table for parse-failure tracking

CREATE TABLE IF NOT EXISTS index_errors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path     TEXT NOT NULL,
  error_type    TEXT NOT NULL,  -- 'parse' | 'resolve' | 'io'
  error_message TEXT NOT NULL,
  occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_path, error_type)
);
CREATE INDEX IF NOT EXISTS idx_index_errors_file ON index_errors(file_path);

PRAGMA user_version = 3;