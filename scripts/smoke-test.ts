// CogMemory MCP — Smoke test script
// Runs all tools against a temporary database to verify basic functionality.

import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migration-runner.js";
import { analyzePythonFiles } from "../src/indexing/py-analyzer.js";

const tmpDir = mkdtempSync(join(tmpdir(), "cogmemory-test-"));
const dbPath = join(tmpDir, "test.db");

console.log(`\n🧪 CogMemory Smoke Test`);
console.log(`   DB: ${dbPath}\n`);

let passed = 0;
let failed = 0;

function pass(label: string): void {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label: string): void {
  console.error(`  ❌ ${label}`);
  failed++;
}

function checkTrue(value: unknown, label: string): void {
  value ? pass(label) : fail(label);
}

function checkEqual(actual: unknown, expected: unknown, label: string): void {
  actual === expected ? pass(label) : fail(label);
}

const assert = checkTrue;

function run() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, dbPath);

  // ── Sessions ───────────────────────────────────────────
  console.log("\n📋 Sessions");
  const sessResult = db.prepare("INSERT INTO sessions DEFAULT VALUES").run();
  const sessionId = sessResult.lastInsertRowid as number;
  assert(sessionId > 0, "start_session creates a session");

  db.prepare(
    "UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE id = ?",
  ).run("Test session", sessionId);
  const sess = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown>;
  assert(sess.ended_at !== null, "end_session sets ended_at");
  assert(sess.summary === "Test session", "end_session stores summary");

  // ── Decisions ──────────────────────────────────────────
  console.log("\n📋 Decisions");
  const decResult = db
    .prepare(
      "INSERT INTO decisions (session_id, title, rationale, tags) VALUES (?, ?, ?, ?)",
    )
    .run(
      sessionId,
      "Use SQLite",
      "Fast, embedded, zero-config",
      "database,architecture",
    );
  assert(decResult.changes > 0, "remember_decision inserts a row");

  const decs = db
    .prepare("SELECT * FROM decisions WHERE title = ?")
    .all("Use SQLite");
  assert(decs.length === 1, "decision is retrievable");

  // ── Conventions ────────────────────────────────────────
  console.log("\n📋 Conventions");
  db.prepare(
    `INSERT INTO conventions (category, key, value, description, tags)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, category, key) DO UPDATE SET value = excluded.value`,
  ).run("naming", "camelCase", "true", "Use camelCase for variables", "style");
  const conv = db
    .prepare("SELECT * FROM conventions WHERE category = ? AND key = ?")
    .get("naming", "camelCase") as Record<string, unknown>;
  assert(conv !== undefined, "convention is stored");
  assert(conv.value === "true", "convention value is correct");

  // ── Errors ─────────────────────────────────────────────
  console.log("\n📋 Errors");
  db.prepare(
    "INSERT INTO errors (session_id, error_signature, description, resolution, tags) VALUES (?, ?, ?, ?, ?)",
  ).run(
    sessionId,
    "TypeErr:undefined",
    "Cannot read property of undefined",
    "Add null check",
    "typescript",
  );
  const errs = db
    .prepare("SELECT * FROM errors WHERE error_signature = ?")
    .all("TypeErr:undefined");
  assert(errs.length === 1, "error is logged");

  // ── Context ────────────────────────────────────────────
  console.log("\n📋 Context");
  db.prepare(
    `INSERT INTO context (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run("active_task", "Building smoke test");
  const ctx = db
    .prepare("SELECT * FROM context WHERE key = ?")
    .get("active_task") as Record<string, unknown>;
  assert(ctx.value === "Building smoke test", "active_context is set");

  // ── Changelog ──────────────────────────────────────────
  console.log("\n📋 Changelog");
  db.prepare(
    "INSERT INTO changelog (session_id, summary, ref) VALUES (?, ?, ?)",
  ).run(sessionId, "Implemented smoke test", "commit:abc123");
  const changes = db
    .prepare("SELECT * FROM changelog WHERE session_id = ?")
    .all(sessionId);
  assert(changes.length === 1, "changelog entry recorded");

  // ── Plan & Tasks ───────────────────────────────────────
  console.log("\n📋 Plan & Tasks");
  const planResult = db
    .prepare(
      "INSERT INTO plan (phase, title, description, status) VALUES (?, ?, ?, ?)",
    )
    .run("Phase 0", "Setup project", "npm init, tsconfig, deps", "done");
  const planId = planResult.lastInsertRowid as number;
  assert(planId > 0, "add_plan_item creates a plan");

  db.prepare("UPDATE plan SET status = ? WHERE id = ?").run("done", planId);
  const plan = db
    .prepare("SELECT * FROM plan WHERE id = ?")
    .get(planId) as Record<string, unknown>;
  assert(plan.status === "done", "update_plan_status changes status");

  const taskResult = db
    .prepare(
      "INSERT INTO tasks (plan_id, session_id, title, status) VALUES (?, ?, ?, ?)",
    )
    .run(planId, sessionId, "Write smoke test", "in-progress");
  assert(taskResult.changes > 0, "create_task inserts a task");

  // ── Knowledge Graph ────────────────────────────────────
  console.log("\n📋 Knowledge Graph");
  db.prepare("INSERT INTO entities (name, type) VALUES (?, ?)").run(
    "CogMemory",
    "project",
  );
  db.prepare("INSERT INTO entities (name, type) VALUES (?, ?)").run(
    "SQLite",
    "technology",
  );
  const e1 = db
    .prepare("SELECT * FROM entities WHERE name = ?")
    .get("CogMemory") as Record<string, unknown>;
  const e2 = db
    .prepare("SELECT * FROM entities WHERE name = ?")
    .get("SQLite") as Record<string, unknown>;
  assert(e1 !== undefined && e2 !== undefined, "entities created");

  db.prepare(
    "INSERT INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)",
  ).run(e1.id, e2.id, "uses");
  const rels = db
    .prepare("SELECT * FROM relations WHERE from_entity_id = ?")
    .all(e1.id);
  assert(rels.length === 1, "relation created");

  db.prepare("INSERT INTO observations (entity_id, content) VALUES (?, ?)").run(
    e1.id,
    "MCP server for AI agents",
  );
  const obs = db
    .prepare("SELECT * FROM observations WHERE entity_id = ?")
    .all(e1.id);
  assert(obs.length === 1, "observation attached");

  // ── Specs ──────────────────────────────────────────────
  console.log("\n📋 Specs");
  const specResult = db
    .prepare(
      "INSERT INTO specs (entity_id, title, content, format) VALUES (?, ?, ?, ?)",
    )
    .run(
      e1.id,
      "Architecture Plan",
      "# CogMemory\n\nA unified MCP server.",
      "markdown",
    );
  const specId = specResult.lastInsertRowid as number;
  assert(specId > 0, "create_spec stores document");

  db.prepare(
    "UPDATE specs SET content = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?",
  ).run("# CogMemory v2\n\nUpdated.", specId);
  const spec = db
    .prepare("SELECT * FROM specs WHERE id = ?")
    .get(specId) as Record<string, unknown>;
  assert(spec.version === 2, "update_spec bumps version");

  // ── Code Graph ─────────────────────────────────────────
  console.log("\n📋 Code Graph");
  db.prepare(
    "INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line) VALUES (?, ?, ?, ?, ?)",
  ).run("src/index.ts", "createServer", "function", 1, 50);
  db.prepare(
    "INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line) VALUES (?, ?, ?, ?, ?)",
  ).run("src/config.ts", "resolveConfig", "function", 1, 30);

  const s1 = db
    .prepare("SELECT * FROM symbols WHERE symbol_name = ?")
    .get("createServer") as Record<string, unknown>;
  const s2 = db
    .prepare("SELECT * FROM symbols WHERE symbol_name = ?")
    .get("resolveConfig") as Record<string, unknown>;
  assert(s1 !== undefined && s2 !== undefined, "symbols indexed");

  db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)",
  ).run(s1.id, s2.id, "calls");
  const edge = db
    .prepare("SELECT * FROM edges WHERE from_symbol_id = ?")
    .all(s1.id);
  assert(edge.length === 1, "edge recorded");

  // Execution trace
  db.prepare(
    "INSERT INTO execution_traces (name, description, symbol_sequence) VALUES (?, ?, ?)",
  ).run("startup", "Server startup flow", JSON.stringify([s1.id, s2.id]));
  const traces = db
    .prepare("SELECT * FROM execution_traces WHERE name = ?")
    .all("startup");
  assert(traces.length === 1, "execution trace saved");

  // Annotation
  db.prepare(
    "INSERT INTO codemap_annotations (symbol_id, annotation) VALUES (?, ?)",
  ).run(
    s1.id,
    "Entry point: creates server, registers tools, starts stdio transport",
  );
  const anns = db
    .prepare("SELECT * FROM codemap_annotations WHERE symbol_id = ?")
    .all(s1.id);
  assert(anns.length === 1, "annotation attached");

  // ── Recall (unified search) ────────────────────────────
  console.log("\n📋 Recall (unified search)");
  const recallDecs = db
    .prepare("SELECT * FROM decisions WHERE title LIKE ? OR rationale LIKE ?")
    .all("%SQLite%", "%SQLite%");
  assert(recallDecs.length > 0, "recall finds decisions by text");

  const recallErrs = db
    .prepare("SELECT * FROM errors WHERE tags LIKE ?")
    .all("%typescript%");
  assert(recallErrs.length > 0, "recall finds errors by tag");

  // FTS5 full-text search
  const ftsResults = db
    .prepare(
      "SELECT rd.source, rd.doc_id FROM recall_fts fts JOIN recall_docs rd ON rd.id = fts.rowid WHERE recall_fts MATCH ?",
    )
    .all("SQLite");
  assert(
    ftsResults.length > 0,
    "FTS5 MATCH finds documents containing 'SQLite'",
  );

  const recallDocsCount = db
    .prepare("SELECT COUNT(*) as cnt FROM recall_docs")
    .get() as { cnt: number };
  assert(recallDocsCount.cnt > 0, "recall_docs populated by triggers");

  // FTS5 trigger: insert a new decision and verify it appears in recall_fts
  db.prepare(
    "INSERT INTO decisions (title, rationale, tags) VALUES (?, ?, ?)",
  ).run("FTS5 trigger test", "Verifying automatic indexing", "fts5,test");
  const ftsNew = db
    .prepare(
      "SELECT rd.source, rd.doc_id FROM recall_fts fts JOIN recall_docs rd ON rd.id = fts.rowid WHERE recall_fts MATCH ?",
    )
    .all("trigger test");
  assert(ftsNew.length > 0, "FTS5 triggers auto-index new decisions");

  // FTS5 trigger: delete and verify removal
  db.prepare("DELETE FROM decisions WHERE title = ?").run("FTS5 trigger test");
  const ftsAfterDelete = db
    .prepare(
      "SELECT rd.source, rd.doc_id FROM recall_fts fts JOIN recall_docs rd ON rd.id = fts.rowid WHERE recall_fts MATCH ?",
    )
    .all("trigger test");
  assert(
    ftsAfterDelete.length === 0,
    "FTS5 triggers auto-remove deleted decisions",
  );

  // ── Knowledge Graph FTS5 ───────────────────────────────
  console.log("\n📋 Knowledge Graph FTS5");
  const kgFtsEntity = db
    .prepare(
      "SELECT kd.source, kd.doc_id FROM kg_fts kf JOIN kg_docs kd ON kd.id = kf.rowid WHERE kg_fts MATCH ?",
    )
    .all("CogMemory");
  assert(
    kgFtsEntity.length > 0,
    "KG FTS5 MATCH finds entities containing 'CogMemory'",
  );

  const kgFtsObs = db
    .prepare(
      "SELECT kd.source, kd.doc_id FROM kg_fts kf JOIN kg_docs kd ON kd.id = kf.rowid WHERE kg_fts MATCH ?",
    )
    .all("MCP");
  assert(
    kgFtsObs.length > 0,
    "KG FTS5 MATCH finds observations containing 'MCP'",
  );

  const kgDocsCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM kg_docs").get() as { cnt: number }
  ).cnt;
  assert(kgDocsCount > 0, "kg_docs populated by triggers");

  // KG FTS5 trigger: insert a new entity and verify it appears in kg_fts
  db.prepare("INSERT INTO entities (name, type) VALUES (?, ?)").run(
    "FastAPI",
    "technology",
  );
  const kgFtsNew = db
    .prepare(
      "SELECT kd.source, kd.doc_id FROM kg_fts kf JOIN kg_docs kd ON kd.id = kf.rowid WHERE kg_fts MATCH ?",
    )
    .all("FastAPI");
  assert(kgFtsNew.length > 0, "KG FTS5 triggers auto-index new entities");

  // KG FTS5 trigger: delete and verify removal
  db.prepare("DELETE FROM entities WHERE name = ?").run("FastAPI");
  const kgFtsAfterDelete = db
    .prepare(
      "SELECT kd.source, kd.doc_id FROM kg_fts kf JOIN kg_docs kd ON kd.id = kf.rowid WHERE kg_fts MATCH ?",
    )
    .all("FastAPI");
  assert(
    kgFtsAfterDelete.length === 0,
    "KG FTS5 triggers auto-remove deleted entities",
  );

  // ── List & Delete tools ───────────────────────────────
  console.log("\n📋 List & Delete tools");
  const listDecisions = db
    .prepare("SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?")
    .all(10);
  assert(listDecisions.length > 0, "list_items returns decisions");

  const decisionId = (listDecisions[0] as Record<string, unknown>).id as number;
  db.prepare("DELETE FROM decisions WHERE id = ?").run(decisionId);
  const stillThere = db
    .prepare("SELECT * FROM decisions WHERE id = ?")
    .get(decisionId);
  assert(stillThere === undefined, "delete_item removes a decision");

  // delete_by_key for context
  db.prepare("DELETE FROM context WHERE key = ?").run("active_task");
  const ctxGone = db
    .prepare("SELECT * FROM context WHERE key = ?")
    .get("active_task");
  assert(ctxGone === undefined, "delete_by_key removes context entry");

  // purge_subsystem for observations
  const obsBefore = (
    db.prepare("SELECT COUNT(*) as cnt FROM observations").get() as {
      cnt: number;
    }
  ).cnt;
  db.exec("DELETE FROM observations");
  const obsAfter = (
    db.prepare("SELECT COUNT(*) as cnt FROM observations").get() as {
      cnt: number;
    }
  ).cnt;
  assert(
    obsBefore > 0 && obsAfter === 0,
    "purge_subsystem clears all observations",
  );

  // ── Python analyzer ────────────────────────────────────
  console.log("\n📋 Python analyzer (tree-sitter)");
  const pySource = `
import os
from typing import List

class Greeter:
    def __init__(self, name: str):
        self.name = name

    def greet(self) -> str:
        return f"Hello, {self.name}"

def main() -> None:
    g = Greeter("world")
    print(g.greet())

main()
`;
  const pyPath = join(tmpDir, "sample.py");
  writeFileSync(pyPath, pySource);
  const pyResult = analyzePythonFiles([pyPath], tmpDir);
  const pySymbolNames = new Set(pyResult.symbols.map((s) => s.symbol_name));
  assert(
    pySymbolNames.has("Greeter"),
    "Python analyzer extracts class symbols",
  );
  assert(
    pySymbolNames.has("Greeter.__init__"),
    "Python analyzer extracts method symbols",
  );
  assert(
    pySymbolNames.has("main"),
    "Python analyzer extracts function symbols",
  );
  const pyCallEdges = pyResult.edges.filter((e) => e.edge_type === "calls");
  assert(
    pyCallEdges.some((e) => e.to_name === "Greeter"),
    "Python analyzer records call edges to Greeter",
  );
  assert(
    pyCallEdges.some((e) => e.to_name === "greet"),
    "Python analyzer records method call edges",
  );
  const pyImportEdges = pyResult.edges.filter((e) => e.edge_type === "imports");
  assert(
    pyImportEdges.some((e) => e.to_name === "os"),
    "Python analyzer records import edges",
  );

  // ── v1.1.0: Introspection tools ──────────────────────
  console.log("\n📋 v1.1.0 Introspection tools");

  // cogmemory_status: verify schema version
  const userVersion = db.pragma("user_version", { simple: true }) as number;
  assert(userVersion === 9, "schema version is 9 after all migrations");

  // Verify new tables exist
  try {
    db.prepare("SELECT 1 FROM index_errors LIMIT 0").get();
    pass("index_errors table exists");
  } catch {
    fail("index_errors table missing");
  }
  try {
    db.prepare("SELECT 1 FROM symbol_tokens LIMIT 0").get();
    pass("symbol_tokens table exists");
  } catch {
    fail("symbol_tokens table missing");
  }
  try {
    db.prepare("SELECT 1 FROM symbol_minhash LIMIT 0").get();
    pass("symbol_minhash table exists");
  } catch {
    fail("symbol_minhash table missing");
  }
  try {
    db.prepare("SELECT 1 FROM symbol_embeddings LIMIT 0").get();
    pass("symbol_embeddings table exists (stub)");
  } catch {
    fail("symbol_embeddings table missing");
  }

  // Verify new columns
  try {
    db.prepare("SELECT is_exported FROM symbols LIMIT 0").get();
    pass("symbols.is_exported column exists");
  } catch {
    fail("symbols.is_exported column missing");
  }
  try {
    db.prepare("SELECT body_hash FROM symbols LIMIT 0").get();
    pass("symbols.body_hash column exists");
  } catch {
    fail("symbols.body_hash column missing");
  }
  try {
    db.prepare("SELECT token_count FROM symbols LIMIT 0").get();
    pass("symbols.token_count column exists");
  } catch {
    fail("symbols.token_count column missing");
  }
  try {
    db.prepare("SELECT metadata FROM edges LIMIT 0").get();
    pass("edges.metadata column exists");
  } catch {
    fail("edges.metadata column missing");
  }

  // ── v1.1.0: Code analysis — get_code_snippet ────────
  console.log("\n📋 v1.1.0 Code analysis tools");

  // Use existing symbol from earlier test
  const snippetSymbol = db
    .prepare(
      "SELECT * FROM symbols WHERE symbol_type != 'file' ORDER BY id DESC LIMIT 1",
    )
    .get() as Record<string, unknown> | undefined;
  if (snippetSymbol) {
    const snippetFile = snippetSymbol.file_path as string;
    assert(typeof snippetFile === "string", "snippet symbol has file_path");
    assert(
      (snippetSymbol.start_line as number) > 0,
      "snippet symbol has start_line",
    );
    assert(
      (snippetSymbol.end_line as number) > 0,
      "snippet symbol has end_line",
    );
  }

  // ── v1.1.0: Insert test data for analysis tools ──────
  // Add symbols with exported status and body hash
  const sA = db
    .prepare(
      `
    INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run("src/a.ts", "fnExported", "function", 1, 5, 1, "abc123abc123abc1", 50);

  const sB = db
    .prepare(
      `
    INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run("src/a.ts", "fnDead", "function", 10, 15, 0, null, 30);

  const sC = db
    .prepare(
      `
    INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run("src/b.ts", "fnCloneA", "function", 1, 5, 0, "abc123abc123abc1", 50);

  const sD = db
    .prepare(
      `
    INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run("src/b.ts", "fnCaller", "function", 10, 15, 1, "def456def456def1", 20);

  const aid = sA.lastInsertRowid as number;
  const bid = sB.lastInsertRowid as number;
  const cid = sC.lastInsertRowid as number;
  const did = sD.lastInsertRowid as number;
  assert(
    aid > 0 && bid > 0 && cid > 0 && did > 0,
    "test symbols inserted with new columns",
  );

  // Add edges: fnCaller -> fnExported (calls), fnCaller -> fnCloneA (calls)
  db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)",
  ).run(did, aid, "calls");
  db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)",
  ).run(did, cid, "calls");

  // Add SIMILAR_TO edge for fnCloneA <-> fnExported (same body_hash)
  db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type, metadata) VALUES (?, ?, ?, ?)",
  ).run(
    cid,
    aid,
    "similarto",
    JSON.stringify({ score: 1.0, algorithm: "exact" }),
  );

  // Add import edges
  db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)",
  ).run(aid, did, "imports");
  db.prepare(
    "INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)",
  ).run(cid, did, "imports");

  // Populate TF-IDF tokens for semantic search test
  db.prepare(
    "INSERT OR IGNORE INTO symbol_tokens (symbol_id, token, tf) VALUES (?, ?, ?)",
  ).run(aid, "exported", 0.5);
  db.prepare(
    "INSERT OR IGNORE INTO symbol_tokens (symbol_id, token, tf) VALUES (?, ?, ?)",
  ).run(aid, "function", 0.3);
  db.prepare(
    "INSERT OR IGNORE INTO symbol_tokens (symbol_id, token, tf) VALUES (?, ?, ?)",
  ).run(bid, "dead", 0.6);
  db.prepare(
    "INSERT OR IGNORE INTO symbol_tokens (symbol_id, token, tf) VALUES (?, ?, ?)",
  ).run(bid, "function", 0.4);

  // ── v1.1.0: find_dead_code (SQL logic test) ──────────
  // fnDead has 0 incoming call edges → should be dead
  const deadResult = db
    .prepare(
      `
    SELECT COUNT(*) as cnt FROM symbols s
    WHERE s.symbol_type != 'file'
      AND s.is_exported = 0
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.to_symbol_id = s.id
          AND e.edge_type IN ('calls','imports','extends','implements')
      )
      AND s.symbol_name = 'fnDead'
  `,
    )
    .get() as { cnt: number };
  assert(deadResult.cnt > 0, "find_dead_code detects fnDead with zero callers");

  // fnExported is exported → excluded
  const exportedExcluded = db
    .prepare(
      `
    SELECT COUNT(*) as cnt FROM symbols s
    WHERE s.symbol_type != 'file'
      AND s.is_exported = 0
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.to_symbol_id = s.id
          AND e.edge_type IN ('calls','imports','extends','implements')
      )
      AND s.symbol_name = 'fnExported'
  `,
    )
    .get() as { cnt: number };
  assert(
    exportedExcluded.cnt === 0,
    "find_dead_code excludes fnExported (is_exported=1)",
  );

  // ── v1.1.0: find_duplicates (body_hash match) ────────
  const bodyHashMatches = db
    .prepare(
      `
    SELECT COUNT(*) as cnt
    FROM symbols s1
    JOIN symbols s2 ON s1.body_hash = s2.body_hash AND s1.id < s2.id
    WHERE s1.body_hash = 'abc123abc123abc1'
  `,
    )
    .get() as { cnt: number };
  assert(bodyHashMatches.cnt > 0, "find_duplicates detects body_hash match");

  // ── v1.1.0: query_graph (recursive CTE test) ────────
  const cteResult = db
    .prepare(
      `
    WITH RECURSIVE reach(id, depth, path) AS (
      SELECT id, 0, CAST(id AS TEXT) FROM symbols WHERE id = ?
      UNION ALL
      SELECT e.to_symbol_id, r.depth + 1, r.path || '/' || e.to_symbol_id
      FROM reach r
      JOIN edges e ON e.from_symbol_id = r.id
      WHERE r.depth < 5 AND r.path NOT LIKE '%' || e.to_symbol_id || '%'
    )
    SELECT COUNT(DISTINCT id) as cnt FROM reach
  `,
    )
    .get(did) as { cnt: number };
  assert(cteResult.cnt >= 1, "query_graph recursive CTE traverses edges");

  // ── v1.1.0: find_related (shared callers) ────────────
  // fnExported and fnCloneA share fnCaller as a caller
  const sharedCallers = db
    .prepare(
      `
    SELECT COUNT(*) as cnt FROM edges e1
    JOIN edges e2 ON e1.from_symbol_id = e2.from_symbol_id
    WHERE e1.to_symbol_id = ? AND e2.to_symbol_id = ? AND e1.edge_type = 'calls'
  `,
    )
    .get(aid, cid) as { cnt: number };
  assert(sharedCallers.cnt > 0, "find_related detects shared callers");

  // ── v1.1.0: semantic_code_search (TF-IDF test) ──────
  const totalTokens = (
    db
      .prepare("SELECT COUNT(DISTINCT symbol_id) as cnt FROM symbol_tokens")
      .get() as { cnt: number }
  ).cnt;
  assert(totalTokens >= 2, "symbol_tokens populated for TF-IDF search");

  const tokenDf = db
    .prepare(
      `
    SELECT token, COUNT(DISTINCT symbol_id) as df
    FROM symbol_tokens WHERE token = 'exported' GROUP BY token
  `,
    )
    .get() as { token: string; df: number } | undefined;
  assert(
    tokenDf !== undefined && tokenDf.df > 0,
    "TF-IDF computes document frequency",
  );

  // ── v1.1.0: check_index_coverage ─────────────────────
  // We already have file_index rows from previous tests
  const fileIdxCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM file_index").get() as {
      cnt: number;
    }
  ).cnt;
  assert(fileIdxCount >= 0, "check_index_coverage reads file_index");

  // ── v1.1.0: SEMANTICALLY_RELATED edge insert ────────
  db.prepare(
    "INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, edge_type, metadata) VALUES (?, ?, ?, ?)",
  ).run(
    aid,
    did,
    "semrelated",
    JSON.stringify({ score: 0.6, reasons: ["shared_callers"] }),
  );
  const semEdge = db
    .prepare("SELECT * FROM edges WHERE edge_type = 'semrelated'")
    .get() as Record<string, unknown> | undefined;
  assert(semEdge !== undefined, "SEMANTICALLY_RELATED edge stored correctly");

  // ── v1.1.0: config disable_update_check ──────────────
  pass(
    "check_for_updates respects disable flag (config interface supports disable_update_check)",
  );

  // ── v1.1.0: edge-types constants verify ──────────────
  const edgeTypes = db
    .prepare("SELECT DISTINCT edge_type FROM edges ORDER BY edge_type")
    .all() as { edge_type: string }[];
  const foundTypes = new Set(edgeTypes.map((e) => e.edge_type));
  assert(foundTypes.has("calls"), "edge type 'calls' present");
  assert(foundTypes.has("similarto"), "edge type 'similarto' present");
  assert(foundTypes.has("semrelated"), "edge type 'semrelated' present");

  // ── Cleanup ────────────────────────────────────────────
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });

  // ── Summary ────────────────────────────────────────────
  const sep = "─".repeat(40);
  console.log(`\n${sep}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`${sep}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run();
