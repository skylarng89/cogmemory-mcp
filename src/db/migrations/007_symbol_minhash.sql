-- CogMemory MCP — Migration 007: MinHash signatures table for clone detection

CREATE TABLE IF NOT EXISTS symbol_minhash (
  symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  signature   TEXT NOT NULL,     -- JSON array of integer hashes
  num_hashes  INTEGER NOT NULL,
  shingle_k   INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_symbol_minhash_hashes ON symbol_minhash(num_hashes);

PRAGMA user_version = 7;