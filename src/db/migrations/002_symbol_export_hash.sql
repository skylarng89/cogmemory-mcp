-- CogMemory MCP — Migration 002: Add is_exported, body_hash, token_count to symbols
-- Idempotent: ALTER TABLE ADD COLUMN will fail safely if columns exist (better-sqlite3 ignores IF NOT EXISTS on ALTER).
-- We wrap in a transaction from the runner, so a single ADD failure aborts the whole migration.

ALTER TABLE symbols ADD COLUMN is_exported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE symbols ADD COLUMN body_hash TEXT;
ALTER TABLE symbols ADD COLUMN token_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported);
CREATE INDEX IF NOT EXISTS idx_symbols_body_hash ON symbols(body_hash);

PRAGMA user_version = 2;