// CogMemory MCP — Codemap tools: generate_codemap, annotate_symbol

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler, projectPredicate } from "./utils.js";
import type { ActiveProjectRef } from "../active-project.js";

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
  activeProject: ActiveProjectRef,
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
        const projectId = activeProject.get();
        const hops = max_hops ?? 3;
        const nodes = max_nodes ?? 50;
        const withAnnotations = include_annotations !== false;

        // Find entry symbol(s)
        const entrySymbols = db
          .prepare(
            `SELECT * FROM symbols WHERE symbol_name = ? AND ${projectPredicate()} ORDER BY
           CASE symbol_type
             WHEN 'function' THEN 1
             WHEN 'class' THEN 2
             WHEN 'method' THEN 3
             WHEN 'interface' THEN 4
             ELSE 5
           END,
           updated_at DESC LIMIT 5`,
          )
          .all(entry_symbol, projectId) as Record<string, unknown>[];

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
        const { nodeMap, collectedEdges } = traverseCodeGraph(
          db,
          startId,
          hops,
          nodes,
        );

        // Deduplicate edges
        const uniqueEdges = dedupeEdges(collectedEdges);

        // Build result nodes
        const resultNodes = Array.from(nodeMap.values()).map(
          ({ symbol, depth }) => ({
            symbol,
            depth,
          }),
        );

        // Fetch annotations if requested
        const annotations =
          withAnnotations && nodeMap.size > 0
            ? fetchAnnotations(db, Array.from(nodeMap.keys()))
            : [];

        // Optionally save as trace
        const traceId = save_as_trace
          ? saveExecutionTrace(
              db,
              projectId,
              save_as_trace,
              trace_description ?? null,
              resultNodes,
            )
          : null;

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
        const projectId = activeProject.get();
        // Validate symbol_id if provided
        if (symbol_id !== undefined) {
          const symbol = db
            .prepare(
              `SELECT id FROM symbols WHERE id = ? AND ${projectPredicate()}`,
            )
            .get(symbol_id, projectId);
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
            .prepare(
              `SELECT id FROM execution_traces WHERE id = ? AND ${projectPredicate()}`,
            )
            .get(trace_id, projectId);
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
        INSERT INTO codemap_annotations (project_id, symbol_id, trace_id, annotation)
        VALUES (?, ?, ?, ?)
      `);
        const result = stmt.run(
          projectId,
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

// ─── BFS traversal helpers ────────────────────────────────

type SymbolRow = Record<string, unknown>;

interface TraversalResult {
  nodeMap: Map<number, { symbol: SymbolRow; depth: number }>;
  collectedEdges: SymbolRow[];
}

/**
 * BFS from a start symbol through the code graph (both edge directions),
 * bounded by max hops and max nodes.
 */
function traverseCodeGraph(
  db: Database.Database,
  startId: number,
  hops: number,
  maxNodes: number,
): TraversalResult {
  const visited = new Set<number>();
  const nodeMap = new Map<number, { symbol: SymbolRow; depth: number }>();
  const collectedEdges: SymbolRow[] = [];

  const queue: { id: number; depth: number }[] = [{ id: startId, depth: 0 }];
  visited.add(startId);

  while (queue.length > 0 && nodeMap.size < maxNodes) {
    const { id, depth } = queue.shift()!;

    const symbol = db.prepare("SELECT * FROM symbols WHERE id = ?").get(id) as
      | SymbolRow
      | undefined;
    if (!symbol) continue;

    nodeMap.set(id, { symbol, depth });
    if (depth >= hops) continue;

    const outEdges = db
      .prepare(
        `SELECT e.*, s.symbol_name as to_name, s.file_path as to_file
             FROM edges e
             JOIN symbols s ON e.to_symbol_id = s.id
             WHERE e.from_symbol_id = ?`,
      )
      .all(id) as SymbolRow[];

    const inEdges = db
      .prepare(
        `SELECT e.*, s.symbol_name as from_name, s.file_path as from_file
             FROM edges e
             JOIN symbols s ON e.from_symbol_id = s.id
             WHERE e.to_symbol_id = ?`,
      )
      .all(id) as SymbolRow[];

    enqueueEdges(
      outEdges,
      "to_symbol_id",
      depth,
      visited,
      queue,
      collectedEdges,
    );
    enqueueEdges(
      inEdges,
      "from_symbol_id",
      depth,
      visited,
      queue,
      collectedEdges,
    );
  }

  return { nodeMap, collectedEdges };
}

/** Collect edges and enqueue unvisited neighbor symbols. */
function enqueueEdges(
  edges: SymbolRow[],
  neighborKey: string,
  depth: number,
  visited: Set<number>,
  queue: { id: number; depth: number }[],
  collectedEdges: SymbolRow[],
): void {
  for (const edge of edges) {
    collectedEdges.push(edge);
    const neighborId = edge[neighborKey] as number;
    if (!visited.has(neighborId)) {
      visited.add(neighborId);
      queue.push({ id: neighborId, depth: depth + 1 });
    }
  }
}

/** Deduplicate collected edges by (from, to, type) key. */
function dedupeEdges(edges: SymbolRow[]): SymbolRow[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.from_symbol_id}-${e.to_symbol_id}-${e.edge_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Fetch codemap annotations for a set of symbol IDs. */
function fetchAnnotations(
  db: Database.Database,
  symbolIds: number[],
): SymbolRow[] {
  const placeholders = symbolIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM codemap_annotations WHERE symbol_id IN (${placeholders})`,
    )
    .all(...symbolIds) as SymbolRow[];
}

/** Persist a traversal as a named execution trace; returns the new trace ID. */
function saveExecutionTrace(
  db: Database.Database,
  projectId: number,
  name: string,
  description: string | null,
  resultNodes: { symbol: SymbolRow }[],
): number {
  const symbolSequence = JSON.stringify(resultNodes.map((n) => n.symbol.id));
  const stmt = db.prepare(`
          INSERT INTO execution_traces (project_id, name, description, symbol_sequence)
          VALUES (?, ?, ?, ?)
        `);
  const result = stmt.run(projectId, name, description, symbolSequence);
  return result.lastInsertRowid as number;
}
