-- CogMemory MCP — Migration 006: TF-IDF token table for semantic search

CREATE TABLE IF NOT EXISTS symbol_tokens (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  token     TEXT NOT NULL,
  tf        REAL NOT NULL,
  PRIMARY KEY (symbol_id, token)
);
CREATE INDEX IF NOT EXISTS idx_symbol_tokens_token ON symbol_tokens(token);

PRAGMA user_version = 6;