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

async function main(): Promise<void> {
  // Resolve workspace root and config
  const workspaceRoot = resolveWorkspaceRoot(process.argv);
  const config = resolveConfig(workspaceRoot);

  // Open database (runs migration on first open)
  const db = openDatabase(config.dbPath);

  // Resolve project identity (slug in .cogmemory/config.json + projects table row)
  const project = resolveProjectIdentity(workspaceRoot, db, config.scope);
  const projectId = project.projectId;

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

  // Register all tools (every tool is scoped to the active project)
  registerSessionTools(server, db, projectId);
  registerMemoryTools(server, db, projectId);
  registerPlanTasksTools(server, db, projectId);
  registerKnowledgeGraphTools(server, db, projectId);
  registerSpecsTools(server, db, projectId);
  registerCodeGraphTools(server, db, workspaceRoot, projectId);
  registerCodemapTools(server, db, projectId);
  registerListDeleteTools(server, db, projectId);
  registerIntrospectionTools(server, db, workspaceRoot, project);
  registerCodeAnalysisTools(server, db, workspaceRoot, projectId);
  registerProjectTools(server, db, projectId);

  // Log to stderr (stdio transport uses stdout for protocol)
  console.error(
    `CogMemory MCP server v${VERSION} running on stdio (${config.scope} scope → ${config.dbPath}, project ${project.label} [${project.slug.slice(0, 8)}…])`,
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

try {
  await main();
} catch (err) {
  console.error("Fatal error:", err);
  closeDatabase();
  process.exit(1);
}
