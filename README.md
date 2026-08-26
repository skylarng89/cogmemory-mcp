# CogMemory MCP Server

A unified [Model Context Protocol](https://modelcontextprotocol.io/) server providing four context subsystems for AI coding agents:

1. **Memory** — decisions, conventions, errors, active context, changelog, plan, tasks, sessions
2. **Knowledge Graph** — entities, relations, observations
3. **Specs** — long-form documents (PRD/SRS), optionally linked to a KG entity
4. **Code Graph** — static structural graph (symbols/edges) + named execution traces + AI-generated annotations

Storage: **SQLite** via `better-sqlite3`. One `.db` file per scope.

---

## Quick Start

### Install

**Option A — npx (recommended, always latest):**

```bash
npx -y cogmemory-mcp@latest
```

**Option B — Global install:**

```bash
npm install -g cogmemory-mcp
cogmemory-mcp
```

**Option C — pnpm dlx:**

```bash
pnpm dlx cogmemory-mcp@latest
```

**Option D — From source (developers):**

```bash
git clone https://github.com/skylarng89/cogmemory-mcp.git
cd cogmemory-mcp
pnpm install
pnpm run build
```

### Native Module Requirements

CogMemory depends on `better-sqlite3` and `tree-sitter`, which compile native modules on install. You need:

- **Python 3** (for `node-gyp`)
- **C/C++ compiler** (`gcc`/`g++` on Linux, Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows)
- **`make`** (Linux/macOS, installed by default)

Most platforms have **prebuilt binaries** available, so compilation is usually skipped on:

- Linux x64 / arm64
- macOS x64 / arm64
- Windows x64

If installation fails, see [Troubleshooting](#troubleshooting) below.

---

## IDE / Client Configuration

### VS Code

Add to `.vscode/mcp.json` (workspace-scoped):

```json
{
  "servers": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

Or use `--workspace` for multi-root support:

```json
{
  "servers": {
    "cogmemory-frontend": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest", "--workspace", "/path/to/frontend"]
    },
    "cogmemory-backend": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest", "--workspace", "/path/to/backend"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### Claude Desktop

Add to `~/.config/claude/claude_desktop_config.json` (Linux/macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### Claude Code

Add to `~/.claude/mcp.json` (user-level) or `.claude/mcp.json` (project-level):

```json
{
  "mcpServers": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### Cline

In the Cline extension settings, add an MCP server:

- **Name:** `cogmemory`
- **Command:** `npx -y cogmemory-mcp@latest`

Or in `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### Windsurf

MCP settings → Add server:

```json
{
  "mcpServers": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### OpenCode

Add to `opencode.json`:

```json
{
  "mcp": {
    "cogmemory": {
      "command": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### Zed

Add to Zed settings (`settings.json`):

```json
{
  "context_servers": {
    "cogmemory": {
      "binary": "npx",
      "args": ["-y", "cogmemory-mcp@latest"]
    }
  }
}
```

### MCP Registry

CogMemory is published to the [MCP Registry](https://registry.modelcontextprotocol.io/). Registry-aware clients can discover and install it automatically.

---

## Scope Configuration

CogMemory resolves scope in priority order:

1. **`.cogmemory/config.json`** in workspace root:

   ```json
   { "scope": "global" }
   ```

2. **Environment variable**: `COGMEMORY_SCOPE=global`
3. **Default**: `workspace`

### Paths

| Scope     | Database Path                           |
| --------- | --------------------------------------- |
| workspace | `<workspace_root>/.cogmemory/memory.db` |
| global    | `~/.cogmemory/global.db`                |

---

## Workspace Resolution & Multi-Root Support

CogMemory resolves the workspace root (where `.cogmemory/memory.db` lives) in this priority order:

1. **`--workspace <path>`** CLI argument (highest priority)
2. **`COGMEMORY_WORKSPACE`** environment variable
3. **Walk up from CWD** looking for the nearest parent containing a `.cogmemory/` directory
4. **Fallback to CWD**

---

## Upgrades & Migrations

CogMemory uses a versioned migration system. When a new version adds columns or tables, **migrations run automatically on the next server startup** — no manual action needed.

### First-Time Migration (Pre-v1.1.0 Databases)

If you are upgrading from a version prior to v1.1.0 that used the old schema:

1. A **backup file** is created automatically: `<db_path>.backup-pre-migrate-<timestamp>`
2. Migrations apply within a transaction — if any step fails, the database is rolled back
3. If something goes wrong, you can restore from the backup: `cp memory.db.backup-* memory.db`
4. Set `COGMEMORY_SKIP_BACKUP=1` to skip the backup (e.g., in CI or disk-constrained environments)

### Opt-Out: Update Check Telemetry

By default, CogMemory checks the npm registry once every 24 hours to see if a newer version is available (via the `check_for_updates` tool). This makes a **read-only HTTPS GET** to `registry.npmjs.org` — the same call your package manager makes.

To disable this check:

- **Environment variable:** `COGMEMORY_DISABLE_UPDATE_CHECK=1`
- **Config file:** Add `{ "disable_update_check": true }` to `.cogmemory/config.json`

---

## Tool Reference (40 tools)

### Memory Tools (14)

| Tool                  | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `start_session`       | Begin a work session (returns session ID)                      |
| `end_session`         | Close session, store summary                                   |
| `get_session_summary` | Recall session details including decisions, errors, changelog  |
| `remember_decision`   | Log a decision with rationale and tags                         |
| `remember_convention` | Log/update a convention (design token, pattern, style, naming) |
| `log_error`           | Record an error with signature and resolution                  |
| `set_active_context`  | Upsert current focus/task by key                               |
| `get_active_context`  | Read current focus by key                                      |
| `log_change`          | Append changelog entry                                         |
| `add_plan_item`       | Add a roadmap item                                             |
| `update_plan_status`  | Change plan item status                                        |
| `create_task`         | Create a task, optionally linked to a plan                     |
| `update_task_status`  | Change task status                                             |
| `recall`              | Unified search across decisions/conventions/errors/changelog   |

### Knowledge Graph Tools (4)

| Tool               | Description                             |
| ------------------ | --------------------------------------- |
| `create_entity`    | Add entity (deduped on name+type)       |
| `create_relation`  | Link two entities with a typed relation |
| `add_observation`  | Attach a fact to an entity              |
| `search_knowledge` | Query entities, relations, observations |

### Specs Tools (3)

| Tool          | Description                              |
| ------------- | ---------------------------------------- |
| `create_spec` | Store a long-form document               |
| `get_spec`    | Retrieve by ID or exact title            |
| `update_spec` | Update content/title, auto-bumps version |

### Code Graph Tools (4)

| Tool               | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `index_codebase`   | Walk workspace, extract symbols + edges (JS/TS via ts-morph, Python via tree-sitter) |
| `query_code_graph` | Look up a symbol's callers/callees/imports (1-hop)                                   |
| `generate_codemap` | BFS from entry symbol, bounded subgraph with optional traces + annotations           |
| `annotate_symbol`  | Attach narrative text to a symbol or trace                                           |

### Introspection Tools (2)

| Tool                | Description                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cogmemory_status`  | Show runtime config: package version, schema version, db path, workspace root, scope, index coverage, and subsystem counts |
| `check_for_updates` | Check if a newer version is available on npm (HTTPS GET to registry, cached 24h)                                           |

### Code Analysis Tools (8)

| Tool                   | Description                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `semantic_code_search` | TF-IDF based semantic code search — natural language query returns ranked symbols by relevance                                    |
| `find_dead_code`       | Find symbols with zero inbound callers, excluding exported symbols and configurable entry points                                  |
| `find_duplicates`      | Detect duplicate/clone symbol pairs via exact hash + MinHash similarity, inserts `SIMILAR_TO` edges                               |
| `find_related`         | Discover semantically-related symbols via shared callers/imports/same-file heuristics, inserts `SEMANTICALLY_RELATED` edges       |
| `query_graph`          | Multi-hop structural graph query using recursive CTE — supports arbitrary depth, edge-type filters, direction                     |
| `analyze_impact`       | Analyze impact of uncommitted changes (`git diff`) — maps changed files to symbols and computes reverse transitive caller closure |
| `get_code_snippet`     | Fetch source code lines for a symbol by ID or name, with optional context padding                                                 |
| `check_index_coverage` | Report indexed vs. unindexed vs. stale files with per-language breakdowns                                                         |

### List & Delete Tools (5)

| Tool              | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `list_items`      | Browse stored entries from any subsystem with optional filters |
| `delete_item`     | Delete a single row by ID from any subsystem                   |
| `delete_by_key`   | Delete a context entry by its string key                       |
| `delete_by_path`  | Remove a file from the code graph file_index                   |
| `purge_subsystem` | Remove ALL rows from a subsystem (requires `confirm=true`)     |

---

## Architecture

```plain
cogmemory-mcp/
├── src/
│   ├── index.ts                 # entry point, server bootstrap
│   ├── version.ts               # auto-generated version constant
│   ├── config.ts                # scope resolution, path resolution
│   ├── types.ts                 # shared TS types mirroring schema
│   ├── db/
│   │   ├── connection.ts        # DB open/close, pragma setup
│   │   ├── migration-runner.ts  # versioned migration engine (PRAGMA user_version)
│   │   ├── migrate.ts           # legacy idempotent migration (deprecated)
│   │   └── migrations/
│   │       ├── 001_baseline.sql         # full v1 schema
│   │       ├── 002_symbol_export_hash.sql
│   │       ├── 003_index_errors.sql
│   │       ├── 004_symbol_embeddings.sql
│   │       ├── 005_edge_metadata.sql
│   │       ├── 006_symbol_tokens.sql
│   │       └── 007_symbol_minhash.sql
│   ├── tools/
│   │   ├── memory.ts            # decisions/conventions/errors/context/changelog/recall
│   │   ├── plan-tasks.ts        # plan + tasks tools
│   │   ├── sessions.ts          # start/end session, summary
│   │   ├── knowledge-graph.ts   # entities/relations/observations
│   │   ├── specs.ts             # spec CRUD
│   │   ├── code-graph.ts        # index_codebase, query_code_graph
│   │   ├── codemap.ts           # generate_codemap, annotate_symbol
│   │   ├── code-analysis.ts     # dead code, duplicates, related, graph query, impact, snippet, coverage, search
│   │   ├── introspection.ts     # cogmemory_status, check_for_updates
│   │   ├── list-delete.ts       # list_items, delete_item, purge_subsystem
│   │   └── utils.ts             # wrapHandler, jsonOk, jsonFail, jsonErr
│   └── indexing/
│       ├── ts-analyzer.ts       # ts-morph symbol/edge extraction (JS/TS)
│       ├── py-analyzer.ts       # tree-sitter symbol/edge extraction (Python)
│       ├── edge-types.ts        # edge type constants (calls, imports, extends, implements, similarto, semrelated)
│       └── walker.ts            # file discovery, gitignore respect
├── package.json
├── tsconfig.json
└── README.md
```

---

## Schema (25 tables)

**Base tables (21):**

- **Memory (8):** `sessions`, `decisions`, `conventions`, `errors`, `context`, `changelog`, `plan`, `tasks`
- **Knowledge Graph (3):** `entities`, `relations`, `observations`
- **Specs (1):** `specs`
- **Code Graph (5):** `symbols` (with `is_exported`, `body_hash`, `token_count` columns), `edges` (with `metadata` JSON column), `execution_traces`, `codemap_annotations`, `file_index`
- **Code Analysis (3):** `index_errors`, `symbol_tokens` (TF-IDF), `symbol_minhash` (MinHash signatures)
- **Future (1):** `symbol_embeddings` (stub — vector embeddings for Phase 2)

**FTS5 tables (4):**

- **Recall FTS:** `recall_docs` (content table) + `recall_fts` (FTS5 virtual table) — powers `recall`
- **Knowledge Graph FTS:** `kg_docs` (content table) + `kg_fts` (FTS5 virtual table) — powers `search_knowledge`

Schema migrations are automatic via `PRAGMA user_version` (currently at version 7).

---

## Supported Languages

The Code Graph (`index_codebase`) extracts symbols and edges from source files using language-specific analyzers:

| Language   | Extensions                    | Analyzer    | Symbols Extracted                                                                                   |
| ---------- | ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| TypeScript | `.ts`, `.tsx`                 | ts-morph    | files, functions, classes, interfaces, methods, type aliases, enums, variables (with `is_exported`) |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | ts-morph    | files, functions, classes, methods, variables                                                       |
| Python     | `.py`                         | tree-sitter | files, functions, classes, methods (with `is_exported` via `__all__` / underscore rule)             |

**Structural edges:** calls, imports, extends, implements

**Analysis edges:** `similarto` (clone detection), `semrelated` (semantic relation discovery)

---

## Pragmas

Set on every connection open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

---

## Development

```bash
pnpm run dev        # Run with tsx (no build step)
pnpm run build      # Compile TypeScript (regenerates version.ts via prebuild)
pnpm run start      # Run compiled output
pnpm run inspect    # Launch MCP Inspector
pnpm run smoke-test # Run smoke test script (43 checks)
```

---

## Troubleshooting

### Native module build failure

If `npm install` or `pnpm install` fails with `node-gyp` errors:

1. **Install Python 3:** `python3 --version` — if missing, install via your package manager
2. **Install C++ build tools:**
   - **macOS:** `xcode-select --install`
   - **Ubuntu/Debian:** `sudo apt-get install build-essential`
   - **Windows:** Install Visual Studio Build Tools with the "C++ build tools" workload
3. **Retry:** `npm rebuild better-sqlite3` (or `npm rebuild tree-sitter`)

### Migration failure

If the server exits with a migration error:

1. Check stderr for the error message and the migration file number
2. Restore from backup: `cp .cogmemory/memory.db.backup-* .cogmemory/memory.db`
3. Try again — the migration will re-run from the current `user_version`

### Large workspace performance

For workspaces with 50k+ files:

1. Use `.gitignore` to exclude vendored/generated code (CogMemory respects it)
2. The walker skips `node_modules`, `.git`, `dist`, `build`, `.next`, `.cogmemory`, `__pycache__`, `.venv`, `venv`, `*.min.js`, `*.min.css`, `*.map` by default
3. Index coverage: the `check_index_coverage` tool paginates unindexed file reports at 1000 entries

### `analyze_impact` — git not available

If the workspace is not a git repository, `analyze_impact` with auto-detection will fail. Pass `changed_files` manually instead.

---

## License

MIT
