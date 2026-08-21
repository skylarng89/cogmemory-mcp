// CogMemory MCP — Code Graph tools: index_codebase, query_code_graph

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { walkFiles } from "../indexing/walker.js";
import { analyzeFiles } from "../indexing/ts-analyzer.js";
import { resolve } from "node:path";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const IndexCodebaseSchema = z.object({
  root_dir: z
    .string()
    .optional()
    .describe("Root directory to index (default: workspace root from config)"),
  extensions: z
    .array(z.string())
    .optional()
    .describe("File extensions to index (default: ['ts','tsx','js','jsx'])"),
});

export const QueryCodeGraphSchema = z
  .object({
    symbol_name: z
      .string()
      .optional()
      .describe("Symbol name to look up (exact match)"),
    symbol_id: z.number().int().optional().describe("Symbol ID to look up"),
    file_path: z
      .string()
      .optional()
      .describe("File path to list all symbols in"),
  })
  .refine(
    (data) =>
      data.symbol_name !== undefined ||
      data.symbol_id !== undefined ||
      data.file_path !== undefined,
    {
      message:
        "At least one of symbol_name, symbol_id, or file_path must be provided",
    },
  );

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerCodeGraphTools(
  server: McpServer,
  db: Database.Database,
  workspaceRoot: string,
): void {
  // ── index_codebase ──
  server.registerTool(
    "index_codebase",
    {
      description:
        "Walk the workspace and extract symbols + edges via ts-morph (JS/TS). Replaces previous index entirely.",
      inputSchema: IndexCodebaseSchema,
    },
    async ({ root_dir, extensions }) => {
      const targetDir = resolve(root_dir ?? workspaceRoot);
      const exts = extensions ?? ["ts", "tsx", "js", "jsx"];

      try {
        // Step 1: Walk files
        const files = walkFiles(targetDir, { extensions: exts });

        if (files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "No matching files found",
                  files: 0,
                  symbols: 0,
                  edges: 0,
                }),
              },
            ],
          };
        }

        // Step 2: Analyze
        const result = analyzeFiles(files, targetDir);

        // Step 3: Clear existing index and re-insert
        db.exec("DELETE FROM edges");
        db.exec("DELETE FROM symbols");

        // Step 4: Insert symbols
        const insertSymbol = db.prepare(`
          INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line)
          VALUES (?, ?, ?, ?, ?)
        `);

        const symbolIdMap = new Map<string, number>();

        const insertSymbols = db.transaction(() => {
          for (const sym of result.symbols) {
            const r = insertSymbol.run(
              sym.file_path,
              sym.symbol_name,
              sym.symbol_type,
              sym.start_line,
              sym.end_line,
            );
            const id = r.lastInsertRowid as number;
            const key = `${sym.file_path}:${sym.symbol_name}:${sym.start_line}`;
            symbolIdMap.set(key, id);
          }
        });
        insertSymbols();

        // Step 5: Insert edges
        const insertEdge = db.prepare(`
          INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type)
          VALUES (?, ?, ?)
        `);

        let edgeCount = 0;
        const insertEdges = db.transaction(() => {
          for (const edge of result.edges) {
            // Try to resolve symbol IDs
            const fromKey = `${edge.from_file}:${edge.from_name}:${edge.from_start_line}`;
            const toKey = `${edge.to_file}:${edge.to_name}:${edge.to_start_line}`;

            let fromId = symbolIdMap.get(fromKey);
            let toId = symbolIdMap.get(toKey);

            // Fallback: try to find by name only
            if (!fromId) {
              for (const [key, id] of symbolIdMap) {
                if (key.startsWith(`${edge.from_file}:${edge.from_name}:`)) {
                  fromId = id;
                  break;
                }
              }
            }
            if (!toId) {
              for (const [key, id] of symbolIdMap) {
                if (key.startsWith(`${edge.to_file}:${edge.to_name}:`)) {
                  toId = id;
                  break;
                }
              }
            }

            if (fromId && toId) {
              try {
                insertEdge.run(fromId, toId, edge.edge_type);
                edgeCount++;
              } catch {
                // Skip duplicate edges
              }
            }
          }
        });
        insertEdges();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Indexed ${targetDir}`,
                files: files.length,
                symbols: result.symbols.length,
                edges: edgeCount,
              }),
            },
          ],
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Indexing failed: ${errorMessage}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── query_code_graph ──
  server.registerTool(
    "query_code_graph",
    {
      description:
        "Look up a symbol by name, ID, or file path — returns its callers, callees, and imports (1-hop)",
      inputSchema: QueryCodeGraphSchema,
    },
    async ({ symbol_name, symbol_id, file_path }) => {
      let symbol: Record<string, unknown> | undefined;

      if (symbol_id !== undefined) {
        symbol = db
          .prepare("SELECT * FROM symbols WHERE id = ?")
          .get(symbol_id) as Record<string, unknown> | undefined;
      } else if (symbol_name) {
        // Prefer non-file symbols, then most recent
        symbol = db
          .prepare(
            `SELECT * FROM symbols WHERE symbol_name = ? AND symbol_type != 'file' ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(symbol_name) as Record<string, unknown> | undefined;

        if (!symbol) {
          symbol = db
            .prepare(`SELECT * FROM symbols WHERE symbol_name = ? LIMIT 1`)
            .get(symbol_name) as Record<string, unknown> | undefined;
        }
      } else if (file_path) {
        const symbols = db
          .prepare(
            "SELECT * FROM symbols WHERE file_path = ? ORDER BY start_line",
          )
          .all(file_path);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                file_path,
                symbols,
              }),
            },
          ],
        };
      }

      if (!symbol) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: "Symbol not found",
              }),
            },
          ],
        };
      }

      const symId = symbol.id as number;

      // Callers: edges where this symbol is the target
      const callers = db
        .prepare(
          `SELECT s.* FROM edges e
           JOIN symbols s ON e.from_symbol_id = s.id
           WHERE e.to_symbol_id = ?
           ORDER BY s.file_path, s.start_line`,
        )
        .all(symId);

      // Callees: edges where this symbol is the source
      const callees = db
        .prepare(
          `SELECT s.* FROM edges e
           JOIN symbols s ON e.to_symbol_id = s.id
           WHERE e.from_symbol_id = ?
           ORDER BY s.file_path, s.start_line`,
        )
        .all(symId);

      // Imports: edges of type 'imports' where this symbol is the source
      const imports = db
        .prepare(
          `SELECT s.*, e.edge_type FROM edges e
           JOIN symbols s ON e.to_symbol_id = s.id
           WHERE e.from_symbol_id = ? AND e.edge_type = 'imports'
           ORDER BY s.file_path`,
        )
        .all(symId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              symbol,
              callers,
              callees,
              imports,
            }),
          },
        ],
      };
    },
  );
}
