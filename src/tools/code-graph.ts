// CogMemory MCP — Code Graph tools: index_codebase, query_code_graph

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { walkFilesWithMtime } from "../indexing/walker.js";
import { analyzeFiles } from "../indexing/ts-analyzer.js";
import { resolve } from "node:path";
import { wrapHandler } from "./utils.js";

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
  full: z
    .boolean()
    .optional()
    .describe("Force full re-index instead of incremental (default: false)"),
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
        "Walk the workspace and extract symbols + edges via ts-morph (JS/TS). Incremental by default (only re-analyzes changed files); use full=true to force complete re-index.",
      inputSchema: IndexCodebaseSchema,
    },
    async ({ root_dir, extensions, full }) => {
      const targetDir = resolve(root_dir ?? workspaceRoot);
      const exts = extensions ?? ["ts", "tsx", "js", "jsx"];

      try {
        // Step 1: Walk files with mtimes
        const filesWithMtime = walkFilesWithMtime(targetDir, {
          extensions: exts,
        });
        const currentFiles = new Map(
          filesWithMtime.map((f) => [f.path, f.mtime]),
        );

        if (currentFiles.size === 0) {
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

        // Step 2: Get stored file index
        const storedIndex = db
          .prepare("SELECT file_path, mtime_ms FROM file_index")
          .all() as { file_path: string; mtime_ms: number }[];
        const storedFiles = new Map(
          storedIndex.map((f) => [f.file_path, f.mtime_ms]),
        );

        // Step 3: Full re-index or incremental
        const isFull = full || storedFiles.size === 0;
        let filesToAnalyze: string[];
        let deletedFiles: string[];

        if (isFull) {
          filesToAnalyze = [...currentFiles.keys()];
          deletedFiles = [];
          db.exec("DELETE FROM edges");
          db.exec("DELETE FROM symbols");
          db.exec("DELETE FROM file_index");
        } else {
          // Incremental: classify files by comparing mtimes
          const newFiles: string[] = [];
          const changedFiles: string[] = [];

          for (const [path, mtime] of currentFiles) {
            const storedMtime = storedFiles.get(path);
            if (storedMtime === undefined) {
              newFiles.push(path);
            } else if (storedMtime !== mtime) {
              changedFiles.push(path);
            }
          }

          deletedFiles = [];
          for (const [path] of storedFiles) {
            if (!currentFiles.has(path)) {
              deletedFiles.push(path);
            }
          }

          filesToAnalyze = [...newFiles, ...changedFiles];

          // Delete symbols for deleted + changed files (edges cascade via FK)
          const filesToDelete = [...deletedFiles, ...changedFiles];
          if (filesToDelete.length > 0) {
            const deleteSymbols = db.prepare(
              "DELETE FROM symbols WHERE file_path = ?",
            );
            const deleteFileIdx = db.prepare(
              "DELETE FROM file_index WHERE file_path = ?",
            );
            db.transaction(() => {
              for (const path of filesToDelete) {
                deleteSymbols.run(path);
                deleteFileIdx.run(path);
              }
            })();
          }
        }

        // Early return if nothing changed
        if (filesToAnalyze.length === 0 && deletedFiles.length === 0) {
          const symCount = (
            db.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as {
              cnt: number;
            }
          ).cnt;
          const edgeCount = (
            db.prepare("SELECT COUNT(*) as cnt FROM edges").get() as {
              cnt: number;
            }
          ).cnt;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "Index up to date \u2014 no changes detected",
                  mode: "incremental",
                  files: currentFiles.size,
                  changed: 0,
                  deleted: 0,
                  symbols: symCount,
                  edges: edgeCount,
                }),
              },
            ],
          };
        }

        // Build symbolIdMap from existing symbols (for cross-file edge resolution)
        const symbolIdMap = new Map<string, number>();
        if (!isFull) {
          const existingSymbols = db
            .prepare(
              "SELECT id, file_path, symbol_name, start_line FROM symbols",
            )
            .all() as {
            id: number;
            file_path: string;
            symbol_name: string;
            start_line: number;
          }[];
          for (const sym of existingSymbols) {
            symbolIdMap.set(
              `${sym.file_path}:${sym.symbol_name}:${sym.start_line}`,
              sym.id,
            );
          }
        }

        // Analyze new + changed files
        let newSymbolCount = 0;
        let newEdgeCount = 0;

        if (filesToAnalyze.length > 0) {
          const result = analyzeFiles(filesToAnalyze, targetDir);
          newSymbolCount = result.symbols.length;

          // Insert symbols
          const insertSymbol = db.prepare(`
            INSERT INTO symbols (file_path, symbol_name, symbol_type, start_line, end_line)
            VALUES (?, ?, ?, ?, ?)
          `);
          db.transaction(() => {
            for (const sym of result.symbols) {
              const r = insertSymbol.run(
                sym.file_path,
                sym.symbol_name,
                sym.symbol_type,
                sym.start_line,
                sym.end_line,
              );
              const id = r.lastInsertRowid as number;
              symbolIdMap.set(
                `${sym.file_path}:${sym.symbol_name}:${sym.start_line}`,
                id,
              );
            }
          })();

          // Insert edges
          const insertEdge = db.prepare(`
            INSERT INTO edges (from_symbol_id, to_symbol_id, edge_type)
            VALUES (?, ?, ?)
          `);
          db.transaction(() => {
            for (const edge of result.edges) {
              const fromKey = `${edge.from_file}:${edge.from_name}:${edge.from_start_line}`;
              const toKey = `${edge.to_file}:${edge.to_name}:${edge.to_start_line}`;
              let fromId = symbolIdMap.get(fromKey);
              let toId = symbolIdMap.get(toKey);

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
                  newEdgeCount++;
                } catch {
                  // Skip duplicate edges
                }
              }
            }
          })();

          // Update file_index for processed files
          const upsertFileIndex = db.prepare(`
            INSERT INTO file_index (file_path, mtime_ms, indexed_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(file_path) DO UPDATE SET
              mtime_ms = excluded.mtime_ms,
              indexed_at = datetime('now')
          `);
          db.transaction(() => {
            for (const path of filesToAnalyze) {
              upsertFileIndex.run(path, currentFiles.get(path)!);
            }
          })();
        }

        // Get totals
        const totalSymbols = (
          db.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as {
            cnt: number;
          }
        ).cnt;
        const totalEdges = (
          db.prepare("SELECT COUNT(*) as cnt FROM edges").get() as {
            cnt: number;
          }
        ).cnt;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: isFull
                  ? `Full index of ${targetDir}`
                  : `Incremental index of ${targetDir}`,
                mode: isFull ? "full" : "incremental",
                files: currentFiles.size,
                analyzed: filesToAnalyze.length,
                deleted: deletedFiles.length,
                newSymbols: newSymbolCount,
                newEdges: newEdgeCount,
                totalSymbols,
                totalEdges,
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
    wrapHandler(
      "query_code_graph",
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
    ),
  );
}
