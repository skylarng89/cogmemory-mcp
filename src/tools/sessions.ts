// CogMemory MCP — Session tools

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapProjectHandler, projectSchema, projectPredicate } from "./utils.js";
import type { ProjectRuntime } from "../active-project.js";

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
  runtime: ProjectRuntime,
): void {
  // ── start_session ──
  server.registerTool(
    "start_session",
    {
      description: "Begin a new work session (returns session ID)",
      inputSchema: projectSchema(StartSessionSchema),
    },
    wrapProjectHandler(runtime, "start_session", async (_params, { db, projectId }) => {
      const stmt = db.prepare("INSERT INTO sessions (project_id) VALUES (?)");
      const result = stmt.run(projectId);
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
    }),
  );

  // ── end_session ──
  server.registerTool(
    "end_session",
    {
      description: "Close a work session and optionally store a summary",
      inputSchema: projectSchema(EndSessionSchema),
    },
    wrapProjectHandler(runtime, "end_session", async ({ id, summary }, { db, projectId }) => {
      const stmt = db.prepare(`
        UPDATE sessions
        SET ended_at = datetime('now'), summary = ?
        WHERE id = ? AND project_id = ?
      `);
      const result = stmt.run(summary ?? null, id, projectId);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Session ${id} not found in the active project. Call start_session or list_items with subsystem sessions.`,
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
    }),
  );

  // ── get_session_summary ──
  server.registerTool(
    "get_session_summary",
    {
      description:
        "Recall what happened in a previous session, including its decisions, errors, and changelog entries",
      inputSchema: projectSchema(GetSessionSummarySchema),
    },
    wrapProjectHandler(runtime, "get_session_summary", async ({ id }, { db, projectId }) => {
      const session = db
        .prepare("SELECT * FROM sessions WHERE id = ? AND project_id = ?")
        .get(id, projectId) as Record<string, unknown> | undefined;

      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Session ${id} not found in the active project. Call start_session or list_items with subsystem sessions.`,
              }),
            },
          ],
        };
      }

      const decisions = db
        .prepare(
          `SELECT * FROM decisions WHERE session_id = ? AND ${projectPredicate()} ORDER BY created_at`,
        )
        .all(id, projectId);

      const errors = db
        .prepare(
          `SELECT * FROM errors WHERE session_id = ? AND ${projectPredicate()} ORDER BY created_at`,
        )
        .all(id, projectId);

      const changelog = db
        .prepare(
          `SELECT * FROM changelog WHERE session_id = ? AND ${projectPredicate()} ORDER BY created_at`,
        )
        .all(id, projectId);

      const tasks = db
        .prepare(
          `SELECT * FROM tasks WHERE session_id = ? AND ${projectPredicate()} ORDER BY created_at`,
        )
        .all(id, projectId);

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
    }),
  );
}
