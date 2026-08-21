// CogMemory MCP — Session tools

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const StartSessionSchema = z.object({});

export const EndSessionSchema = z.object({
  id: z.number().int().describe("Session ID to close"),
  summary: z
    .string()
    .optional()
    .describe("Summary of what happened in this session"),
});

export const GetSessionSummarySchema = z.object({
  id: z.number().int().describe("Session ID to recall"),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerSessionTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── start_session ──
  server.registerTool(
    "start_session",
    {
      description: "Begin a new work session (returns session ID)",
      inputSchema: StartSessionSchema,
    },
    async () => {
      const stmt = db.prepare("INSERT INTO sessions DEFAULT VALUES");
      const result = stmt.run();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              id: result.lastInsertRowid,
              message: `Session ${result.lastInsertRowid} started`,
            }),
          },
        ],
      };
    },
  );

  // ── end_session ──
  server.registerTool(
    "end_session",
    {
      description: "Close a work session and optionally store a summary",
      inputSchema: EndSessionSchema,
    },
    async ({ id, summary }) => {
      const stmt = db.prepare(`
        UPDATE sessions
        SET ended_at = datetime('now'), summary = ?
        WHERE id = ?
      `);
      const result = stmt.run(summary ?? null, id);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Session ${id} not found`,
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
              message: `Session ${id} ended`,
            }),
          },
        ],
      };
    },
  );

  // ── get_session_summary ──
  server.registerTool(
    "get_session_summary",
    {
      description:
        "Recall what happened in a previous session, including its decisions, errors, and changelog entries",
      inputSchema: GetSessionSummarySchema,
    },
    async ({ id }) => {
      const session = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Session ${id} not found`,
              }),
            },
          ],
        };
      }

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at",
        )
        .all(id);

      const errors = db
        .prepare(
          "SELECT * FROM errors WHERE session_id = ? ORDER BY created_at",
        )
        .all(id);

      const changelog = db
        .prepare(
          "SELECT * FROM changelog WHERE session_id = ? ORDER BY created_at",
        )
        .all(id);

      const tasks = db
        .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at")
        .all(id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session,
              decisions,
              errors,
              changelog,
              tasks,
            }),
          },
        ],
      };
    },
  );
}
