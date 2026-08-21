// CogMemory MCP — Memory tools: decisions, conventions, errors, context, changelog, recall

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler } from "./utils.js";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const RememberDecisionSchema = z.object({
  title: z.string().min(1).describe("Short title for the decision"),
  rationale: z.string().optional().describe("Why this decision was made"),
  tags: z
    .string()
    .optional()
    .describe("Comma-separated tags for later retrieval"),
  session_id: z
    .number()
    .int()
    .optional()
    .describe("Current session ID to associate with"),
});

export const RememberConventionSchema = z.object({
  category: z
    .string()
    .min(1)
    .describe(
      "Category: 'design-token' | 'pattern' | 'style' | 'naming' | custom",
    ),
  key: z.string().min(1).describe("Convention key, e.g. 'color-primary'"),
  value: z.string().optional().describe("Convention value"),
  description: z.string().optional().describe("Explanation of the convention"),
  tags: z.string().optional().describe("Comma-separated tags"),
});

export const LogErrorSchema = z.object({
  error_signature: z
    .string()
    .min(1)
    .describe(
      "Short normalized signature for lookup, e.g. 'TypeErr:undefined'",
    ),
  description: z.string().optional().describe("Full error description"),
  resolution: z.string().optional().describe("How the error was resolved"),
  tags: z.string().optional().describe("Comma-separated tags"),
  session_id: z.number().int().optional().describe("Current session ID"),
});

export const SetActiveContextSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe("Context key, e.g. 'active_task', 'current_branch'"),
  value: z.string().optional().describe("Context value (null to clear)"),
});

export const GetActiveContextSchema = z.object({
  key: z.string().min(1).describe("Context key to retrieve"),
});

export const LogChangeSchema = z.object({
  summary: z.string().min(1).describe("What changed"),
  ref: z.string().optional().describe("Commit hash, PR URL, or file path"),
  session_id: z.number().int().optional().describe("Current session ID"),
});

export const RecallSchema = z.object({
  text: z
    .string()
    .optional()
    .describe(
      'Text to search for using FTS5 (supports AND/OR/NOT, phrase "exact match", prefix tr*',
    ),
  tags: z.string().optional().describe("Comma-separated tags to filter by"),
  session_id: z.number().int().optional().describe("Filter by session ID"),
  since: z
    .string()
    .optional()
    .describe("ISO date string — only return entries created after this"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max results per category (default 20)"),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerMemoryTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── remember_decision ──
  server.registerTool(
    "remember_decision",
    {
      description: "Log a decision with rationale and optional tags",
      inputSchema: RememberDecisionSchema,
    },
    wrapHandler(
      "remember_decision",
      async ({ title, rationale, tags, session_id }) => {
        const stmt = db.prepare(`
        INSERT INTO decisions (session_id, title, rationale, tags)
        VALUES (?, ?, ?, ?)
      `);
        const result = stmt.run(
          session_id ?? null,
          title,
          rationale ?? null,
          tags ?? null,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                id: result.lastInsertRowid,
                message: `Decision recorded: "${title}"`,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── remember_convention ──
  server.registerTool(
    "remember_convention",
    {
      description:
        "Log or update a convention (design token, pattern, style, naming)",
      inputSchema: RememberConventionSchema,
    },
    wrapHandler(
      "remember_convention",
      async ({ category, key, value, description, tags }) => {
        const stmt = db.prepare(`
        INSERT INTO conventions (category, key, value, description, tags)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(category, key) DO UPDATE SET
          value = excluded.value,
          description = excluded.description,
          tags = excluded.tags,
          updated_at = datetime('now')
      `);
        const result = stmt.run(
          category,
          key,
          value ?? null,
          description ?? null,
          tags ?? null,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                id: result.lastInsertRowid,
                message: `Convention ${category}/${key} saved`,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── log_error ──
  server.registerTool(
    "log_error",
    {
      description:
        "Record an error with its signature, description, and resolution",
      inputSchema: LogErrorSchema,
    },
    wrapHandler(
      "log_error",
      async ({
        error_signature,
        description,
        resolution,
        tags,
        session_id,
      }) => {
        const stmt = db.prepare(`
        INSERT INTO errors (session_id, error_signature, description, resolution, tags)
        VALUES (?, ?, ?, ?, ?)
      `);
        const result = stmt.run(
          session_id ?? null,
          error_signature,
          description ?? null,
          resolution ?? null,
          tags ?? null,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                id: result.lastInsertRowid,
                message: `Error logged: ${error_signature}`,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── set_active_context ──
  server.registerTool(
    "set_active_context",
    {
      description: "Set or update the current active context (upsert by key)",
      inputSchema: SetActiveContextSchema,
    },
    wrapHandler("set_active_context", async ({ key, value }) => {
      const stmt = db.prepare(`
        INSERT INTO context (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')
      `);
      stmt.run(key, value ?? null);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: `Context ${key} set`,
            }),
          },
        ],
      };
    }),
  );

  // ── get_active_context ──
  server.registerTool(
    "get_active_context",
    {
      description: "Read the current value of a context key",
      inputSchema: GetActiveContextSchema,
    },
    wrapHandler("get_active_context", async ({ key }) => {
      const row = db
        .prepare("SELECT key, value, updated_at FROM context WHERE key = ?")
        .get(key) as
        | { key: string; value: string | null; updated_at: string }
        | undefined;

      if (!row) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                key,
                value: null,
                message: "No context set for this key",
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(row),
          },
        ],
      };
    }),
  );

  // ── log_change ──
  server.registerTool(
    "log_change",
    {
      description: "Append an entry to the changelog (what happened)",
      inputSchema: LogChangeSchema,
    },
    wrapHandler("log_change", async ({ summary, ref, session_id }) => {
      const stmt = db.prepare(`
        INSERT INTO changelog (session_id, summary, ref)
        VALUES (?, ?, ?)
      `);
      const result = stmt.run(session_id ?? null, summary, ref ?? null);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              id: result.lastInsertRowid,
              message: `Changelog entry added: "${summary}"`,
            }),
          },
        ],
      };
    }),
  );

  // ── recall ──
  server.registerTool(
    "recall",
    {
      description:
        "Unified search across decisions, conventions, errors, and changelog by text, tags, session, or date range",
      inputSchema: RecallSchema,
    },
    wrapHandler("recall", async ({ text, tags, session_id, since, limit }) => {
      const lim = limit ?? 20;
      const results: Record<string, unknown[]> = {};

      if (text) {
        // FTS5 full-text search — joins recall_fts → recall_docs → source table
        const sourceConfigs = [
          {
            key: "decisions",
            table: "decisions",
            alias: "d",
            hasSession: true,
            hasTags: true,
          },
          {
            key: "conventions",
            table: "conventions",
            alias: "c",
            hasSession: false,
            hasTags: true,
          },
          {
            key: "errors",
            table: "errors",
            alias: "e",
            hasSession: true,
            hasTags: true,
          },
          {
            key: "changelog",
            table: "changelog",
            alias: "ch",
            hasSession: true,
            hasTags: false,
          },
        ];

        for (const cfg of sourceConfigs) {
          const conds: string[] = ["recall_fts MATCH ?", "rd.source = ?"];
          const params: unknown[] = [text, cfg.key];

          if (since) {
            conds.push("rd.created_at >= ?");
            params.push(since);
          }
          if (cfg.hasTags && tags) {
            conds.push(`${cfg.alias}.tags LIKE ?`);
            params.push(`%${tags}%`);
          }
          if (cfg.hasSession && session_id !== undefined) {
            conds.push(`${cfg.alias}.session_id = ?`);
            params.push(session_id);
          }

          const sql = `
            SELECT ${cfg.alias}.* FROM recall_fts fts
            JOIN recall_docs rd ON rd.id = fts.rowid
            JOIN ${cfg.table} ${cfg.alias} ON ${cfg.alias}.id = rd.doc_id
            WHERE ${conds.join(" AND ")}
            ORDER BY fts.rank
            LIMIT ?
          `;
          results[cfg.key] = db.prepare(sql).all(...params, lim);
        }
      } else {
        // No text — tag/session/date filters only (LIKE fallback)
        const tagsLike = tags ? `%${tags}%` : null;

        const decConds: string[] = [];
        const decParams: unknown[] = [];
        if (tagsLike) {
          decConds.push("tags LIKE ?");
          decParams.push(tagsLike);
        }
        if (session_id !== undefined) {
          decConds.push("session_id = ?");
          decParams.push(session_id);
        }
        if (since) {
          decConds.push("created_at >= ?");
          decParams.push(since);
        }
        const decWhere =
          decConds.length > 0 ? `WHERE ${decConds.join(" AND ")}` : "";
        results.decisions = db
          .prepare(
            `SELECT * FROM decisions ${decWhere} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...decParams, lim);

        const convConds: string[] = [];
        const convParams: unknown[] = [];
        if (tagsLike) {
          convConds.push("tags LIKE ?");
          convParams.push(tagsLike);
        }
        if (since) {
          convConds.push("created_at >= ?");
          convParams.push(since);
        }
        const convWhere =
          convConds.length > 0 ? `WHERE ${convConds.join(" AND ")}` : "";
        results.conventions = db
          .prepare(
            `SELECT * FROM conventions ${convWhere} ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(...convParams, lim);

        const errConds: string[] = [];
        const errParams: unknown[] = [];
        if (tagsLike) {
          errConds.push("tags LIKE ?");
          errParams.push(tagsLike);
        }
        if (session_id !== undefined) {
          errConds.push("session_id = ?");
          errParams.push(session_id);
        }
        if (since) {
          errConds.push("created_at >= ?");
          errParams.push(since);
        }
        const errWhere =
          errConds.length > 0 ? `WHERE ${errConds.join(" AND ")}` : "";
        results.errors = db
          .prepare(
            `SELECT * FROM errors ${errWhere} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...errParams, lim);

        const changeConds: string[] = [];
        const changeParams: unknown[] = [];
        if (session_id !== undefined) {
          changeConds.push("session_id = ?");
          changeParams.push(session_id);
        }
        if (since) {
          changeConds.push("created_at >= ?");
          changeParams.push(since);
        }
        const changeWhere =
          changeConds.length > 0 ? `WHERE ${changeConds.join(" AND ")}` : "";
        results.changelog = db
          .prepare(
            `SELECT * FROM changelog ${changeWhere} ORDER BY created_at DESC LIMIT ?`,
          )
          .all(...changeParams, lim);
      }

      const totalResults =
        results.decisions.length +
        results.conventions.length +
        results.errors.length +
        results.changelog.length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ totalResults, ...results }),
          },
        ],
      };
    }),
  );
}
