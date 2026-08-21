// CogMemory MCP — Smoke test script
// Runs all tools against a temporary database to verify basic functionality.

import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";

const tmpDir = mkdtempSync(join(tmpdir(), "cogmemory-test-"));
const dbPath = join(tmpDir, "test.db");

console.log(`\n🧪 CogMemory Smoke Test`);
console.log(`   DB: ${dbPath}\n`);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function run() {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

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
     ON CONFLICT(category, key) DO UPDATE SET value = excluded.value`,
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
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
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

  // ── Cleanup ────────────────────────────────────────────
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });

  // ── Summary ────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`${"─".repeat(40)}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run();
