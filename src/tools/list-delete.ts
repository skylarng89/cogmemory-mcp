// CogMemory MCP — List & Delete tools: browse and remove stored data across all subsystems

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler } from "./utils.js";

// ─── SUBSYSTEM REGISTRY ───────────────────────────────────
// Maps a logical subsystem name to its backing table(s) and metadata so the
// list/delete tools can operate generically across the whole storage layer.

interface TableMeta {
  /** Logical subsystem key exposed to the model. */
  subsystem: string;
  /** Primary table name backing the subsystem. */
  table: string;
  /** Human-readable description of what the subsystem stores. */
  description: string;
  /** Whether the table supports a session_id column for filtering. */
  hasSession: boolean;
  /** Whether the table supports a tags column for filtering. */
  hasTags: boolean;
  /** Default sort column for list ordering. */
  sortColumn: string;
  /** Optional secondary tables to clear when this subsystem is purged. */
  cascadeTables?: string[];
}

const TABLES: TableMeta[] = [
  {
    subsystem: "sessions",
    table: "sessions",
    description: "Work sessions (spine for decisions/errors/changelog/tasks)",
    hasSession: false,
    hasTags: false,
    sortColumn: "started_at",
  },
  {
    subsystem: "decisions",
    table: "decisions",
    description: "Architectural decisions with rationale and tags",
    hasSession: true,
    hasTags: true,
    sortColumn: "created_at",
  },
  {
    subsystem: "conventions",
    table: "conventions",
    description: "Conventions: design tokens, patterns, style, naming",
    hasSession: false,
    hasTags: true,
    sortColumn: "updated_at",
  },
  {
    subsystem: "errors",
    table: "errors",
    description: "Logged errors with signatures and resolutions",
    hasSession: true,
    hasTags: true,
    sortColumn: "created_at",
  },
  {
    subsystem: "context",
    table: "context",
    description: "Active context key/value entries",
    hasSession: false,
    hasTags: false,
    sortColumn: "updated_at",
  },
  {
    subsystem: "changelog",
    table: "changelog",
    description: "Append-only changelog of what happened",
    hasSession: true,
    hasTags: false,
    sortColumn: "created_at",
  },
  {
    subsystem: "plan",
    table: "plan",
    description: "Roadmap / plan items",
    hasSession: false,
    hasTags: false,
    sortColumn: "order_index",
  },
  {
    subsystem: "tasks",
    table: "tasks",
    description: "Actionable tasks, optionally linked to plan items",
    hasSession: true,
    hasTags: true,
    sortColumn: "created_at",
  },
  {
    subsystem: "entities",
    table: "entities",
    description: "Knowledge graph entities (concepts/technologies/components)",
    hasSession: false,
    hasTags: false,
    sortColumn: "created_at",
    cascadeTables: ["relations", "observations"],
  },
  {
    subsystem: "relations",
    table: "relations",
    description: "Typed relations between knowledge graph entities",
    hasSession: false,
    hasTags: false,
    sortColumn: "created_at",
  },
  {
    subsystem: "observations",
    table: "observations",
    description: "Facts/observations attached to knowledge graph entities",
    hasSession: false,
    hasTags: false,
    sortColumn: "created_at",
  },
  {
    subsystem: "specs",
    table: "specs",
    description: "Long-form documents (PRD/SRS/design docs)",
    hasSession: false,
    hasTags: false,
    sortColumn: "updated_at",
  },
  {
    subsystem: "symbols",
    table: "symbols",
    description: "Code graph symbols extracted from the workspace",
    hasSession: false,
    hasTags: false,
    sortColumn: "file_path",
    cascadeTables: ["edges"],
  },
  {
    subsystem: "edges",
    table: "edges",
    description: "Code graph edges (calls/imports/extends/implements + SIMILAR_TO, SEMANTICALLY_RELATED)",
    hasSession: false,
    hasTags: false,
    sortColumn: "created_at",
  },
  {
    subsystem: "execution_traces",
    table: "execution_traces",
    description: "Named execution traces through the code graph",
    hasSession: false,
    hasTags: false,
    sortColumn: "created_at",
  },
  {
    subsystem: "codemap_annotations",
    table: "codemap_annotations",
    description: "AI narrative annotations layered on symbols/traces",
    hasSession: false,
    hasTags: false,
    sortColumn: "created_at",
  },
  {
    subsystem: "file_index",
    table: "file_index",
    description: "Indexed file mtimes used for incremental code graph updates",
    hasSession: false,
    hasTags: false,
    sortColumn: "file_path",
  },
  {
    subsystem: "index_errors",
    table: "index_errors",
    description: "Parse/IO errors from code graph indexing",
    hasSession: false,
    hasTags: false,
    sortColumn: "occurred_at",
  },
  {
    subsystem: "symbol_tokens",
    table: "symbol_tokens",
    description: "TF-IDF tokens for semantic code search",
    hasSession: false,
    hasTags: false,
    sortColumn: "symbol_id",
  },
  {
    subsystem: "symbol_minhash",
    table: "symbol_minhash",
    description: "MinHash signatures for clone detection",
    hasSession: false,
    hasTags: false,
    sortColumn: "symbol_id",
  },
  {
    subsystem: "symbol_embeddings",
    table: "symbol_embeddings",
    description: "Vector embeddings for symbols (Phase 2 stub)",
    hasSession: false,
    hasTags: false,
    sortColumn: "symbol_id",
  },
];

const SUBSYSTEM_NAMES = TABLES.map((t) => t.subsystem);

function findTable(subsystem: string): TableMeta | undefined {
  return TABLES.find((t) => t.subsystem === subsystem);
}

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const ListItemsSchema = z.object({
  subsystem: z
    .enum(SUBSYSTEM_NAMES as [string, ...string[]])
    .describe("Which subsystem to list entries from"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max entries to return (default 50)"),
  session_id: z
    .number()
    .int()
    .optional()
    .describe("Filter by session ID (only for session-scoped subsystems)"),
  tags: z
    .string()
    .optional()
    .describe(
      "Filter by tags substring (only for tag-bearing subsystems; LIKE match)",
    ),
});

export const DeleteItemSchema = z.object({
  subsystem: z
    .enum(SUBSYSTEM_NAMES as [string, ...string[]])
    .describe("Which subsystem to delete from"),
  id: z
    .number()
    .int()
    .describe("Row ID to delete (for tables without a natural key)"),
});

export const DeleteByKeySchema = z.object({
  subsystem: z
    .literal("context")
    .describe("The context subsystem uses a string primary key"),
  key: z.string().min(1).describe("Context key to delete"),
});

export const DeleteByPathSchema = z.object({
  subsystem: z
    .literal("file_index")
    .describe("The file_index subsystem uses a path primary key"),
  file_path: z.string().min(1).describe("File path to remove from the index"),
});

export const PurgeSubsystemSchema = z.object({
  subsystem: z
    .enum(SUBSYSTEM_NAMES as [string, ...string[]])
    .describe("Remove ALL rows from this subsystem (and cascaded dependents)"),
  confirm: z
    .boolean()
    .describe(
      "Must be true to proceed — protects against accidental bulk deletion",
    ),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerListDeleteTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── list_items ──
  server.registerTool(
    "list_items",
    {
      description:
        "Browse stored entries from any CogMemory subsystem (sessions, decisions, conventions, errors, context, changelog, plan, tasks, entities, relations, observations, specs, symbols, edges, execution_traces, codemap_annotations, file_index). Returns rows with optional filters.",
      inputSchema: ListItemsSchema,
    },
    wrapHandler(
      "list_items",
      async ({ subsystem, limit, session_id, tags }) => {
        const meta = findTable(subsystem);
        if (!meta) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `Unknown subsystem: ${subsystem}`,
                }),
              },
            ],
          };
        }

        const lim = limit ?? 50;
        const conds: string[] = [];
        const params: unknown[] = [];

        if (session_id !== undefined) {
          if (!meta.hasSession) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    message: `Subsystem '${subsystem}' is not session-scoped`,
                  }),
                },
              ],
            };
          }
          conds.push("session_id = ?");
          params.push(session_id);
        }

        if (tags !== undefined) {
          if (!meta.hasTags) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    message: `Subsystem '${subsystem}' does not support tags`,
                  }),
                },
              ],
            };
          }
          conds.push("tags LIKE ?");
          params.push(`%${tags}%`);
        }

        const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
        const rows = db
          .prepare(
            `SELECT * FROM ${meta.table} ${where} ORDER BY ${meta.sortColumn} DESC LIMIT ?`,
          )
          .all(...params, lim);

        const total = (
          db.prepare(`SELECT COUNT(*) as cnt FROM ${meta.table}`).get() as {
            cnt: number;
          }
        ).cnt;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                subsystem,
                description: meta.description,
                total,
                returned: rows.length,
                limit: lim,
                rows,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── delete_item ──
  server.registerTool(
    "delete_item",
    {
      description:
        "Delete a single row by ID from any CogMemory subsystem that uses an integer primary key. For 'context' use delete_by_key; for 'file_index' use delete_by_path.",
      inputSchema: DeleteItemSchema,
    },
    wrapHandler("delete_item", async ({ subsystem, id }) => {
      const meta = findTable(subsystem);
      if (!meta) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Unknown subsystem: ${subsystem}`,
              }),
            },
          ],
        };
      }
      if (subsystem === "context" || subsystem === "file_index") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Use ${
                  subsystem === "context" ? "delete_by_key" : "delete_by_path"
                } for the '${subsystem}' subsystem`,
              }),
            },
          ],
        };
      }

      const result = db
        .prepare(`DELETE FROM ${meta.table} WHERE id = ?`)
        .run(id);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `${subsystem} row ${id} not found`,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `Deleted ${subsystem} row ${id}`,
              deleted: result.changes,
            }),
          },
        ],
      };
    }),
  );

  // ── delete_by_key ──
  server.registerTool(
    "delete_by_key",
    {
      description: "Delete a context entry by its string key",
      inputSchema: DeleteByKeySchema,
    },
    wrapHandler("delete_by_key", async ({ key }) => {
      const result = db.prepare("DELETE FROM context WHERE key = ?").run(key);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `context key '${key}' not found`,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `Deleted context key '${key}'`,
              deleted: result.changes,
            }),
          },
        ],
      };
    }),
  );

  // ── delete_by_path ──
  server.registerTool(
    "delete_by_path",
    {
      description: "Remove a file from the code graph file_index",
      inputSchema: DeleteByPathSchema,
    },
    wrapHandler("delete_by_path", async ({ file_path }) => {
      const result = db
        .prepare("DELETE FROM file_index WHERE file_path = ?")
        .run(file_path);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `file_index path '${file_path}' not found`,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `Removed '${file_path}' from file_index`,
              deleted: result.changes,
            }),
          },
        ],
      };
    }),
  );

  // ── purge_subsystem ──
  server.registerTool(
    "purge_subsystem",
    {
      description:
        "Remove ALL rows from a single subsystem (and cascaded dependents). Requires confirm=true. Use with care — this is irreversible.",
      inputSchema: PurgeSubsystemSchema,
    },
    wrapHandler("purge_subsystem", async ({ subsystem, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message:
                  "Pass confirm=true to purge_subsystem — this deletes ALL rows in the subsystem",
              }),
            },
          ],
        };
      }
      const meta = findTable(subsystem);
      if (!meta) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Unknown subsystem: ${subsystem}`,
              }),
            },
          ],
        };
      }

      const deleted: Record<string, number> = {};
      db.transaction(() => {
        const primary = (
          db.prepare(`SELECT COUNT(*) as cnt FROM ${meta.table}`).get() as {
            cnt: number;
          }
        ).cnt;
        db.exec(`DELETE FROM ${meta.table}`);
        deleted[meta.table] = primary;

        for (const dep of meta.cascadeTables ?? []) {
          const depCount = (
            db.prepare(`SELECT COUNT(*) as cnt FROM ${dep}`).get() as {
              cnt: number;
            }
          ).cnt;
          db.exec(`DELETE FROM ${dep}`);
          deleted[dep] = depCount;
        }
      })();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `Purged subsystem '${subsystem}'`,
              deleted,
            }),
          },
        ],
      };
    }),
  );
}
