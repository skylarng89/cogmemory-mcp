# System Architecture Blueprint: CogMemory Schema Migration, Auto-Update, Code-Graph Tools & Distribution

**Status:** Implemented v1.6.4 — 2026-08-26 (all 48 tasks across 5 sprints complete)
**Author:** Architect Agent
**Scope:** Four interconnected concerns — (1) schema migration for existing users, (2) code-update distribution, (3) nine new MCP tools, (4) README/IDE distribution overhaul.

---

## Executive Summary (TL;DR)

CogMemory is at v1.0.0 on npm but ships **no real migration system** — `migrate()` is an idempotent `CREATE TABLE IF NOT EXISTS` block that cannot evolve existing tables. This blueprint delivers:

1. **A versioned migration runner** (`PRAGMA user_version` + numbered migration files + pre-migration backup) that transparently upgrades all existing `.cogmemory/memory.db` files on next launch — zero data loss, zero user action.
2. **An update-aware distribution model**: fix the hardcoded `0.1.0` version constant, add a `cogmemory_status` introspection tool + `check_for_updates` tool that pings the npm registry, and document `npx` as the always-latest install method.
3. **Nine new tools** spanning semantic search (TF-IDF Phase 1 → sqlite-vec Phase 2), dead-code detection, clone detection (`SIMILAR_TO` edges), semantic relation discovery (`SEMANTICALLY_RELATED` edges), multi-hop Cypher-style graph queries, uncommitted-change impact analysis, direct snippet fetch, index-coverage audit, and runtime introspection.
4. **A README overhaul** with `npx`/`npm -g`/`pnpm dlx` install methods and copy-paste MCP configs for VS Code, Cursor, Claude Desktop, Claude Code, Cline, Windsurf, OpenCode, and Zed.

The work is decomposed into **5 Sprints / 48 tasks**. Schema migrations and the version-constant fix are prioritized first (Sprint 1) because every subsequent tool depends on a migrable schema and correct version reporting. All 5 design open questions have been resolved by the user — see "Resolved Design Decisions" below.
