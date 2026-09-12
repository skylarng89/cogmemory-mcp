#!/usr/bin/env node
// CogMemory MCP — Entry point

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./version.js";
import {
  resolveConfig,
  resolveWorkspaceRoot,
  resolveProjectIdentity,
} from "./config.js";
import { createActiveProjectRef } from "./active-project.js";
import { openDatabase, closeDatabase } from "./db/connection.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerPlanTasksTools } from "./tools/plan-tasks.js";
import { registerKnowledgeGraphTools } from "./tools/knowledge-graph.js";
import { registerSpecsTools } from "./tools/specs.js";
import { registerCodeGraphTools } from "./tools/code-graph.js";
import { registerCodemapTools } from "./tools/codemap.js";
import { registerListDeleteTools } from "./tools/list-delete.js";
import { registerIntrospectionTools } from "./tools/introspection.js";
import { registerCodeAnalysisTools } from "./tools/code-analysis.js";
import { registerProjectTools } from "./tools/projects.js";
import { runStartupUpdateCheck } from "./update-check.js";
import { SchemaVersionError } from "./db/migration-runner.js";

async function main(): Promise<void> {
  // Resolve workspace root and config (git-root discovery is the default
  // signal; explicit --workspace / COGMEMORY_WORKSPACE still wins — ADR-7)
  const { root: workspaceRoot, source: resolutionSource } =
    resolveWorkspaceRoot(process.argv);
  const config = resolveConfig(workspaceRoot);

  // Lightweight update check (fail-safe, stderr-only, 24h interval cache).
  // Runs before the DB opens so the notification prints ahead of migration logs.
  runStartupUpdateCheck(workspaceRoot);

  // Open database (runs migration on first open)
  const db = openDatabase(config.dbPath);

  // Resolve project identity (slug in .cogmemory/config.json + projects table row)
  const project = resolveProjectIdentity(workspaceRoot, db, config.scope);
  const activeProject = createActiveProjectRef(project.projectId);

  // Ensure cleanup on exit
  process.on("SIGINT", () => {
    closeDatabase();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeDatabase();
    process.exit(0);
  });

  // Create MCP server
  const server = new McpServer({
    name: "cogmemory",
    version: VERSION,
  });

  // Register all tools (every tool reads the active project ref at call time)
  registerSessionTools(server, db, activeProject);
  registerMemoryTools(server, db, activeProject);
  registerPlanTasksTools(server, db, activeProject);
  registerKnowledgeGraphTools(server, db, activeProject);
  registerSpecsTools(server, db, activeProject);
  registerCodeGraphTools(server, db, workspaceRoot, activeProject);
  registerCodemapTools(server, db, activeProject);
  registerListDeleteTools(server, db, activeProject);
  registerIntrospectionTools(
    server,
    db,
    workspaceRoot,
    activeProject,
    resolutionSource,
    config.scope,
  );
  registerCodeAnalysisTools(server, db, workspaceRoot, activeProject);
  registerProjectTools(
    server,
    db,
    activeProject,
    workspaceRoot,
    config.scope,
    resolutionSource,
  );

  // Log to stderr (stdio transport uses stdout for protocol)
  console.error(
    `CogMemory MCP server v${VERSION} running on stdio (${config.scope} scope → ${config.dbPath}, project ${project.label} [${project.slug.slice(0, 8)}…], workspace root ${workspaceRoot} via ${resolutionSource})`,
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

try {
  await main();
} catch (err) {
  if (err instanceof SchemaVersionError) {
    // Downgrade protection: DB was written by a newer CogMemory build.
    console.error(`[cogmemory] ${err.message}`);
  } else {
    console.error("Fatal error:", err);
  }
  closeDatabase();
  process.exit(1);
}
