#!/usr/bin/env node
// CogMemory MCP — Entry point

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig, resolveWorkspaceRoot } from "./config.js";
import { openDatabase, closeDatabase } from "./db/connection.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerPlanTasksTools } from "./tools/plan-tasks.js";
import { registerKnowledgeGraphTools } from "./tools/knowledge-graph.js";
import { registerSpecsTools } from "./tools/specs.js";
import { registerCodeGraphTools } from "./tools/code-graph.js";
import { registerCodemapTools } from "./tools/codemap.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  // Resolve workspace root and config
  const workspaceRoot = resolveWorkspaceRoot(process.argv);
  const config = resolveConfig(workspaceRoot);

  // Open database (runs migration on first open)
  const db = openDatabase(config.dbPath);

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

  // Register all tools
  registerSessionTools(server, db);
  registerMemoryTools(server, db);
  registerPlanTasksTools(server, db);
  registerKnowledgeGraphTools(server, db);
  registerSpecsTools(server, db);
  registerCodeGraphTools(server, db, workspaceRoot);
  registerCodemapTools(server, db);

  // Log to stderr (stdio transport uses stdout for protocol)
  console.error(
    `CogMemory MCP server v${VERSION} running on stdio (${config.scope} scope → ${config.dbPath})`,
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  closeDatabase();
  process.exit(1);
});
