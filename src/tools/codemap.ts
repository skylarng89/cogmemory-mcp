// CogMemory MCP — Codemap tools: generate_codemap, annotate_symbol

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler } from "./utils.js";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const GenerateCodemapSchema = z.object({
  entry_symbol: z
    .string()
    .min(1)
    .describe("Starting symbol name for the codemap"),
  max_hops: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Maximum traversal depth (default: 3)"),
  max_nodes: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum nodes to return (default: 50)"),
  include_annotations: z
    .boolean()
    .optional()
    .describe("Include existing annotations in output (default: true)"),
  save_as_trace: z
    .string()
    .optional()
    .describe("Save the traversal as a named execution trace"),
  trace_description: z
    .string()
    .optional()
    .describe("Description for the saved trace"),
});

export const AnnotateSymbolSchema = z
  .object({
    symbol_id: z.number().int().optional().describe("Symbol ID to annotate"),
    trace_id: z.number().int().optional().describe("Trace ID to annotate"),
    annotation: z.string().min(1).describe("Narrative text to attach"),
  })
  .refine(
    (data) => data.symbol_id !== undefined || data.trace_id !== undefined,
    { message: "Either symbol_id or trace_id must be provided" },
  );

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerCodemapTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── generate_codemap ──
  server.registerTool(
    "generate_codemap",
    {
      description:
        "BFS from an entry symbol through the code graph, returning a bounded subgraph with optional traces and annotations",
      inputSchema: GenerateCodemapSchema,
    },
    wrapHandler(
      "generate_codemap",
      async ({
        entry_symbol,
        max_hops,
        max_nodes,
        include_annotations,
        save_as_trace,
        trace_description,
      }) => {
        const hops = max_hops ?? 3;
        const nodes = max_nodes ?? 50;
        const withAnnotations = include_annotations !== false;

        // Find entry symbol(s)
        const entrySymbols = db
          .prepare(
            `SELECT * FROM symbols WHERE symbol_name = ? ORDER BY
           CASE symbol_type
             WHEN 'function' THEN 1
             WHEN 'class' THEN 2
             WHEN 'method' THEN 3
             WHEN 'interface' THEN 4
             ELSE 5
           END,
           updated_at DESC LIMIT 5`,
          )
          .all(entry_symbol) as Record<string, unknown>[];

        if (entrySymbols.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `No symbols found matching "${entry_symbol}"`,
                }),
              },
            ],
          };
        }

        // Use the first (most relevant) entry symbol
        const startId = entrySymbols[0].id as number;

        // BFS traversal
        const visited = new Set<number>();
        const nodeMap = new Map<
          number,
          { symbol: Record<string, unknown>; depth: number }
        >();
        const collectedEdges: Record<string, unknown>[] = [];

        const queue: { id: number; depth: number }[] = [
          { id: startId, depth: 0 },
        ];
        visited.add(startId);

        while (queue.length > 0 && nodeMap.size < nodes) {
          const { id, depth } = queue.shift()!;

          // Fetch symbol
          const symbol = db
            .prepare("SELECT * FROM symbols WHERE id = ?")
            .get(id) as Record<string, unknown> | undefined;

          if (!symbol) continue;

          nodeMap.set(id, { symbol, depth });

          if (depth >= hops) continue;

          // Get all edges (both directions) for this symbol
          const outEdges = db
            .prepare(
              `SELECT e.*, s.symbol_name as to_name, s.file_path as to_file
             FROM edges e
             JOIN symbols s ON e.to_symbol_id = s.id
             WHERE e.from_symbol_id = ?`,
            )
            .all(id) as Record<string, unknown>[];

          const inEdges = db
            .prepare(
              `SELECT e.*, s.symbol_name as from_name, s.file_path as from_file
             FROM edges e
             JOIN symbols s ON e.from_symbol_id = s.id
             WHERE e.to_symbol_id = ?`,
            )
            .all(id) as Record<string, unknown>[];

          for (const edge of outEdges) {
            collectedEdges.push(edge);
            const targetId = edge.to_symbol_id as number;
            if (!visited.has(targetId)) {
              visited.add(targetId);
              queue.push({ id: targetId, depth: depth + 1 });
            }
          }

          for (const edge of inEdges) {
            collectedEdges.push(edge);
            const sourceId = edge.from_symbol_id as number;
            if (!visited.has(sourceId)) {
              visited.add(sourceId);
              queue.push({ id: sourceId, depth: depth + 1 });
            }
          }
        }

        // Deduplicate edges
        const seenEdgeKeys = new Set<string>();
        const uniqueEdges = collectedEdges.filter((e) => {
          const key = `${e.from_symbol_id}-${e.to_symbol_id}-${e.edge_type}`;
          if (seenEdgeKeys.has(key)) return false;
          seenEdgeKeys.add(key);
          return true;
        });

        // Build result nodes
        const resultNodes = Array.from(nodeMap.values()).map(
          ({ symbol, depth }) => ({
            symbol,
            depth,
          }),
        );

        // Fetch annotations if requested
        let annotations: Record<string, unknown>[] = [];
        if (withAnnotations && nodeMap.size > 0) {
          const ids = Array.from(nodeMap.keys());
          const placeholders = ids.map(() => "?").join(",");
          annotations = db
            .prepare(
              `SELECT * FROM codemap_annotations WHERE symbol_id IN (${placeholders})`,
            )
            .all(...ids) as Record<string, unknown>[];
        }

        // Optionally save as trace
        let traceId: number | null = null;
        if (save_as_trace) {
          const symbolSequence = JSON.stringify(
            resultNodes.map((n) => (n.symbol as Record<string, unknown>).id),
          );
          const stmt = db.prepare(`
          INSERT INTO execution_traces (name, description, symbol_sequence)
          VALUES (?, ?, ?)
        `);
          const result = stmt.run(
            save_as_trace,
            trace_description ?? null,
            symbolSequence,
          );
          traceId = result.lastInsertRowid as number;
        }

        const response: Record<string, unknown> = {
          success: true,
          entry_symbol: entrySymbols[0],
          nodes: resultNodes,
          edges: uniqueEdges,
          totalNodes: resultNodes.length,
          totalEdges: uniqueEdges.length,
        };

        if (withAnnotations && annotations.length > 0) {
          response.annotations = annotations;
        }

        if (traceId !== null) {
          response.saved_trace_id = traceId;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response),
            },
          ],
        };
      },
    ),
  );

  // ── annotate_symbol ──
  server.registerTool(
    "annotate_symbol",
    {
      description:
        "Attach narrative text to a symbol or execution trace (storage-only — the server never generates the text)",
      inputSchema: AnnotateSymbolSchema,
    },
    wrapHandler(
      "annotate_symbol",
      async ({ symbol_id, trace_id, annotation }) => {
        // Validate symbol_id if provided
        if (symbol_id !== undefined) {
          const symbol = db
            .prepare("SELECT id FROM symbols WHERE id = ?")
            .get(symbol_id);
          if (!symbol) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    message: `Symbol ${symbol_id} not found`,
                  }),
                },
              ],
            };
          }
        }

        // Validate trace_id if provided
        if (trace_id !== undefined) {
          const trace = db
            .prepare("SELECT id FROM execution_traces WHERE id = ?")
            .get(trace_id);
          if (!trace) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    message: `Trace ${trace_id} not found`,
                  }),
                },
              ],
            };
          }
        }

        const stmt = db.prepare(`
        INSERT INTO codemap_annotations (symbol_id, trace_id, annotation)
        VALUES (?, ?, ?)
      `);
        const result = stmt.run(
          symbol_id ?? null,
          trace_id ?? null,
          annotation,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                id: result.lastInsertRowid,
                message: `Annotation saved to ${
                  symbol_id ? `symbol ${symbol_id}` : `trace ${trace_id}`
                }`,
              }),
            },
          ],
        };
      },
    ),
  );
}
