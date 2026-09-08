-- CogMemory MCP — Migration 008: Project scoping (Project Identity & Continuity)
--
-- Introduces a `projects` table keyed by an opaque UUID slug (stored in
-- .cogmemory/config.json) and back-fills `project_id` on every memory-bearing
-- table. Existing rows are attributed to a single synthesized project row so
-- that no data is lost during migration.
--
-- Back-fill strategy (ADR-4 in the project identity blueprint):
--   - Workspace-scope DBs (single project by construction): one synthesized
--     project row labeled from the workspace root basename, attributed at
--     first boot by resolveProjectIdentity() in src/config.ts.
--   - Global-scope DBs: one 'legacy-unassigned' project row holding all
--     pre-existing rows (mixing was already lossy — cannot be reconstructed).

CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  label          TEXT,
  root_path_hint TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects(last_seen_at);

-- ─── Synthesized project row for pre-existing data ─────
-- The slug is a stable placeholder that resolveProjectIdentity() will
-- recognize (workspace scope) or leave as-is (global scope / legacy bucket).
INSERT OR IGNORE INTO projects (slug, label, root_path_hint)
VALUES (
  'legacy-unassigned',
  'Legacy (pre-migration, unattributed)',
  NULL
);

-- ─── project_id fan-out ────────────────────────────────
-- Nullable columns: NOT NULL is enforced at the application layer for new
-- writes so the migration stays additive and non-breaking.

ALTER TABLE sessions ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE decisions ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE conventions ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE errors ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE context ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE changelog ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE plan ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE entities ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE relations ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE observations ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE specs ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE file_index ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE symbols ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE edges ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE execution_traces ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE codemap_annotations ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE index_errors ADD COLUMN project_id INTEGER REFERENCES projects(id);

-- ─── Back-fill: attribute all pre-existing rows to the legacy project ──
-- The legacy project id is resolved once into a temp value so the literal
-- 'legacy-unassigned' is not duplicated across every UPDATE statement.

CREATE TEMP TABLE IF NOT EXISTS _legacy_project AS
  SELECT id FROM projects WHERE slug = 'legacy-unassigned' LIMIT 1;

UPDATE sessions            SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE decisions           SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE conventions         SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE errors              SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE context             SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE changelog           SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE plan                SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE tasks               SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE entities            SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE relations           SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE observations        SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE specs               SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE file_index          SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE symbols             SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE edges               SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE execution_traces    SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE codemap_annotations SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;
UPDATE index_errors        SET project_id = (SELECT id FROM _legacy_project) WHERE project_id IS NULL;

DROP TABLE IF EXISTS _legacy_project;

-- ─── Indexes supporting the new project_id predicate (NFR2) ──

CREATE INDEX IF NOT EXISTS idx_sessions_project            ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project           ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_conventions_project         ON conventions(project_id);
CREATE INDEX IF NOT EXISTS idx_errors_project              ON errors(project_id);
CREATE INDEX IF NOT EXISTS idx_context_project             ON context(project_id);
CREATE INDEX IF NOT EXISTS idx_changelog_project           ON changelog(project_id);
CREATE INDEX IF NOT EXISTS idx_plan_project                ON plan(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project               ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_entities_project            ON entities(project_id);
CREATE INDEX IF NOT EXISTS idx_relations_project           ON relations(project_id);
CREATE INDEX IF NOT EXISTS idx_observations_project        ON observations(project_id);
CREATE INDEX IF NOT EXISTS idx_specs_project               ON specs(project_id);
CREATE INDEX IF NOT EXISTS idx_file_index_project          ON file_index(project_id);
CREATE INDEX IF NOT EXISTS idx_symbols_project             ON symbols(project_id);
CREATE INDEX IF NOT EXISTS idx_edges_project               ON edges(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_traces_project    ON execution_traces(project_id);
CREATE INDEX IF NOT EXISTS idx_codemap_annotations_project ON codemap_annotations(project_id);
CREATE INDEX IF NOT EXISTS idx_index_errors_project        ON index_errors(project_id);

PRAGMA user_version = 8;
