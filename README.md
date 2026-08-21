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

| Tool               | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `index_codebase`   | Walk workspace, extract symbols + edges via ts-morph (JS/TS)               |
| `query_code_graph` | Look up a symbol's callers/callees/imports (1-hop)                         |
| `generate_codemap` | BFS from entry symbol, bounded subgraph with optional traces + annotations |
| `annotate_symbol`  | Attach narrative text to a symbol or trace                                 |

---

## Architecture

```
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
│   │   └── codemap.ts           # generate_codemap, annotate_symbol
│   └── indexing/
│       ├── ts-analyzer.ts       # ts-morph symbol/edge extraction
│       └── walker.ts            # file discovery, gitignore respect
├── schema.sql                   # reference copy
├── package.json
├── tsconfig.json
└── README.md
```

---

## Schema (15 tables)

- **Memory (8):** `sessions`, `decisions`, `conventions`, `errors`, `context`, `changelog`, `plan`, `tasks`
- **Knowledge Graph (3):** `entities`, `relations`, `observations`
- **Specs (1):** `specs`
- **Code Graph (4):** `symbols`, `edges`, `execution_traces`, `codemap_annotations`

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
