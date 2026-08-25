-- CogMemory MCP — Baseline schema migration (v1)
-- This is the authoritative schema extracted from the original migrate.ts.
-- Idempotent: all CREATE TABLE/INDEX/TRIGGER use IF NOT EXISTS.
-- Sets user_version = 1 so the migration runner skips re-apply.

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

-- ─── CODE GRAPH: file_index (mtime tracking for incremental indexing)
CREATE TABLE IF NOT EXISTS file_index (
  file_path  TEXT PRIMARY KEY,
  mtime_ms   INTEGER NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

-- ─── RECALL: FTS5 full-text search index ─────────────
CREATE TABLE IF NOT EXISTS recall_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  doc_id     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  tags       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, doc_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recall_docs_source ON recall_docs(source, doc_id);
CREATE INDEX IF NOT EXISTS idx_recall_docs_created ON recall_docs(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(
  body, tags,
  content='recall_docs',
  content_rowid='id'
);

-- recall_docs → recall_fts sync triggers
CREATE TRIGGER IF NOT EXISTS trg_recall_docs_ai AFTER INSERT ON recall_docs BEGIN
  INSERT INTO recall_fts(rowid, body, tags) VALUES (new.id, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_recall_docs_ad AFTER DELETE ON recall_docs BEGIN
  INSERT INTO recall_fts(recall_fts, rowid, body, tags) VALUES ('delete', old.id, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS trg_recall_docs_au AFTER UPDATE ON recall_docs BEGIN
  INSERT INTO recall_fts(recall_fts, rowid, body, tags) VALUES ('delete', old.id, old.body, old.tags);
  INSERT INTO recall_fts(rowid, body, tags) VALUES (new.id, new.body, new.tags);
END;

-- decisions → recall_docs sync triggers
CREATE TRIGGER IF NOT EXISTS trg_decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  VALUES ('decisions', NEW.id, NEW.title || ' ' || COALESCE(NEW.rationale, ''), COALESCE(NEW.tags, ''), NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_decisions_fts_ad AFTER DELETE ON decisions BEGIN
  DELETE FROM recall_docs WHERE source = 'decisions' AND doc_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_decisions_fts_au AFTER UPDATE ON decisions BEGIN
  UPDATE recall_docs SET body = NEW.title || ' ' || COALESCE(NEW.rationale, ''), tags = COALESCE(NEW.tags, ''), created_at = NEW.created_at
  WHERE source = 'decisions' AND doc_id = OLD.id;
END;

-- conventions → recall_docs sync triggers
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

-- errors → recall_docs sync triggers
CREATE TRIGGER IF NOT EXISTS trg_errors_fts_ai AFTER INSERT ON errors BEGIN
  INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  VALUES ('errors', NEW.id, NEW.error_signature || ' ' || COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.resolution, ''), COALESCE(NEW.tags, ''), NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_errors_fts_ad AFTER DELETE ON errors BEGIN
  DELETE FROM recall_docs WHERE source = 'errors' AND doc_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_errors_fts_au AFTER UPDATE ON errors BEGIN
  UPDATE recall_docs SET body = NEW.error_signature || ' ' || COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.resolution, ''), tags = COALESCE(NEW.tags, ''), created_at = NEW.created_at
  WHERE source = 'errors' AND doc_id = OLD.id;
END;

-- changelog → recall_docs sync triggers
CREATE TRIGGER IF NOT EXISTS trg_changelog_fts_ai AFTER INSERT ON changelog BEGIN
  INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  VALUES ('changelog', NEW.id, NEW.summary || ' ' || COALESCE(NEW.ref, ''), '', NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_changelog_fts_ad AFTER DELETE ON changelog BEGIN
  DELETE FROM recall_docs WHERE source = 'changelog' AND doc_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_changelog_fts_au AFTER UPDATE ON changelog BEGIN
  UPDATE recall_docs SET body = NEW.summary || ' ' || COALESCE(NEW.ref, ''), created_at = NEW.created_at
  WHERE source = 'changelog' AND doc_id = OLD.id;
END;

-- Populate recall_docs from existing data (idempotent via UNIQUE index)
INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  SELECT 'decisions', id, title || ' ' || COALESCE(rationale, ''), COALESCE(tags, ''), created_at FROM decisions;
INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  SELECT 'conventions', id, key || ' ' || COALESCE(value, '') || ' ' || COALESCE(description, ''), COALESCE(tags, ''), created_at FROM conventions;
INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  SELECT 'errors', id, error_signature || ' ' || COALESCE(description, '') || ' ' || COALESCE(resolution, ''), COALESCE(tags, ''), created_at FROM errors;
INSERT OR IGNORE INTO recall_docs(source, doc_id, body, tags, created_at)
  SELECT 'changelog', id, summary || ' ' || COALESCE(ref, ''), '', created_at FROM changelog;

-- Rebuild FTS index to ensure consistency
INSERT INTO recall_fts(recall_fts) VALUES('rebuild');

-- ─── KNOWLEDGE GRAPH: FTS5 index ─────────────────────
CREATE TABLE IF NOT EXISTS kg_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  doc_id     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, doc_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS kg_fts USING fts5(
  body,
  content='kg_docs',
  content_rowid='id'
);

-- kg_docs → kg_fts sync triggers
CREATE TRIGGER IF NOT EXISTS trg_kg_docs_ai AFTER INSERT ON kg_docs BEGIN
  INSERT INTO kg_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS trg_kg_docs_ad AFTER DELETE ON kg_docs BEGIN
  INSERT INTO kg_fts(kg_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS trg_kg_docs_au AFTER UPDATE ON kg_docs BEGIN
  INSERT INTO kg_fts(kg_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO kg_fts(rowid, body) VALUES (new.id, new.body);
END;

-- entities → kg_docs sync triggers
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

-- observations → kg_docs sync triggers
CREATE TRIGGER IF NOT EXISTS trg_observations_fts_ai AFTER INSERT ON observations BEGIN
  INSERT OR IGNORE INTO kg_docs(source, doc_id, body, created_at)
  VALUES ('observations', NEW.id, NEW.content, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS trg_observations_fts_ad AFTER DELETE ON observations BEGIN
  DELETE FROM kg_docs WHERE source = 'observations' AND doc_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_observations_fts_au AFTER UPDATE ON observations BEGIN
  UPDATE kg_docs SET body = NEW.content, created_at = NEW.created_at
  WHERE source = 'observations' AND doc_id = OLD.id;
END;

-- Populate kg_docs from existing data
INSERT OR IGNORE INTO kg_docs(source, doc_id, body, created_at)
  SELECT 'entities', id, name || ' ' || type, created_at FROM entities;
INSERT OR IGNORE INTO kg_docs(source, doc_id, body, created_at)
  SELECT 'observations', id, content, created_at FROM observations;

-- Rebuild KG FTS index
INSERT INTO kg_fts(kg_fts) VALUES('rebuild');

-- ─── Finalize: mark schema as baseline v1 ─────────────
PRAGMA user_version = 1;