// CogMemory MCP — Memory tools: decisions, conventions, errors, context, changelog, recall

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler, resolveSessionId, projectPredicate } from "./utils.js";

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

// ─── RECALL HELPERS ───────────────────────────────────────

interface RecallFilterOpts {
  tags?: string;
  session_id?: number;
  since?: string;
  hasSession: boolean;
  hasTags: boolean;
  projectId: number;
}

function ftsSearch(
  db: Database.Database,
  table: string,
  alias: string,
  text: string,
  opts: RecallFilterOpts,
  lim: number,
): unknown[] {
  const conds: string[] = ["recall_fts MATCH ?", "rd.source = ?"];
  const params: unknown[] = [text, table];

  if (opts.since) {
    conds.push("rd.created_at >= ?");
    params.push(opts.since);
  }
  if (opts.hasTags && opts.tags) {
    conds.push(`${alias}.tags LIKE ?`);
    params.push(`%${opts.tags}%`);
  }
  if (opts.hasSession && opts.session_id !== undefined) {
    conds.push(`${alias}.session_id = ?`);
    params.push(opts.session_id);
  }
  conds.push(projectPredicate(alias));
  params.push(opts.projectId);

  const sql = `
    SELECT ${alias}.* FROM recall_fts fts
    JOIN recall_docs rd ON rd.id = fts.rowid
    JOIN ${table} ${alias} ON ${alias}.id = rd.doc_id
    WHERE ${conds.join(" AND ")}
    ORDER BY fts.rank
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, lim);
}

function filteredQuery(
  db: Database.Database,
  table: string,
  opts: RecallFilterOpts,
  lim: number,
  sortColumn = "created_at",
): unknown[] {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (opts.hasTags && opts.tags) {
    conds.push("tags LIKE ?");
    params.push(`%${opts.tags}%`);
  }
  if (opts.hasSession && opts.session_id !== undefined) {
    conds.push("session_id = ?");
    params.push(opts.session_id);
  }
  if (opts.since) {
    conds.push("created_at >= ?");
    params.push(opts.since);
  }
  conds.push(projectPredicate());
  params.push(opts.projectId);

  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM ${table} ${where} ORDER BY ${sortColumn} DESC LIMIT ?`,
    )
    .all(...params, lim);
}

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerMemoryTools(
  server: McpServer,
  db: Database.Database,
  projectId: number,
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
        INSERT INTO decisions (project_id, session_id, title, rationale, tags)
        VALUES (?, ?, ?, ?, ?)
      `);
        const result = stmt.run(
          projectId,
          resolveSessionId(db, session_id),
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
        INSERT INTO conventions (project_id, category, key, value, description, tags)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, category, key) DO UPDATE SET
          value = excluded.value,
          description = excluded.description,
          tags = excluded.tags,
          updated_at = datetime('now')
      `);
        const result = stmt.run(
          projectId,
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
        INSERT INTO errors (project_id, session_id, error_signature, description, resolution, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
        const result = stmt.run(
          projectId,
          resolveSessionId(db, session_id),
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
        INSERT INTO context (project_id, key, value, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(project_id, key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')
      `);
      stmt.run(projectId, key, value ?? null);
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
        .prepare(
          `SELECT key, value, updated_at FROM context WHERE key = ? AND ${projectPredicate()}`,
        )
        .get(key, projectId) as
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
        INSERT INTO changelog (project_id, session_id, summary, ref)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(
        projectId,
        resolveSessionId(db, session_id),
        summary,
        ref ?? null,
      );
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
        results.decisions = ftsSearch(
          db,
          "decisions",
          "d",
          text,
          {
            tags,
            session_id,
            since,
            hasSession: true,
            hasTags: true,
            projectId,
          },
          lim,
        );
        results.conventions = ftsSearch(
          db,
          "conventions",
          "c",
          text,
          {
            tags,
            session_id,
            since,
            hasSession: false,
            hasTags: true,
            projectId,
          },
          lim,
        );
        results.errors = ftsSearch(
          db,
          "errors",
          "e",
          text,
          {
            tags,
            session_id,
            since,
            hasSession: true,
            hasTags: true,
            projectId,
          },
          lim,
        );
        results.changelog = ftsSearch(
          db,
          "changelog",
          "ch",
          text,
          {
            tags,
            session_id,
            since,
            hasSession: true,
            hasTags: false,
            projectId,
          },
          lim,
        );
      } else {
        results.decisions = filteredQuery(
          db,
          "decisions",
          {
            tags,
            session_id,
            since,
            hasSession: true,
            hasTags: true,
            projectId,
          },
          lim,
        );
        results.conventions = filteredQuery(
          db,
          "conventions",
          {
            tags,
            session_id,
            since,
            hasSession: false,
            hasTags: true,
            projectId,
          },
          lim,
          "updated_at",
        );
        results.errors = filteredQuery(
          db,
          "errors",
          {
            tags,
            session_id,
            since,
            hasSession: true,
            hasTags: true,
            projectId,
          },
          lim,
        );
        results.changelog = filteredQuery(
          db,
          "changelog",
          {
            tags,
            session_id,
            since,
            hasSession: true,
            hasTags: false,
            projectId,
          },
          lim,
        );
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
