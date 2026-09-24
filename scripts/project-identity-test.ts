// Regression tests use temporary storage and real MCP request validation.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { withFileLock } from "../src/file-lock.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProjectRuntime } from "../src/active-project.js";
import { openDatabase, closeDatabase } from "../src/db/connection.js";
import { resolveWorkspaceRoot } from "../src/config.js";
import { MAX_VERSION } from "../src/db/migration-runner.js";
import { registerSessionTools } from "../src/tools/sessions.js";
import { registerMemoryTools } from "../src/tools/memory.js";
import { registerPlanTasksTools } from "../src/tools/plan-tasks.js";
import { registerProjectTools } from "../src/tools/projects.js";
import { registerIntrospectionTools } from "../src/tools/introspection.js";
import { registerCodeAnalysisTools } from "../src/tools/code-analysis.js";
import { registerCodeGraphTools } from "../src/tools/code-graph.js";
import { registerListDeleteTools } from "../src/tools/list-delete.js";
import { registerKnowledgeGraphTools } from "../src/tools/knowledge-graph.js";
import { registerSpecsTools } from "../src/tools/specs.js";
import { registerCodemapTools } from "../src/tools/codemap.js";

if (process.argv[2] === "--worker") {
  const runtime = new ProjectRuntime(process.argv[3], "override", process.argv[4]);
  const { db, projectId, slug, dbPath } = runtime.current;
  db.prepare("INSERT INTO decisions (project_id, title) VALUES (?, ?)").run(projectId, process.argv[5]);
  console.log(JSON.stringify({ projectId, slug, dbPath }));
  closeDatabase();
} else {
  await main();
}

async function main() {
  const temporary = mkdtempSync(join(tmpdir(), "cogmemory-identity-"));
  const dataDir = join(temporary, "data");
  mkdirSync(dataDir);
  let count = 0;
  const project = (name: string, scope = "project") => {
    const root = join(temporary, name);
    mkdirSync(join(root, ".cogmemory"), { recursive: true });
    writeFileSync(join(root, ".cogmemory/config.json"), JSON.stringify({ scope, disable_update_check: true, custom_setting: "preserved" }));
    return root;
  };
  const config = (root: string) => JSON.parse(readFileSync(join(root, ".cogmemory/config.json"), "utf8"));
  const saveConfig = (root: string, value: object) => writeFileSync(join(root, ".cogmemory/config.json"), JSON.stringify(value));
  const runtime = (root: string) => new ProjectRuntime(root, "override", dataDir);
  async function test(name: string, work: () => void | Promise<void>) {
    try { await work(); count++; console.log(`PASS ${name}`); }
    finally { closeDatabase(); }
  }
  async function mcp(state: ProjectRuntime) {
    const server = new McpServer({ name: "identity-test", version: "1.0.0" });
    for (const register of [registerSessionTools, registerMemoryTools, registerPlanTasksTools, registerProjectTools,
      registerIntrospectionTools, registerCodeAnalysisTools, registerCodeGraphTools, registerListDeleteTools,
      registerKnowledgeGraphTools, registerSpecsTools, registerCodemapTools]) register(server, state);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-chat", version: "1.0.0" });
    await client.connect(clientTransport);
    return {
      client,
      call: async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as Array<{ type: string; text: string }>;
        return JSON.parse(content[0].text);
      },
      close: async () => { await client.close(); await server.close(); },
    };
  }
  const fixture = (root: string, slug: string, databaseId: string, value: string) => {
    mkdirSync(join(dataDir, "projects"), { recursive: true });
    const dbPath = join(dataDir, "projects", `memory-${databaseId}.db`);
    const db = openDatabase(dbPath);
    const result = db.prepare("INSERT INTO projects (slug, label, root_path_hint) VALUES (?, ?, ?)").run(slug, basename(root), root);
    db.prepare("INSERT INTO context (project_id, key, value) VALUES (?, 'proof', ?)").run(result.lastInsertRowid, value);
    closeDatabase(db);
    return dbPath;
  };
  try {
    await test("fresh startup, restart, and separate chat runtimes preserve UUID, row ID, database and memory", async () => {
      const root = project("restart");
      const first = runtime(root);
      const saved = { slug: first.current.slug, id: first.current.projectId, path: first.current.dbPath };
      const chat = await mcp(first);
      const session = await chat.call("start_session");
      await chat.call("remember_decision", { title: "persist me", session_id: session.id });
      await chat.close();
      closeDatabase();
      const second = runtime(root);
      assert.equal(second.current.slug, saved.slug);
      assert.equal(second.current.projectId, saved.id);
      assert.equal(second.current.dbPath, saved.path);
      assert.equal(basename(saved.path), `memory-${saved.slug}.db`);
      const branch = await mcp(second);
      const recalled = await branch.call("get_session_summary", { id: session.id });
      assert.equal(recalled.decisions[0].title, "persist me");
      assert.equal((await branch.call("log_change", { summary: "branched", session_id: session.id })).success, true);
      assert.equal(config(root).custom_setting, "preserved");
      await branch.close();
    });

    await test("simultaneous processes converge from settings-only config and retain every write", async () => {
      const root = project("concurrent");
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", root, dataDir, `worker-${i}`], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", data => stdout += data);
        child.stderr.on("data", data => stderr += data);
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
      })));
      const identities = results.map(result => { assert.equal(result.status, "fulfilled"); return JSON.parse((result as PromiseFulfilledResult<string>).value); });
      assert.equal(new Set(identities.map(row => row.slug)).size, 1);
      assert.equal(new Set(identities.map(row => row.dbPath)).size, 1);
      const current = runtime(root).current;
      assert.equal((current.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE project_id = ?").get(current.projectId) as { n: number }).n, 6);
    });

    await test("unique old UUID drift recovers the existing database without renaming or losing rows", () => {
      const root = project("old-drift");
      const filenameSlug = randomUUID(), rowSlug = randomUUID();
      const path = fixture(root, rowSlug, filenameSlug, "old memory");
      saveConfig(root, { ...config(root), project_id: rowSlug });
      const active = runtime(root).current;
      assert.equal(active.dbPath, path);
      assert.equal(active.slug, rowSlug);
      assert.equal(config(root).project_database_id, filenameSlug);
      assert.equal((active.db.prepare("SELECT value FROM context WHERE project_id = ?").get(active.projectId) as { value: string }).value, "old memory");
      assert.equal(readdirSync(join(dataDir, "projects")).includes(`memory-${rowSlug}.db`), false);
    });

    await test("ambiguous historic databases remain untouched until an explicit pair is selected", () => {
      const root = project("ambiguous");
      const firstId = randomUUID(), secondId = randomUUID(), firstSlug = randomUUID(), secondSlug = randomUUID();
      fixture(root, firstSlug, firstId, "first");
      fixture(root, secondSlug, secondId, "second");
      const before = readFileSync(join(root, ".cogmemory/config.json"), "utf8");
      assert.throws(() => runtime(root), /PROJECT_IDENTITY_AMBIGUOUS/);
      assert.equal(readFileSync(join(root, ".cogmemory/config.json"), "utf8"), before);
      saveConfig(root, { scope: "project", project_id: firstSlug, project_database_id: firstId });
      const active = runtime(root).current;
      assert.equal(active.slug, firstSlug);
      assert.equal((active.db.prepare("SELECT value FROM context WHERE project_id = ?").get(active.projectId) as { value: string }).value, "first");
    });

    await test("deleted config recovers a unique stored identity", () => {
      const root = project("missing-config");
      const first = runtime(root).current;
      rmSync(join(root, ".cogmemory/config.json"));
      const second = runtime(root).current;
      assert.equal(second.slug, first.slug);
      assert.equal(second.dbPath, first.dbPath);
    });

    await test("moves and symlinks preserve UUID and database", () => {
      const root = project("before-move");
      const first = runtime(root).current;
      closeDatabase();
      const moved = join(temporary, "after-move");
      renameSync(root, moved);
      const second = runtime(moved).current;
      assert.equal(second.slug, first.slug);
      assert.equal(second.dbPath, first.dbPath);
      const alias = join(temporary, "alias");
      symlinkSync(moved, alias);
      assert.equal(runtime(alias).current.workspaceRoot, moved);
    });

    await test("invalid JSON and UUID config are preserved, without creating a replacement identity", () => {
      const root = project("invalid");
      for (const raw of ['{broken', '{"project_id":"wrong"}', 'null', '{"scope":"typo"}']) {
        writeFileSync(join(root, ".cogmemory/config.json"), raw);
        assert.throws(() => runtime(root), /PROJECT_CONFIG_INVALID/);
        assert.equal(readFileSync(join(root, ".cogmemory/config.json"), "utf8"), raw);
      }
      assert.throws(() => resolveWorkspaceRoot(["--workspace", join(temporary, "missing")]), /ENOENT/);
      assert.throws(() => resolveWorkspaceRoot(["--workspace"]), /requires/);
    });

    await test("MCP switching changes database, root, status, indexing and subsequent memory writes", async () => {
      const a = project("switch-a"), b = project("switch-b");
      writeFileSync(join(a, "example.ts"), 'export const origin = "a";');
      writeFileSync(join(b, "example.ts"), 'export const origin = "b";');
      const state = runtime(a);
      const chat = await mcp(state);
      await chat.call("set_active_context", { key: "origin", value: "a" });
      const original = state.current;
      const switched = await chat.call("switch_project", { root_dir: b });
      assert.equal(switched.success, true);
      assert.notEqual(switched.project.slug, original.slug);
      assert.notEqual(switched.db_path, original.dbPath);
      const status = await chat.call("cogmemory_status");
      assert.equal(status.workspace_root, b);
      assert.equal(status.resolution_source, "runtime-switch");
      assert.equal((await chat.call("get_active_context", { key: "origin" })).value, null);
      await chat.call("set_active_context", { key: "origin", value: "b" });
      const indexed = await chat.call("index_codebase", { extensions: ["ts"] });
      assert.notEqual(indexed.success, false, JSON.stringify(indexed));
      const snippet = await chat.call("get_code_snippet", { symbol_name: "origin" });
      assert.equal(snippet.content, 'export const origin = "b";');
      await chat.call("switch_project", { root_dir: a });
      assert.equal((await chat.call("get_active_context", { key: "origin" })).value, "a");
      await chat.close();
    });

    await test("failed target paths, configs and migrations leave previous memory usable", async () => {
      const a = project("failure-a"), b = project("failure-b", "workspace");
      const state = runtime(a);
      const chat = await mcp(state);
      const before = state.current;
      assert.equal((await chat.call("switch_project", { root_dir: join(temporary, "absent") })).success, false);
      saveConfig(b, { project_id: "invalid" });
      assert.equal((await chat.call("switch_project", { root_dir: b })).success, false);
      saveConfig(b, { scope: "workspace" });
      const db = openDatabase(join(b, ".cogmemory/memory.db"));
      db.pragma(`user_version = ${MAX_VERSION + 1}`);
      closeDatabase(db);
      assert.equal((await chat.call("switch_project", { root_dir: b })).success, false);
      assert.equal(state.current, before);
      assert.equal((await chat.call("log_change", { summary: "still usable" })).success, true);
      await chat.close();
    });

    await test("global/project/workspace transitions and stale session/plan references are isolated", async () => {
      const a = project("global-a", "global"), b = project("global-b", "global");
      const state = runtime(a);
      const chat = await mcp(state);
      const oldSession = await chat.call("start_session");
      const oldPlan = await chat.call("add_plan_item", { title: "a plan" });
      await chat.call("switch_project", { root_dir: b });
      assert.equal((await chat.call("get_session_summary", { id: oldSession.id })).success, false);
      assert.equal((await chat.call("end_session", { id: oldSession.id })).success, false);
      const task = await chat.call("create_task", { title: "b task", session_id: oldSession.id, plan_id: oldPlan.id });
      assert.equal(task.success, true);
      assert.equal(task.warnings.length, 2);
      const stored = state.current.db.prepare("SELECT session_id, plan_id FROM tasks WHERE id = ?").get(task.id);
      assert.deepEqual(stored, { session_id: null, plan_id: null });
      const missing = await chat.call("remember_decision", { title: "save despite stale session", session_id: 999999 });
      assert.equal(missing.success, true);
      assert.equal(missing.warnings.length, 1);
      await chat.call("switch_project", { root_dir: project("workspace-target", "workspace") });
      assert.equal((await chat.call("cogmemory_status")).scope, "workspace");
      await chat.call("switch_project", { root_dir: project("project-target") });
      assert.equal((await chat.call("cogmemory_status")).scope, "project");
      await chat.call("switch_project", { root_dir: a });
      assert.equal((await chat.call("get_session_summary", { id: oldSession.id })).session.ended_at, null);
      await chat.close();
    });

    await test("optional UUID guard rejects cached IDs even when numeric project IDs collide", async () => {
      const a = project("guard-a"), b = project("guard-b");
      const state = runtime(a);
      const first = state.current;
      const chat = await mcp(state);
      const tools = await chat.client.listTools();
      assert(tools.tools.every(tool => tool.inputSchema.properties?.expected_project_id));
      await chat.call("switch_project", { root_dir: b });
      assert.equal(state.current.projectId, first.projectId);
      const blocked = await chat.call("log_change", { summary: "must not save", expected_project_id: first.slug });
      assert.equal(blocked.code, "PROJECT_MISMATCH");
      assert.equal((state.current.db.prepare("SELECT COUNT(*) AS n FROM changelog").get() as { n: number }).n, 0);
      const valid = await chat.call("log_change", { summary: "valid", expected_project_id: state.current.slug });
      assert.equal(valid.success, true);
      await chat.close();
    });

    await test("in-flight asynchronous calls finish against their original context after switching", async () => {
      const a = project("inflight-a"), b = project("inflight-b");
      const state = runtime(a);
      const original = state.current;
      let release!: () => void;
      const gate = new Promise<void>(resolve => release = resolve);
      const pending = state.run("delayed", async context => {
        await gate;
        context.db.prepare("INSERT INTO changelog (project_id, summary) VALUES (?, 'late result')").run(context.projectId);
        return context.slug;
      });
      state.switchTo(b);
      assert.equal(original.db.open, true);
      release();
      assert.equal(await pending, original.slug);
      assert.equal(original.db.open, false);
      assert.equal((state.current.db.prepare("SELECT COUNT(*) AS n FROM changelog").get() as { n: number }).n, 0);
      state.switchTo(a);
      assert.equal((state.current.db.prepare("SELECT summary FROM changelog").get() as { summary: string }).summary, "late result");
    });
    await test("completely fresh workspace converges without a pre-existing config", () => {
      const root = join(temporary, "no-config");
      mkdirSync(root);
      const first = runtime(root).current;
      const second = runtime(root).current;
      assert.equal(second.slug, first.slug);
      assert.equal(config(root).project_id, first.slug);
    });

    await test("selected database with unrelated identities is rejected without inserting a new project", () => {
      const root = project("wrong-database"), other = project("actual-owner");
      const selected = randomUUID(), actual = randomUUID();
      const dbPath = fixture(other, actual, selected, "other project memory");
      saveConfig(root, { scope: "project", project_id: selected });
      assert.throws(() => runtime(root), /PROJECT_IDENTITY_MISMATCH/);
      const db = new Database(dbPath, { readonly: true });
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM projects WHERE slug = ?").get(selected) as { n: number }).n, 0);
      } finally { db.close(); }
    });

    await test("SQL migration errors preserve a running project's connection", async () => {
      const a = project("migration-a"), b = project("migration-b", "workspace");
      const broken = new Database(join(b, ".cogmemory/memory.db"));
      broken.pragma("user_version = 8"); // Missing v8 tables forces migration 009 to fail.
      broken.close();
      const state = runtime(a);
      const previous = state.current;
      const chat = await mcp(state);
      const result = await chat.call("switch_project", { root_dir: b });
      assert.equal(result.success, false);
      assert.equal(state.current, previous);
      assert.equal((await chat.call("log_change", { summary: "after migration failure" })).success, true);
      await chat.close();
    });

    await test("abandoned initialization locks time out with recovery guidance and preserve config", () => {
      const root = project("abandoned-lock");
      const path = join(root, ".cogmemory/identity.lock");
      mkdirSync(path);
      const before = readFileSync(join(root, ".cogmemory/config.json"), "utf8");
      assert.throws(() => withFileLock(path, () => assert.fail("lock must not be stolen"), 1), /PROJECT_BUSY/);
      assert.equal(readFileSync(join(root, ".cogmemory/config.json"), "utf8"), before);
      rmSync(path, { recursive: true });
      assert(runtime(root).current.slug);
    });

    await test("runtime detects config changes and binds subsequent requests to recovered state", async () => {
      const root = project("changed-binding");
      const state = runtime(root);
      const chat = await mcp(state);
      const previous = state.current;
      saveConfig(root, { ...config(root), project_id: randomUUID() });
      // Root-based recovery finds the existing store rather than creating empty memory.
      assert.equal((await chat.call("log_change", { summary: "after binding drift" })).success, true);
      assert.equal(state.current.slug, previous.slug);
      assert.equal(state.current.dbPath, previous.dbPath);
      assert.equal(config(root).project_id, previous.slug);
      await chat.close();
    });
    await test("global scope recovers a lost UUID from an unambiguous stored root", () => {
      const root = project("global-recovery", "global");
      const first = runtime(root).current;
      saveConfig(root, { scope: "global" });
      const second = runtime(root).current;
      assert.equal(second.slug, first.slug);
      assert.equal(second.projectId, first.projectId);
    });
    console.log(`\n${count} identity regression scenarios passed.`);
  } finally {
    closeDatabase();
    rmSync(temporary, { recursive: true, force: true });
  }
}
