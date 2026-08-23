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

```bash
git clone <repo> && cd cogmemory-mcp
pnpm install
pnpm run build
```

### Configure in VS Code

Add to `.vscode/mcp.json` (workspace-scoped):

```json
{
  "servers": {
    "cogmemory": {
      "command": "node",
      "args": ["/absolute/path/to/cogmemory-mcp/dist/index.js"]
    }
  }
}
```

Or add to your user `mcp.json` for global availability.

### Run with MCP Inspector (dev)

```bash
pnpm run inspect
```

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

### Multi-Root VS Code Workspaces

In a VS Code multi-root workspace, each folder is a separate workspace root. CogMemory handles this:

- **Single-root** — Works automatically. VS Code sets CWD to the workspace folder, and `--workspace` is passed via `mcp.json`.
- **Multi-root** — Each workspace folder can have its own `.cogmemory/`. Point each to CogMemory with different `--workspace` paths, or place a shared `.cogmemory/` in a parent directory.

**Recommended multi-root `mcp.json`** (per-folder):

```json
{
  "servers": {
    "cogmemory-frontend": {
      "command": "node",
      "args": [
        "/path/to/cogmemory-mcp/dist/index.js",
        "--workspace",
        "/path/to/frontend"
      ]
    },
    "cogmemory-backend": {
      "command": "node",
      "args": [
        "/path/to/cogmemory-mcp/dist/index.js",
        "--workspace",
        "/path/to/backend"
      ]
    }
  }
}
```

**Or use a shared database** (all roots in one place):

```json
{
  "servers": {
    "cogmemory": {
      "command": "node",
      "args": [
        "/path/to/cogmemory-mcp/dist/index.js",
        "--workspace",
        "/shared/root"
      ]
    }
  }
}
```

**Or use global scope** to share across all workspaces:

```json
{
  "servers": {
    "cogmemory": {
      "command": "node",
      "args": ["/path/to/cogmemory-mcp/dist/index.js"]
    }
  }
}
```

```bash
export COGMEMORY_SCOPE=global
```

---

## Tool Reference

### Memory Tools

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

### Knowledge Graph Tools

| Tool               | Description                             |
| ------------------ | --------------------------------------- |
| `create_entity`    | Add entity (deduped on name+type)       |
| `create_relation`  | Link two entities with a typed relation |
| `add_observation`  | Attach a fact to an entity              |
| `search_knowledge` | Query entities, relations, observations |

### Specs Tools

| Tool          | Description                              |
| ------------- | ---------------------------------------- |
| `create_spec` | Store a long-form document               |
| `get_spec`    | Retrieve by ID or exact title            |
| `update_spec` | Update content/title, auto-bumps version |

### Code Graph Tools

| Tool               | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `index_codebase`   | Walk workspace, extract symbols + edges (JS/TS via ts-morph, Python via tree-sitter) |
| `query_code_graph` | Look up a symbol's callers/callees/imports (1-hop)                                   |
| `generate_codemap` | BFS from entry symbol, bounded subgraph with optional traces + annotations           |
| `annotate_symbol`  | Attach narrative text to a symbol or trace                                           |

### List & Delete Tools

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
│   ├── config.ts                # scope resolution, path resolution
│   ├── types.ts                 # shared TS types mirroring schema
│   ├── db/
│   │   ├── connection.ts        # DB open/close, pragma setup
│   │   ├── schema.sql           # full schema (reference)
│   │   └── migrate.ts           # idempotent schema application
│   ├── tools/
│   │   ├── memory.ts            # decisions/conventions/errors/context/changelog/recall
│   │   ├── plan-tasks.ts        # plan + tasks tools
│   │   ├── sessions.ts          # start/end session, summary
│   │   ├── knowledge-graph.ts   # entities/relations/observations
│   │   ├── specs.ts             # spec CRUD
│   │   ├── code-graph.ts        # index_codebase, query_code_graph
│   │   ├── codemap.ts           # generate_codemap, annotate_symbol
│   │   ├── list-delete.ts       # list_items, delete_item, purge_subsystem
│   │   └── utils.ts             # wrapHandler, jsonOk, jsonFail, jsonErr
│   └── indexing/
│       ├── ts-analyzer.ts       # ts-morph symbol/edge extraction (JS/TS)
│       ├── py-analyzer.ts       # tree-sitter symbol/edge extraction (Python)
│       └── walker.ts            # file discovery, gitignore respect
├── schema.sql                   # reference copy
├── package.json
├── tsconfig.json
└── README.md
```

---

## Schema (17 tables + 2 FTS5 virtual tables)

- **Memory (8):** `sessions`, `decisions`, `conventions`, `errors`, `context`, `changelog`, `plan`, `tasks`
- **Knowledge Graph (3):** `entities`, `relations`, `observations`
- **Knowledge Graph FTS5 (2):** `kg_docs` (content table), `kg_fts` (FTS5 virtual table)
- **Specs (1):** `specs`
- **Code Graph (4):** `symbols`, `edges`, `execution_traces`, `codemap_annotations`
- **Code Graph Index (1):** `file_index`

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
pnpm run build      # Compile TypeScript
pnpm run start      # Run compiled output
pnpm run inspect    # Launch MCP Inspector
pnpm run smoke-test # Run smoke test script
```

---

## License

MIT

---

## Supported Languages

The Code Graph (`index_codebase`) extracts symbols and edges from source files using language-specific analyzers:

| Language   | Extensions                    | Analyzer    | Symbols Extracted                                                              |
| ---------- | ----------------------------- | ----------- | ------------------------------------------------------------------------------ |
| TypeScript | `.ts`, `.tsx`                 | ts-morph    | files, functions, classes, interfaces, methods, type aliases, enums, variables |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | ts-morph    | files, functions, classes, methods, variables                                  |
| Python     | `.py`                         | tree-sitter | files, functions, classes, methods                                             |

**Edges extracted:** calls, imports, extends, implements (all languages).

To index additional file types, pass `extensions` to `index_codebase`:

```json
{ "extensions": ["ts", "tsx", "js", "jsx", "py"] }
```
