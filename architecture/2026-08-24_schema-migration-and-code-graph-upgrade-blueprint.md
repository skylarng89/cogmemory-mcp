# This blueprint's contents have been

- Integrated into the main architecture document (`COGMEMORY_ARCHITECTURE_PLAN.md`)
- Implemented in the codebase

Refer to the unified architecture plan for current system details.

---

## Executive Summary (TL;DR)

CogMemory is at v1.0.0 on npm but ships **no real migration system** — `migrate()` is an idempotent `CREATE TABLE IF NOT EXISTS` block that cannot evolve existing tables. This blueprint delivers:

1. **A versioned migration runner** (`PRAGMA user_version` + numbered migration files + pre-migration backup) that transparently upgrades all existing `.cogmemory/memory.db` files on next launch — zero data loss, zero user action.
2. **An update-aware distribution model**: fix the hardcoded `0.1.0` version constant, add a `cogmemory_status` introspection tool + `check_for_updates` tool that pings the npm registry, and document `npx` as the always-latest install method.
3. **Nine new tools** spanning semantic search (TF-IDF Phase 1 → sqlite-vec Phase 2), dead-code detection, clone detection (`SIMILAR_TO` edges), semantic relation discovery (`SEMANTICALLY_RELATED` edges), multi-hop Cypher-style graph queries, uncommitted-change impact analysis, direct snippet fetch, index-coverage audit, and runtime introspection.
4. **A README overhaul** with `npx`/`npm -g`/`pnpm dlx` install methods and copy-paste MCP configs for VS Code, Cursor, Claude Desktop, Claude Code, Cline, Windsurf, OpenCode, and Zed.

The work is decomposed into **5 Sprints / 48 tasks**. Schema migrations and the version-constant fix are prioritized first (Sprint 1) because every subsequent tool depends on a migrable schema and correct version reporting. All 5 design open questions have been resolved by the user — see "Resolved Design Decisions" below.

---

## 1. Software Requirements Specification (SRS)

### 1.1 Functional Requirements

| ID    | Requirement                                                                                                                                                 | Priority |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-01 | Existing user DBs (`user_version = 0`) MUST be transparently migrated to the latest schema on next server launch with zero data loss                        | P0       |
| FR-02 | A pre-migration backup file MUST be created before any schema-altering migration runs                                                                       | P0       |
| FR-03 | The server MUST report its true package version in the MCP handshake (not a hardcoded constant)                                                             | P0       |
| FR-04 | The model MUST be able to query its own runtime configuration (db path, workspace root, schema version, package version) via a tool                         | P1       |
| FR-05 | Semantic code search MUST return meaningfully related symbols for a natural-language query, with graceful degradation when no vector extension is available | P1       |
| FR-06 | Dead-code detection MUST identify symbols with zero inbound structural edges, excluding configurable entry-point patterns and exported symbols              | P1       |
| FR-07 | Clone detection MUST compute pairwise similarity between symbol bodies and persist `SIMILAR_TO` edges above a configurable threshold                        | P1       |
| FR-08 | Semantic-relation discovery MUST compute and persist `SEMANTICALLY_RELATED` edges between symbols with shared structural context                            | P2       |
| FR-09 | Multi-hop graph queries MUST support arbitrary depth, edge-type filters, direction, and path return via recursive CTEs                                      | P1       |
| FR-10 | Impact analysis MUST detect uncommitted changes via `git diff`, map them to indexed symbols, and compute the reverse transitive caller closure              | P1       |
| FR-11 | Snippet fetch MUST return the source-code lines for a symbol by ID or name, with optional context padding                                                   | P1       |
| FR-12 | Index coverage MUST report indexed vs. unindexed vs. stale files and per-language breakdowns                                                                | P1       |
| FR-13 | README MUST document at least 6 IDE/client configuration methods with copy-paste JSON                                                                       | P0       |
| FR-14 | `check_for_updates` MUST query the npm registry and compare against the running version                                                                     | P2       |

### 1.2 Non-Functional Requirements (SLAs)

| ID     | Metric                                                        | Target                                                                    |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| NFR-01 | Migration runtime for a 10 MB DB (existing baseline → latest) | < 500 ms (excluding FTS rebuild)                                          |
| NFR-02 | Server cold-start time (post-migration)                       | < 100 ms to MCP `initialize` response                                     |
| NFR-03 | `semantic_code_search` over 10k symbols (TF-IDF backend)      | < 50 ms p95                                                               |
| NFR-04 | `find_dead_code` over 10k symbols + 50k edges                 | < 100 ms p95                                                              |
| NFR-05 | `query_graph` 5-hop traversal over 10k symbols                | < 200 ms p95                                                              |
| FR-06  | `analyze_impact` (git diff + reverse closure, 5-hop)          | < 300 ms p95                                                              |
| NFR-07 | FTS rebuild (currently runs on EVERY open)                    | Moved to migration-only path — eliminated from hot start                  |
| NFR-08 | Zero data loss on migration failure                           | Migration runs in a single transaction; backup exists for rollback        |
| NFR-09 | Native module compatibility                                   | `better-sqlite3 ^13`, `tree-sitter ^0.25` — no new native deps in Phase 1 |
| NFR-10 | Backward compatibility                                        | All 30 existing tools remain API-stable; new tools are purely additive    |

---

## 2. Architecture Decision Records (ADRs)

### ADR-01: Versioned Migration System via `PRAGMA user_version`

**Context:** The current `migrate()` function re-runs all `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` backfill + `INSERT INTO recall_fts(recall_fts) VALUES('rebuild')` on **every connection open**. This is (a) incapable of adding columns to existing tables, (b) a performance smell on large DBs, and (c) has no concept of schema evolution. Three copies of the schema (`root/schema.sql`, `src/db/schema.sql`, `src/db/migrate.ts` inline) drift independently.

**Selected Approach:** A numbered-file migration runner using SQLite's built-in `PRAGMA user_version`:

```plain
src/db/
├── connection.ts          # opens DB, calls runMigrations(db)
├── migrate.ts             # DEPRECATED — replaced by runner (kept for one release as fallback)
├── migration-runner.ts    # NEW: reads user_version, applies pending migrations in-order
└── migrations/
    ├── 001_baseline.sql            # The current full schema (CREATE IF NOT EXISTS) — sets user_version=1
    ├── 002_symbol_export_hash.sql   # ALTER TABLE symbols ADD COLUMN is_exported, body_hash, token_count
    ├── 003_index_errors.sql         # CREATE TABLE index_errors for parse-failure tracking
    ├── 004_symbol_embeddings.sql    # CREATE TABLE symbol_embeddings (stub — Phase 2, unused in v1.1.0)
    ├── 005_edge_metadata.sql        # ALTER TABLE edges ADD COLUMN metadata (similarity scores)
    ├── 006_symbol_tokens.sql        # CREATE TABLE symbol_tokens (TF-IDF for semantic search)
    ├── 007_symbol_minhash.sql       # CREATE TABLE symbol_minhash (MinHash signatures for clone detection)
    └── ... future migrations
```

**Runner logic:**

1. `PRAGMA user_version` → read current version `V`.
2. If `V = 0`: this is a pre-migration-system DB. Create backup `memory.db.backup-pre-migrate-{timestamp}`. Run `001_baseline.sql` (idempotent CREATE IF NOT EXISTS — lossless on existing DBs). Set `user_version = 1`.
3. For each migration file `N > V`: create backup (only for `V=0` → first migration; subsequent migrations within the same run are transactional), run in a `BEGIN…COMMIT` transaction, `PRAGMA user_version = N` on success.
4. FTS rebuild (`INSERT INTO recall_fts(recall_fts) VALUES('rebuild')`) moves **out** of the hot path — it only runs inside migration `001_baseline.sql` and any future migration that alters FTS content. This eliminates the per-open rebuild.
5. On failure: `ROLLBACK`, log error, exit non-zero. The backup file is the user's recovery path.

**Migration file contract:** Each `.sql` file MUST be idempotent within itself (use `IF NOT EXISTS`) and MUST end with `PRAGMA user_version = N;`. The runner wraps each file in a transaction. No JS logic in migrations — pure SQL for auditability.

**Consequences:**

- ✅ Existing users: transparent upgrade on next launch. `user_version=0` → baseline migration → latest.
- ✅ Future-proof: any schema change is a new numbered `.sql` file.
- ✅ Performance: FTS rebuild eliminated from every-open hot path.
- ✅ Auditability: migrations are plain SQL files, reviewable in PRs.
- ⚠️ The `migrate.ts` inline schema becomes `001_baseline.sql`. The two `schema.sql` reference copies are deleted (single source of truth = `migrations/`).
- ⚠️ First-run backup creates a file ~equal to DB size. Documented in README.

**Version Metrics (via Context7):** SQLite `PRAGMA user_version` is a stable core pragma available in all SQLite ≥ 3.1 (2004). `better-sqlite3 ^13` bundles SQLite ≥ 3.45. No compatibility risk.

---

### ADR-02: Version Constant Sourced from `package.json` at Build Time

**Context:** `src/index.ts` hardcodes `VERSION = "0.1.0"` while `package.json` and `server.json` say `1.0.0`. The MCP handshake reports `0.1.0` to clients. This makes version-based update checks unreliable.

**Selected Approach:** Generate `src/version.ts` at build time from `package.json`:

```typescript
// src/version.ts — AUTO-GENERATED by scripts/generate-version.ts
export const VERSION = "1.0.0";
```

- Add `prebuild` script: `node scripts/generate-version.ts` (reads `package.json`, writes `src/version.ts`).
- `index.ts` imports `{ VERSION } from "./version.js"`.
- `prepublishOnly` already runs `build` → `prebuild` fires first → `version.ts` is fresh in every published `dist/`.
- `.gitignore` `src/version.ts` (generated artifact, not source).

**Consequences:**

- ✅ Single source of truth: `package.json` version flows into both the MCP handshake and the `cogmemory_status` tool.
- ✅ The publish workflow's `npm version` patch (which edits `package.json` at publish time in CI) automatically propagates.
- ⚠️ Devs running `pnpm run dev` (tsx) without `prebuild` get a stale/missing `version.ts`. Fix: `dev` script calls `prebuild && tsx src/index.ts`, or commit a checked-in `version.ts` and regenerate only on publish. **Decision: commit a baseline `version.ts` and regenerate on `prepublishOnly`.** Simpler for dev.

---

### ADR-03: Semantic Search — TF-IDF Phase 1, sqlite-vec Phase 2

**Context:** `semantic_code_search` requires meaning-based retrieval. True semantic search needs vector embeddings. Options evaluated:

| Option                                | Pros                                            | Cons                                                                                                   | Decision                                   |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| (a) sqlite-vec loadable extension     | True vector search, cosine similarity           | Requires loadable extension (platform-dependent; `better-sqlite3` may not load `.so/.dylib` uniformly) | Phase 2 — optional, with graceful fallback |
| (b) transformers.js / onnx embeddings | True semantic embeddings in-process             | ~100MB+ model download, slow CPU inference, heavy dep                                                  | Rejected for Phase 1                       |
| (c) Pure-SQL TF-IDF + cosine          | No deps, fast, "semantic-ish" via token overlap | Not true semantics (no synonym detection)                                                              | **Phase 1 — ship now**                     |
| (d) FTS5 BM25 only                    | Already have FTS5 infra                         | Keyword, not semantic; no symbol-body indexing                                                         | Rejected as sole backend                   |

**Selected Approach (Phase 1 — TF-IDF):**

- New table: `symbol_tokens` (a tokenization of each symbol's body — name + normalized source lines).
- Tokenization: lowercase, split on non-alphanumeric, strip stopwords, strip language keywords (`function`, `const`, `return`, `def`, `class`, etc.).
- `tf` = term frequency in that symbol's body. `idf` = `log(N / df)` computed on-the-fly (N = total symbols, df = symbols containing token).
- Query: tokenize the natural-language query → compute cosine similarity against each symbol's TF-IDF vector → return top-K.
- Implementation: a recursive CTE or a precomputed `symbol_tfidf` materialized table refreshed during `index_codebase`.

**Phase 2 (future):** If `sqlite-vec` loads successfully (`db.loadExtension('vec0')` in a try/catch), compute embeddings for each symbol body (via a pluggable embedder interface — initially a hash-based pseudo-embedding, later a real model) and store in `symbol_embeddings(symbol_id, embedding BLOB, model, dim)`. `semantic_code_search` checks for vec availability and falls back to TF-IDF.

**Consequences:**

- ✅ No new native dependency in Phase 1 — preserves the `engines.node >= 22` + existing native-module set.
- ✅ Graceful degradation: works everywhere `better-sqlite3` works.
- ✅ Incremental: TF-IDF is computed during `index_codebase`, so query time is pure lookup.
- ⚠️ Tokenization quality limits "semantic" depth. Acceptable for v1 — documented as "lexical-semantic hybrid."

---

### ADR-04: New Edge Types as Values, Not Schema Changes

**Context:** The `edges.edge_type` column is `TEXT NOT NULL` with no CHECK constraint. New types `SIMILAR_TO` and `SEMANTICALLY_RELATED` need no schema migration — they're new string values.

**Selected Approach:** Define a TypeScript enum/constants module `src/indexing/edge-types.ts`:

```typescript
export const EDGE_TYPES = {
  CALLS: "calls",
  IMPORTS: "imports",
  EXTENDS: "extends",
  IMPLEMENTS: "implements",
  SIMILAR_TO: "similarto", // clone detection
  SEMANTICALLY_RELATED: "semrelated", // semantic relation discovery
} as const;
```

- Analyzers emit the existing 4 types. The new 2 types are emitted by dedicated tools (`find_duplicates`, `find_related`) that insert edges programmatically.
- `query_code_graph` and `query_graph` treat all 6 types uniformly (no special-casing needed beyond the existing `imports` split).
- The `UNIQUE(from_symbol_id, to_symbol_id, edge_type)` constraint naturally dedupes.

**Consequences:**

- ✅ Zero schema migration for new edge types.
- ✅ `SIMILAR_TO` edges carry a `similarity_score` — but `edges` has no score column. **Decision:** store the score in `codemap_annotations` (existing table, `annotation` TEXT field with JSON `{type:"similarity", score:0.87}`). Alternatively, add a nullable `metadata` TEXT column to `edges` via migration `005_edge_metadata.sql`. **Decision: migration `005` — cleaner than overloading annotations.**

---

### ADR-05: Update Distribution via npm + Introspection Tools

**Context:** MCP servers are stdio processes launched by IDEs. There is no push-update channel in the MCP protocol. The handshake reports `server.version` but clients don't auto-update.

**Selected Approach:** A three-layer update strategy:

1. **`npx cogmemory-mcp` as the documented default** — `npx` checks the registry for the latest version within its cache TTL (default: updated daily, or `--prefer-online`). This is the primary mechanism. IDE configs should use `npx cogmemory-mcp` (not a path to a local clone).

2. **`cogmemory_status` tool** — surfaces `package_version`, `schema_version` (user_version), `db_path`, `workspace_root`, `scope`, `node_version`, `total_symbols`, `total_edges`, `index_coverage_pct`. The model can call this to understand its runtime context and proactively suggest updates.

3. **`check_for_updates` tool** — fetches `https://registry.npmjs.org/cogmemory-mcp/latest` (HTTP GET, 5s timeout), compares `latest.version` against running `VERSION`. Returns `{current, latest, update_available, instructions}`. Result cached for 24h in the `context` table (key `npm_latest_version_cache`). Non-blocking — the tool never fails the server if the registry is unreachable.

**Rejected alternatives:**

- ❌ `postinstall` hook that notifies — intrusive, runs on every install including CI.
- ❌ Embedded auto-updater that rewrites the binary — security risk, breaks reproducibility.
- ❌ MCP protocol extension for update notifications — not standardized, would break clients.

**Consequences:**

- ✅ Works with every IDE that supports `npx`-launched MCP servers.
- ✅ The model can self-discover staleness and inform the user.
- ✅ No security surface — `check_for_updates` is read-only HTTPS to the public registry.
- ✅ **Opt-out (confirmed):** enabled by default (same trust model as `npm` itself), but users can disable via `COGMEMORY_DISABLE_UPDATE_CHECK=1` env var or `.cogmemory/config.json: { "disable_update_check": true }`. README discloses the telemetry. The tool checks the flag before any network call.
- ⚠️ Users with `npm i -g cogmemory-mcp` must run `npm update -g cogmemory-mcp` manually. Documented in README.

---

## 3. System Modeling & Data Boundaries (C4 Context Model)

### 3.1 Updated Schema (Migration Targets)

**Migration `002_symbol_export_hash.sql`:**

```sql
ALTER TABLE symbols ADD COLUMN is_exported INTEGER NOT NULL DEFAULT 0;
ALTER TABLE symbols ADD COLUMN body_hash TEXT;
ALTER TABLE symbols ADD COLUMN token_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported);
CREATE INDEX IF NOT EXISTS idx_symbols_body_hash ON symbols(body_hash);
PRAGMA user_version = 2;
```

**Migration `003_index_errors.sql`:**

```sql
CREATE TABLE IF NOT EXISTS index_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path   TEXT NOT NULL,
  error_type  TEXT NOT NULL,   -- 'parse' | 'resolve' | 'io'
  error_message TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_path, error_type)
);
CREATE INDEX IF NOT EXISTS idx_index_errors_file ON index_errors(file_path);
PRAGMA user_version = 3;
```

**Migration `004_symbol_embeddings.sql` (Phase 2 — stub for now):**
**Migration `004_symbol_embeddings.sql`** (stub — included now per user decision #5, unused in v1.1.0):

```sql
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  embedding BLOB,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol_id, model)
);
PRAGMA user_version = 4;
```

**Migration `005_edge_metadata.sql`:**

```sql
ALTER TABLE edges ADD COLUMN metadata TEXT;  -- JSON: {score: 0.87, algorithm: "minhash"}
PRAGMA user_version = 5;
```

**Migration `006_symbol_tokens.sql`** (TF-IDF for semantic search):

```sql
CREATE TABLE IF NOT EXISTS symbol_tokens (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  token     TEXT NOT NULL,
  tf        REAL NOT NULL,
  PRIMARY KEY (symbol_id, token)
);
CREATE INDEX IF NOT EXISTS idx_symbol_tokens_token ON symbol_tokens(token);
PRAGMA user_version = 6;
```

**Migration `007_symbol_minhash.sql`** (MinHash signatures for clone detection — per user decision #2):

```sql
CREATE TABLE IF NOT EXISTS symbol_minhash (
  symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  signature   TEXT NOT NULL,        -- JSON array of integer hashes
  num_hashes  INTEGER NOT NULL,
  shingle_k   INTEGER NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_symbol_minhash_hashes ON symbol_minhash(num_hashes);
PRAGMA user_version = 7;
```

### 3.2 Updated Tool Inventory (30 existing + 9 new = 39 tools)

| #    | Tool                         | Subsystem     | New? | File                           |
| ---- | ---------------------------- | ------------- | ---- | ------------------------------ |
| 1–30 | _(existing tools unchanged)_ | —             | No   | existing files                 |
| 31   | `cogmemory_status`           | introspection | ✅   | `src/tools/introspection.ts`   |
| 32   | `check_for_updates`          | introspection | ✅   | `src/tools/introspection.ts`   |
| 33   | `semantic_code_search`       | code-graph    | ✅   | `src/tools/semantic-search.ts` |
| 34   | `find_dead_code`             | code-graph    | ✅   | `src/tools/code-analysis.ts`   |
| 35   | `find_duplicates`            | code-graph    | ✅   | `src/tools/code-analysis.ts`   |
| 36   | `find_related`               | code-graph    | ✅   | `src/tools/code-analysis.ts`   |
| 37   | `query_graph`                | code-graph    | ✅   | `src/tools/code-analysis.ts`   |
| 38   | `analyze_impact`             | code-graph    | ✅   | `src/tools/code-analysis.ts`   |
| 39   | `get_code_snippet`           | code-graph    | ✅   | `src/tools/code-analysis.ts`   |
| 40   | `check_index_coverage`       | code-graph    | ✅   | `src/tools/code-analysis.ts`   |

### 3.3 Data Flow — Migration on Launch

```plain
IDE launches `npx cogmemory-mcp`
  │
  ▼
index.ts main()
  │
  ├─ resolveWorkspaceRoot() → workspaceRoot
  ├─ resolveConfig(workspaceRoot) → {scope, dbPath}
  │
  ▼
openDatabase(dbPath)
  │
  ├─ new Database(dbPath) [WAL, foreign_keys=ON]
  │
  ▼
runMigrations(db)
  │
  ├─ PRAGMA user_version → V
  │
  ├─ if V == 0:
  │    ├─ copy dbPath → dbPath.backup-pre-migrate-{ISO}
  │    ├─ exec 001_baseline.sql (CREATE IF NOT EXISTS — lossless)
  │    └─ V = 1
  │
  ├─ for N in (V+1 .. max_migration):
  │    ├─ BEGIN
  │    ├─ exec migrations/{N:03d}_*.sql
  │    ├─ COMMIT (on success)
  │    └─ ROLLBACK + exit(1) (on failure)
  │
  ▼
registerTools(server, db, workspaceRoot)
  │
  ▼
server.connect(StdioServerTransport)
```

### 3.4 Data Flow — Semantic Search (TF-IDF Phase 1)

```plain
index_codebase (enhanced)
  │
  ├─ analyzeFiles() → symbols + edges (existing)
  │
  ├─ NEW: for each symbol:
  │    ├─ extract body (file lines start_line..end_line)
  │    ├─ tokenize (lowercase, strip keywords/stopwords)
  │    ├─ compute tf per token
  │    └─ DELETE + INSERT INTO symbol_tokens
  │
  └─ existing edge insertion

semantic_code_search(query)
  │
  ├─ tokenize(query) → query_tokens[]
  ├─ SELECT token, COUNT(DISTINCT symbol_id) as df FROM symbol_tokens
  │    WHERE token IN query_tokens GROUP BY token
  ├─ idf[token] = log(N_total / df)
  ├─ SELECT symbol_id, SUM(tf * ?idf) as score
  │    FROM symbol_tokens WHERE token IN query_tokens
  │    GROUP BY symbol_id ORDER BY score DESC LIMIT K
  └─ join symbols for names/paths → return
```

### 3.5 API Contracts — New Tool Schemas

```typescript
// cogmemory_status
{ /* no required params */ verbose?: boolean }
→ { package_version, schema_version, db_path, workspace_root, scope,
    node_version, counts: {symbols, edges, entities, decisions, ...},
    index_coverage_pct, last_indexed_at }

// check_for_updates
{ /* no params */ }
→ { current_version, latest_version, update_available, instructions? }

// semantic_code_search
{ query: string, limit?: number (default 20), threshold?: number (default 0.0),
  file_pattern?: string, symbol_type?: string }
→ { results: [{symbol_id, symbol_name, file_path, symbol_type, score, snippet}],
   backend: "tfidf" | "vec", total_matches }

// find_dead_code
{ entry_point_patterns?: string[] (default: ["main","index","cli","server","handler","setup","run"]),
  exclude_tests?: boolean (default true), exclude_exported?: boolean (default true),
  file_pattern?: string, limit?: number }
→ { dead_symbols: [{symbol_id, name, file_path, type, is_exported}], total, excluded_count }

// find_duplicates
{ threshold?: number (default 0.7), min_tokens?: number (default 10),
  recompute?: boolean (default false — uses persisted symbol_minhash table),
  file_pattern?: string }
→ { duplicates: [{symbol_a, symbol_b, file_a, file_b, similarity, algorithm, edge_id}],
   edges_created, total_pairs_scanned, signatures_source: "table"|"recomputed" }

// find_related
{ symbol_name?: string, symbol_id?: number, threshold?: number (default 0.3),
  limit?: number (default 10), edge_types?: string[] }
→ { related: [{symbol_id, name, file_path, score, reasons: string[], edge_id}],
   edges_created }

// query_graph
{ start_symbol: string, edge_types?: string[] (default: all),
  direction?: "inbound"|"outbound"|"both" (default "both"),
  max_depth?: number (default 5, max 20), limit?: number (default 100),
  filter?: { symbol_type?: string, file_pattern?: string } }
→ { nodes: [{symbol_id, name, file_path, type, depth}],
   paths: [[symbol_id, ...]], total_reachable }

// analyze_impact
{ changed_files?: string[] (auto-detect via git diff if omitted),
  max_depth?: number (default 5), edge_types?: string[] (default: ["calls","imports"]),
  include_tests?: boolean (default false) }
→ { changed_files, changed_symbols: [{id,name,file}],
   impacted_symbols: [{symbol_id, name, file, depth, path: [...]}],
   summary: {total_impacted, max_depth_reached} }

// get_code_snippet
{ symbol_id?: number, symbol_name?: string, file_path?: string,
  context_lines?: number (default 0, max 50) }
→ { file_path, start_line, end_line, content, language, symbol_name }

// check_index_coverage
{ root_dir?: string, extensions?: string[] }
→ { total_files, indexed_files, unindexed_files: [{path, reason}],
   stale_files: [{path, indexed_mtime, current_mtime}],
   coverage_pct, by_language: {ts: {total, indexed}, py: {...}, ...},
   parse_errors: [{path, error}] }
```

---

## 4. Infrastructure, Observability & Resilience Blueprint

### 4.1 Migration Safety

| Concern                                            | Mitigation                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data loss on migration failure                     | Pre-migration backup (`memory.db.backup-pre-migrate-{ISO}`) for `user_version=0` DBs. Each migration in a `BEGIN…COMMIT` transaction. On failure: `ROLLBACK`, log to stderr, exit(1).  |
| FTS index corruption                               | FTS rebuild (`INSERT INTO recall_fts(recall_fts) VALUES('rebuild')`) runs only inside `001_baseline.sql` and future FTS-affecting migrations — not on every open.                      |
| Partial migration (power loss mid-run)             | SQLite WAL + single-transaction-per-migration. `user_version` only updates on `COMMIT`. A crashed migration leaves `user_version` at the prior value → re-runs cleanly on next launch. |
| Backup disk space                                  | Only created for `user_version=0` → first-ever migration. Subsequent migrations are in-transaction. Document `COGMEMORY_SKIP_BACKUP=1` env override for CI/disk-constrained envs.      |
| Schema drift between `migrate.ts` and `schema.sql` | Delete both reference copies. `migrations/001_baseline.sql` is the single source of truth.                                                                                             |

### 4.2 Observability

| Signal                          | Source                                | Consumer                                       |
| ------------------------------- | ------------------------------------- | ---------------------------------------------- |
| Server version in MCP handshake | `McpServer({version: VERSION})`       | IDE / MCP client (`client.getServerVersion()`) |
| Schema version                  | `PRAGMA user_version`                 | `cogmemory_status` tool                        |
| Migration events                | stderr log on launch                  | IDE output panel / MCP client logs             |
| Index parse errors              | `index_errors` table                  | `check_index_coverage` tool                    |
| Update availability             | `context` table (cached 24h)          | `check_for_updates` tool                       |
| Index freshness                 | `file_index.indexed_at` vs file mtime | `check_index_coverage` tool                    |

### 4.3 Resilience & Failover

| Scenario                                              | Behavior                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration fails                                       | `ROLLBACK`, stderr error, `exit(1)`. IDE sees server crash. Backup file is the recovery path. README documents `cp memory.db.backup-* memory.db` to retry. |
| `check_for_updates` registry unreachable              | Returns `{current, latest: null, update_available: null, error: "registry_unreachable"}`. Never fails the server.                                          |
| `sqlite-vec` extension missing (Phase 2)              | `semantic_code_search` falls back to TF-IDF. `backend` field in response indicates which engine was used.                                                  |
| `git diff` fails in `analyze_impact` (not a git repo) | Returns error: `"workspace is not a git repository; pass changed_files manually"`.                                                                         |
| Large workspace (100k+ files)                         | Walker respects `.gitignore` + ignore patterns. `check_index_coverage` paginates `unindexed_files` (limit 1000).                                           |
| Native module build failure on install                | Documented in README (node-gyp requirements: Python 3, C++ compiler). `engines.node >= 22` enforced.                                                       |

### 4.4 Performance Optimizations

| Optimization                                       | Impact                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| FTS rebuild removed from every-open path           | Cold start: ~200ms → ~50ms for large DBs                                            |
| `symbol_tokens` indexed on `token`                 | TF-IDF query: O(K) where K = query token count                                      |
| Recursive CTE for `query_graph`                    | Single SQL round-trip for multi-hop (vs N+1 in app code)                            |
| `is_exported` column + index                       | `find_dead_code` avoids full-table scan + keyword heuristics                        |
| `body_hash` column                                 | `find_duplicates` short-circuits identical-hash pairs (exact clones) before MinHash |
| `check_for_updates` result cached 24h in `context` | Avoids registry hit on every model call                                             |

---

## 5. Implementation Task List (Sprint Breakdown)

Legend: `- [ ] Not Started` | `- [/] In Progress` | `- [x] Completed` | `- [-] Blocked/Cancelled`

### Sprint 1: Migration Foundation & Version Hygiene (P0 — Blocks Everything) ✅

- [x] Task 1.1: Create `src/db/migrations/001_baseline.sql` — extract the full inline schema from `migrate.ts` into a standalone `.sql` file. End with `PRAGMA user_version = 1;`. Include the FTS rebuild statements (they run only once now, not on every open).
- [x] Task 1.2: Implement `src/db/migration-runner.ts` — reads `PRAGMA user_version`, discovers migration files via `fs.readdirSync`, runs pending migrations in-order within `BEGIN…COMMIT` transactions, creates pre-migration backup for `user_version=0` DBs, sets `user_version` on each. Export `runMigrations(db, dbPath)`.
- [x] Task 1.3: Update `src/db/connection.ts` — replace `migrate(db)` call with `runMigrations(db, dbPath)`. Accept `dbPath` param for backup logic. Remove the per-open FTS rebuild (it's now in `001_baseline.sql`).
- [x] Task 1.4: Delete `src/db/schema.sql` and root `schema.sql` — `migrations/` is the single source of truth. Update `.gitignore` if `schema.sql` was tracked.
- [x] Task 1.5: Implement `scripts/generate-version.ts` — reads `package.json`, writes `src/version.ts` with `export const VERSION = "<version>";`. Add `prebuild` script to `package.json`.
- [x] Task 1.6: Update `src/index.ts` — import `VERSION` from `./version.js` instead of hardcoding. Remove the `const VERSION = "0.1.0"` line.
- [x] Task 1.7: Add `COGMEMORY_SKIP_BACKUP=1` env override to the migration runner (for CI / disk-constrained envs). Document in README.
- [x] Task 1.8: Write smoke-test coverage for the migration runner — test `user_version=0 → latest` on a DB with pre-existing data (insert rows, migrate, verify rows survive + new columns exist). Test idempotency (run twice, no-op). Test backup file creation.
- [x] Task 1.9: Bump `package.json` version to `1.1.0` (minor — new features, backward-compatible migration system). _(Surpassed — currently at v1.6.4.)_

### Sprint 2: Introspection & Update-Check Tools (P1 — Foundational for Model Self-Awareness) ✅

- [x] Task 2.1: Implement `cogmemory_status` tool in `src/tools/introspection.ts` — returns `{package_version, schema_version, db_path, workspace_root, scope, node_version, counts, index_coverage_pct, last_indexed_at}`. Counts via `SELECT COUNT(*)` per table. Schema version via `PRAGMA user_version`.
- [x] Task 2.2: Implement `check_for_updates` tool — **opt-out (enabled by default)**. Check `process.env.COGMEMORY_DISABLE_UPDATE_CHECK === "1"` OR `.cogmemory/config.json: { "disable_update_check": true }` before making any request. If disabled, return `{current, latest: null, update_available: null, disabled: true}` without network call. Otherwise: `fetch("https://registry.npmjs.org/cogmemory-mcp/latest")` with 5s timeout, parse `version`, compare to `VERSION`, cache result in `context` table (key `npm_latest_version_cache`, value JSON with timestamp + version, 24h TTL). Return `{current, latest, update_available, instructions}`. Graceful failure on network error. README (Task 5.5) must document the telemetry and both opt-out mechanisms.
- [x] Task 2.3: Register both tools in `index.ts` via `registerIntrospectionTools(server, db, workspaceRoot)`.
- [x] Task 2.4: Add introspection tools to the `TABLES`/subsystem registry in `list-delete.ts` if they introduce new tables (they don't — they use existing `context` for cache). No registry change needed.
- [x] Task 2.5: Update the smoke test to call both tools and verify response shape.

### Sprint 3: Schema Migrations for New Tool Data (P1 — Depends on Sprint 1) ✅

- [x] Task 3.1: Write `002_symbol_export_hash.sql` — `ALTER TABLE symbols ADD COLUMN is_exported INTEGER DEFAULT 0; ADD COLUMN body_hash TEXT; ADD COLUMN token_count INTEGER DEFAULT 0;` + indexes. `PRAGMA user_version = 2;`.
- [x] Task 3.2: Write `003_index_errors.sql` — `CREATE TABLE index_errors (id, file_path, error_type, error_message, occurred_at, UNIQUE(file_path, error_type))` + index. `PRAGMA user_version = 3;`.
- [x] Task 3.3: Write `004_symbol_embeddings.sql` — `CREATE TABLE symbol_embeddings (symbol_id, embedding BLOB, model, dim, created_at, PRIMARY KEY(symbol_id, model))`. Stub table — empty, unused in v1.1.0. Signals Phase 2 intent. `PRAGMA user_version = 4;`.
- [x] Task 3.4: Write `005_edge_metadata.sql` — `ALTER TABLE edges ADD COLUMN metadata TEXT;` (for similarity scores). `PRAGMA user_version = 5;`.
- [x] Task 3.4b: Write `006_symbol_tokens.sql` — `CREATE TABLE symbol_tokens (symbol_id, token, tf, PRIMARY KEY(symbol_id, token))` + index on `token`. `PRAGMA user_version = 6;`.
- [x] Task 3.4c: Write `007_symbol_minhash.sql` — `CREATE TABLE symbol_minhash (symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE, signature TEXT NOT NULL, num_hashes INTEGER NOT NULL, shingle_k INTEGER NOT NULL, computed_at TEXT NOT NULL DEFAULT (datetime('now')))`. Stores MinHash signature as JSON array. `PRAGMA user_version = 7;`.
- [x] Task 3.5: Update `src/indexing/ts-analyzer.ts` — track `is_exported` (check for `export` keyword / `exported` modifier in ts-morph). Populate `body_hash` (SHA-256 of normalized symbol body lines). Populate `token_count`.
- [x] Task 3.6: Update `src/indexing/py-analyzer.ts` — track `is_exported` using the **dual rule**: (a) if the file contains an `__all__` assignment, a symbol is exported iff its name appears in the `__all__` list; (b) otherwise, a top-level def/class is exported iff its name does not start with `_`. Populate `body_hash`, `token_count`.
- [x] Task 3.7: Update `src/tools/code-graph.ts` `index_codebase` — insert the new columns. Wrap per-symbol body extraction + hashing + tokenization + MinHash signature computation in the `analyzeAndInsert` flow. Populate `symbol_tokens` (TF-IDF) and `symbol_minhash` (clone detection) during indexing.
- [x] Task 3.8: Update `src/types.ts` — add `is_exported`, `body_hash`, `token_count` to the `Symbol` interface. Add `metadata` to `Edge`. Add `IndexError`, `SymbolToken`, `SymbolMinhash`, `SymbolEmbedding` interfaces.
- [x] Task 3.9: Update the `TABLES`/subsystem registry in `list-delete.ts` — add `index_errors`, `symbol_tokens`, `symbol_minhash`, `symbol_embeddings` to the subsystem enum so they can be listed/purged via `list_items` / `purge_subsystem`.

### Sprint 4: Code-Graph Analysis Tools (P1/P2 — Depends on Sprints 1 + 3) ✅

- [x] Task 4.1: Implement `get_code_snippet` — read file via `fs.readFileSync`, slice lines `start_line..end_line`, pad with `context_lines`. Auto-detect language from extension. Handle `symbol_name` resolution (exact match, then first match in `file_path`). Return `{file_path, start_line, end_line, content, language, symbol_name}`.
- [x] Task 4.2: Implement `check_index_coverage` — run `walkFilesWithMtime` on `workspaceRoot`, compare to `file_index` table. Report `total_files`, `indexed_files`, `unindexed_files[]`, `stale_files[]` (mtime mismatch), `coverage_pct`, `by_language` breakdown. Include `index_errors` entries as `parse_errors[]`.
- [x] Task 4.3: Implement `find_dead_code` — SQL: `SELECT s.* FROM symbols s WHERE s.is_exported = 0 AND s.symbol_name NOT LIKE pattern AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.to_symbol_id = s.id AND e.edge_type IN ('calls','imports','extends','implements'))`. Exclude test files (`*.test.*`, `*.spec.*`, `test_*`). Return grouped by file.
- [x] Task 4.4: Implement `query_graph` — recursive CTE: `WITH RECURSIVE reach(id, depth, path) AS (SELECT id, 0, '/' || id FROM symbols WHERE id = ? UNION ALL SELECT e.to_symbol_id, r.depth+1, r.path || '/' || e.to_symbol_id FROM reach r JOIN edges e ON e.from_symbol_id = r.id WHERE r.depth < ?)`. Apply edge-type, direction, filter, limit. Return `{nodes, paths, total_reachable}`.
- [x] Task 4.5: Implement `analyze_impact` — run `git diff --name-only` in `workspaceRoot` (via `child_process.execSync`). Map changed files to symbols (`SELECT id, symbol_name, file_path FROM symbols WHERE file_path IN (...)`). Run reverse recursive CTE (incoming edges only) for each changed symbol. Deduplicate impacted symbols. Return `{changed_files, changed_symbols, impacted_symbols, summary}`.
- [x] Task 4.6: Implement `find_duplicates` — reads MinHash signatures from the persisted `symbol_minhash` table (computed during `index_codebase`, Task 3.7). For each pair of symbols with the same `body_hash` (exact clone, fast path), insert `SIMILAR_TO` edge with `metadata: {score:1.0, algorithm:"exact"}`. For near-duplicates: compare MinHash signatures via Jaccard estimation (compare equal hash positions across the two signature arrays), insert `SIMILAR_TO` edges with `metadata: {score, algorithm:"minhash", num_hashes, shingle_k}` above threshold. If `recompute=true`, recompute signatures from symbol bodies before comparing (and upsert into `symbol_minhash`). Default (`recompute=false`) uses stored signatures — fast, incremental.
- [x] Task 4.7: Implement `find_related` — Phase 1 heuristic scoring: two symbols are related if they (a) share callers (common `from_symbol_id` in `calls` edges), (b) share imports (common `to_symbol_id` in `imports` edges), (c) are in the same file, (d) have a `SIMILAR_TO` edge. Score = weighted sum. Insert `SEMANTICALLY_RELATED` edges with `metadata: {score, reasons: [...]}`. Return top-K by score.
- [x] Task 4.8: Implement `semantic_code_search` (TF-IDF backend) — tokenize query, compute IDF from `symbol_tokens` (df per token), compute cosine similarity, return top-K. Tokenize symbol bodies during `index_codebase` (update Task 3.7's flow to also populate `symbol_tokens`). Add `backend: "tfidf"` to response.
- [x] Task 4.9: Create `src/indexing/edge-types.ts` — export the `EDGE_TYPES` constant object. Update `ts-analyzer.ts`, `py-analyzer.ts`, `code-graph.ts`, `codemap.ts` to import from this module instead of bare strings.
- [x] Task 4.10: Register all 8 tools in `index.ts` via `registerCodeAnalysisTools(server, db, workspaceRoot)`. Update tool-count in README from 30 → 39.
- [x] Task 4.11: Write smoke-test coverage for each new tool — create test symbols/edges, call each tool, verify response shape and correctness. Test edge cases (empty graph, single symbol, circular edges, git-not-a-repo).

### Sprint 5: README, Distribution & Release (P0 — Depends on Sprints 1–4) ✅

- [x] Task 5.1: Rewrite README "Quick Start" section — add three install methods: `npx cogmemory-mcp` (recommended), `npm install -g cogmemory-mcp`, `pnpm dlx cogmemory-mcp`. Replace the `git clone` method as the "from source / dev" alternative.
- [x] Task 5.2: Add IDE configuration section with copy-paste JSON for: VS Code (`.vscode/mcp.json`), Cursor (`.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`), Claude Code (`~/.claude/mcp.json`), Cline (`cline_mcp_settings.json`), Windsurf (mcp config), OpenCode (`opencode.json`), Zed (`settings.json`). Each uses `npx cogmemory-mcp` as the command.
- [x] Task 5.3: Add "MCP Registry" install section — document that the server is listed on the MCP Registry and how to add it via registry-aware clients.
- [x] Task 5.4: Add "Native Module Requirements" callout — document that `better-sqlite3` and `tree-sitter` require a build toolchain (Python 3, C++ compiler, `make`). Link to `node-gyp` docs. Note: prebuilt binaries exist for common platforms (linux x64/arm64, macOS x64/arm64, Windows x64).
- [x] Task 5.5: Add "Upgrades & Migrations" section — explain that schema migrations are automatic on next launch, that a backup file is created for first-time migrations, and that `COGMEMORY_SKIP_BACKUP=1` disables it. Document the recovery procedure if a migration fails. Add a "Update Check Telemetry" subsection disclosing that `check_for_updates` makes an outbound HTTPS GET to `registry.npmjs.org/cogmemory-mcp/latest` (read-only, cached 24h, enabled by default) and documenting both opt-out mechanisms: `COGMEMORY_DISABLE_UPDATE_CHECK=1` env var or `.cogmemory/config.json: { "disable_update_check": true }`.
- [x] Task 5.6: Add the 9 new tools to the "Tool Reference" tables in README. Group under a new "Introspection" and "Code Analysis" subsection.
- [x] Task 5.7: Fix the README "Architecture" tree — add `src/indexing/py-analyzer.ts`, `src/db/migrations/`, `src/tools/introspection.ts`, `src/tools/code-analysis.ts`, `src/indexing/edge-types.ts`, `src/version.ts`.
- [x] Task 5.8: Fix the README schema count — update from "17 tables + 2 FTS5 virtual tables" to the accurate count: 17 base tables + 4 new tables (`index_errors`, `symbol_embeddings`, `symbol_tokens`, `symbol_minhash`) = 21 base tables + 2 FTS5 virtual tables (`recall_fts`, `kg_fts`) + 2 FTS content tables (`recall_docs`, `kg_docs`) = 25 user-visible objects. Document the new columns on `symbols` (`is_exported`, `body_hash`, `token_count`) and `edges` (`metadata`).
- [x] Task 5.9: Add "Troubleshooting" section — native build failures, migration failures (backup recovery), `git diff` not available (impact analysis), large workspace performance tips.
- [x] Task 5.10: Update `server.json` version to `1.1.0` (synced with `package.json`). Verify `mcpName` matches the MCP Registry entry. _(Surpassed — currently at v1.6.4.)_
- [x] Task 5.11: Update `.github/workflows/publish.yml` — ensure `prebuild` runs before `build` in `prepublishOnly`. Verify the version patch in CI propagates to both `package.json` and `server.json` (already does) and now also to `src/version.ts` via the `prebuild` hook.
- [x] Task 5.12: Run the full smoke test suite + manual MCP Inspector verification of all 39 tools. Tag release `v1.1.0` and publish to npm + MCP Registry. _(Surpassed — released at v1.6.4.)_

---

## Resolved Design Decisions

All five open questions have been confirmed by the user. The decisions below are locked in and reflected in the task list.

| #   | Decision                       | Resolution                                                                                                                                                                                                                                                        | Impact                                                                                                     |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Python `is_exported` detection | **Both** — a symbol is "exported" if it is listed in `__all__` (when `__all__` is present in the file) OR if it is a top-level def/class without a `_` prefix. When `__all__` is present, it is authoritative.                                                    | Task 3.6 updated. `py-analyzer.ts` must scan for `__all__` assignment nodes.                               |
| 2   | MinHash signature persistence  | **Persist to `symbol_minhash` table** — signatures computed during `index_codebase` and stored. Enables incremental clone detection; `find_duplicates` reads from the table unless `recompute=true`.                                                              | New migration `007_symbol_minhash.sql` added as Task 3.4b. Task 3.7 and Task 4.6 updated.                  |
| 3   | sqlite-vec embedding backend   | **Defer to v1.2.0** — v1.1.0 ships TF-IDF only. The `symbol_embeddings` stub table is included (decision #5) but unused. `semantic_code_search` reports `backend: "tfidf"`.                                                                                       | No change to Task 4.8. Phase 2 tracked as future work.                                                     |
| 4   | `check_for_updates` privacy    | **Opt-out (enabled by default)** — the tool makes a read-only HTTPS GET to `registry.npmjs.org/cogmemory-mcp/latest`, cached 24h. Users can disable via `COGMEMORY_DISABLE_UPDATE_CHECK=1` env var or `.cogmemory/config.json: { "disable_update_check": true }`. | Task 2.2 updated to check the disable flag. Task 5.5 (README) must document the telemetry and the opt-out. |
| 5   | `symbol_embeddings` stub table | **Include now** — migration `004_symbol_embeddings.sql` creates the table (empty, unused in v1.1.0). Signals Phase 2 intent and avoids a migration-number gap.                                                                                                    | Task 3.4 split: `004` is now included, `006` follows it.                                                   |

---

## Next Actions

**All 48 tasks across Sprints 1–5 are complete.** The blueprint has been fully implemented and released (currently at v1.6.4 on npm, surpassing the original v1.1.0 target).

Verification evidence:

- **Sprint 1:** `migration-runner.ts`, `connection.ts` (uses `runMigrations`), `version.ts` (auto-generated at v1.6.4), `generate-version.ts`, `prebuild` script, both `schema.sql` files deleted, smoke test covers migration idempotency + backup.
- **Sprint 2:** `introspection.ts` implements `cogmemory_status` + `check_for_updates` (with opt-out flag check); both registered in `index.ts`; smoke test verifies schema version + disable-flag behavior.
- **Sprint 3:** All 7 migration files present (001–007); `ts-analyzer.ts` + `py-analyzer.ts` track `is_exported` (py uses `__all__` dual rule); `code-graph.ts` populates `symbol_tokens` + `symbol_minhash` during indexing; `types.ts` has `SymbolExtended`, `EdgeExtended`, `IndexError`, `SymbolToken`, `SymbolMinhash`, `SymbolEmbedding`; `list-delete.ts` registry includes all 4 new tables.
- **Sprint 4:** All 8 code-analysis tools implemented in `code-analysis.ts` and registered via `registerCodeAnalysisTools`; `edge-types.ts` module created with `EDGE_TYPES` constant; smoke test covers `get_code_snippet`, `find_dead_code`, `find_duplicates`, `query_graph`, `find_related`, `semantic_code_search`, `check_index_coverage`.
- **Sprint 5:** README has 3 install methods, 8 IDE configs, MCP Registry section, Native Module callout, Upgrades & Migrations section, Troubleshooting, 9 new tools documented, architecture tree updated, schema count corrected to 25; `server.json` at v1.6.4; `publish.yml` runs `prebuild` via `build`.

Future work (not in this blueprint):

- **Phase 2:** `sqlite-vec` vector embeddings backend for true semantic search (stub table `symbol_embeddings` already in place via migration 004).
- **Go analyzer:** `go-analyzer.ts` exists in `src/indexing/` — verify it tracks `is_exported` / `body_hash` / `token_count` for parity with TS/Python analyzers.
