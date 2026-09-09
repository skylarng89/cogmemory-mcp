-- CogMemory MCP — Migration 009: Project-scoped unique constraints
--
-- Migration 008 added a nullable `project_id` to every memory-bearing table
-- but left the pre-existing UNIQUE/PRIMARY KEY constraints unchanged. The
-- application code (knowledge-graph.ts, memory.ts, code-graph.ts) was already
-- written to target project-scoped conflict columns (e.g.
-- `ON CONFLICT(project_id, name, type)`), which caused:
--
--   "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
--
-- This migration recreates the affected tables so their uniqueness is scoped
-- by project_id, matching the code and enabling true multi-project isolation.
--
-- SQLite cannot alter a table's PRIMARY KEY or UNIQUE constraints in place, so
-- each table is rebuilt via the create-new → copy → drop-old → rename pattern.
-- The migration runner disables foreign_keys for the duration of this
-- migration (see migration-runner.ts), so the DROP TABLE steps do not cascade
-- into dependent tables (relations, observations, specs, edges, etc.).

-- ─── conventions: UNIQUE(category, key) → UNIQUE(project_id, category, key)
CREATE TABLE conventions_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id),
  category     TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT,
  description  TEXT,
  tags         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, category, key)
);
INSERT INTO conventions_new (id, project_id, category, key, value, description, tags, created_at, updated_at)
  SELECT id, project_id, category, key, value, description, tags, created_at, updated_at FROM conventions;
DROP TABLE conventions;
ALTER TABLE conventions_new RENAME TO conventions;
CREATE INDEX IF NOT EXISTS idx_conventions_category ON conventions(category);
CREATE INDEX IF NOT EXISTS idx_conventions_tags      ON conventions(tags);
CREATE INDEX IF NOT EXISTS idx_conventions_project   ON conventions(project_id);

-- Recreate FTS sync triggers dropped with the old table
CREATE TRIGGER IF NOT EXISTS trg_conventions_fts_ai AFTER INSERT ON conventions BEGIN
  INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  VALUES ('conventions', NEW.id, NEW.key || ' ' || COALESCE(NEW.value, '') || ' ' || COALESCE(NEW.description, ''), COALESCE(NEW.tags, ''), NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_conventions_fts_ad AFTER DELETE ON conventions BEGIN
  DELETE FROM recall_docs WHERE source = 'conventions' AND doc_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_conventions_fts_au AFTER UPDATE ON conventions BEGIN
  UPDATE recall_docs SET body = NEW.key || ' ' || COALESCE(NEW.value, '') || ' ' || COALESCE(NEW.description, ''), tags = COALESCE(NEW.tags, ''), created_at = NEW.updated_at
  WHERE source = 'conventions' AND doc_id = OLD.id;
END;

-- ─── context: key PRIMARY KEY → UNIQUE(project_id, key)
-- NOTE: UNIQUE (not PRIMARY KEY) keeps project_id nullable, matching ADR-2's
-- "nullable to keep migration additive" design. A composite PRIMARY KEY would
-- implicitly force project_id NOT NULL and break legacy NULL rows.
CREATE TABLE context_new (
  project_id   INTEGER REFERENCES projects(id),
  key          TEXT NOT NULL,
  value        TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, key)
);
INSERT INTO context_new (project_id, key, value, updated_at)
  SELECT project_id, key, value, updated_at FROM context;
DROP TABLE context;
ALTER TABLE context_new RENAME TO context;
CREATE INDEX IF NOT EXISTS idx_context_project ON context(project_id);

-- ─── entities: UNIQUE(name, type) → UNIQUE(project_id, name, type)
CREATE TABLE entities_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id),
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name, type)
);
INSERT INTO entities_new (id, project_id, name, type, created_at)
  SELECT id, project_id, name, type, created_at FROM entities;
DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;
CREATE INDEX IF NOT EXISTS idx_entities_name    ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type    ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id);

-- Recreate FTS sync triggers dropped with the old table
CREATE TRIGGER IF NOT EXISTS trg_entities_fts_ai AFTER INSERT ON entities BEGIN
  INSERT OR IGNORE INTO kg_docs(source, doc_id, body, created_at)
  VALUES ('entities', NEW.id, NEW.name || ' ' || NEW.type, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_entities_fts_ad AFTER DELETE ON entities BEGIN
  DELETE FROM kg_docs WHERE source = 'entities' AND doc_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_entities_fts_au AFTER UPDATE ON entities BEGIN
  UPDATE kg_docs SET body = NEW.name || ' ' || NEW.type
  WHERE source = 'entities' AND doc_id = OLD.id;
END;

-- ─── relations: UNIQUE(from_entity_id, to_entity_id, relation_type)
--                → UNIQUE(project_id, from_entity_id, to_entity_id, relation_type)
CREATE TABLE relations_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER REFERENCES projects(id),
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, from_entity_id, to_entity_id, relation_type)
);
INSERT INTO relations_new (id, project_id, from_entity_id, to_entity_id, relation_type, created_at)
  SELECT id, project_id, from_entity_id, to_entity_id, relation_type, created_at FROM relations;
DROP TABLE relations;
ALTER TABLE relations_new RENAME TO relations;
CREATE INDEX IF NOT EXISTS idx_relations_from    ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to      ON relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_type    ON relations(relation_type);
CREATE INDEX IF NOT EXISTS idx_relations_project ON relations(project_id);

-- ─── file_index: file_path PRIMARY KEY → UNIQUE(project_id, file_path)
-- NOTE: UNIQUE (not PRIMARY KEY) keeps project_id nullable (see context above).
CREATE TABLE file_index_new (
  project_id  INTEGER REFERENCES projects(id),
  file_path   TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, file_path)
);
INSERT INTO file_index_new (project_id, file_path, mtime_ms, indexed_at)
  SELECT project_id, file_path, mtime_ms, indexed_at FROM file_index;
DROP TABLE file_index;
ALTER TABLE file_index_new RENAME TO file_index;
CREATE INDEX IF NOT EXISTS idx_file_index_project ON file_index(project_id);

-- ─── symbols: UNIQUE(file_path, symbol_name, start_line)
--              → UNIQUE(project_id, file_path, symbol_name, start_line)
CREATE TABLE symbols_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id),
  file_path    TEXT NOT NULL,
  symbol_name  TEXT NOT NULL,
  symbol_type  TEXT NOT NULL,
  start_line   INTEGER,
  end_line     INTEGER,
  is_exported  INTEGER NOT NULL DEFAULT 0,
  body_hash    TEXT,
  token_count  INTEGER DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, file_path, symbol_name, start_line)
);
INSERT INTO symbols_new (id, project_id, file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count, updated_at)
  SELECT id, project_id, file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count, updated_at FROM symbols;
DROP TABLE symbols;
ALTER TABLE symbols_new RENAME TO symbols;
CREATE INDEX IF NOT EXISTS idx_symbols_name      ON symbols(symbol_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file      ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_type      ON symbols(symbol_type);
CREATE INDEX IF NOT EXISTS idx_symbols_exported  ON symbols(is_exported);
CREATE INDEX IF NOT EXISTS idx_symbols_body_hash ON symbols(body_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_project   ON symbols(project_id);

-- ─── edges: UNIQUE(from_symbol_id, to_symbol_id, edge_type)
--            → UNIQUE(project_id, from_symbol_id, to_symbol_id, edge_type)
CREATE TABLE edges_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER REFERENCES projects(id),
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  edge_type      TEXT NOT NULL,
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, from_symbol_id, to_symbol_id, edge_type)
);
INSERT INTO edges_new (id, project_id, from_symbol_id, to_symbol_id, edge_type, metadata, created_at)
  SELECT id, project_id, from_symbol_id, to_symbol_id, edge_type, metadata, created_at FROM edges;
DROP TABLE edges;
ALTER TABLE edges_new RENAME TO edges;
CREATE INDEX IF NOT EXISTS idx_edges_from    ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to      ON edges(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_type    ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);

-- ─── index_errors: UNIQUE(file_path, error_type)
--                   → UNIQUE(project_id, file_path, error_type)
CREATE TABLE index_errors_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id),
  file_path     TEXT NOT NULL,
  error_type    TEXT NOT NULL,
  error_message TEXT NOT NULL,
  occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, file_path, error_type)
);
INSERT INTO index_errors_new (id, project_id, file_path, error_type, error_message, occurred_at)
  SELECT id, project_id, file_path, error_type, error_message, occurred_at FROM index_errors;
DROP TABLE index_errors;
ALTER TABLE index_errors_new RENAME TO index_errors;
CREATE INDEX IF NOT EXISTS idx_index_errors_file    ON index_errors(file_path);
CREATE INDEX IF NOT EXISTS idx_index_errors_project ON index_errors(project_id);

PRAGMA user_version = 9;