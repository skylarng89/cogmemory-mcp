// CogMemory MCP — Plan & Tasks tools

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler } from "./utils.js";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const AddPlanItemSchema = z.object({
  phase: z.string().optional().describe("Phase name, e.g. 'Phase 1'"),
  title: z.string().min(1).describe("Plan item title"),
  description: z.string().optional().describe("Detailed description"),
  status: z
    .enum(["planned", "in-progress", "done", "dropped"])
    .optional()
    .describe("Initial status (default: 'planned')"),
  order_index: z.number().int().optional().describe("Sort order (default: 0)"),
});

export const UpdatePlanStatusSchema = z.object({
  id: z.number().int().describe("Plan item ID"),
  status: z
    .enum(["planned", "in-progress", "done", "dropped"])
    .describe("New status"),
});

export const CreateTaskSchema = z.object({
  plan_id: z.number().int().optional().describe("Link to a plan item"),
  session_id: z.number().int().optional().describe("Current session ID"),
  title: z.string().min(1).describe("Task title"),
  description: z.string().optional().describe("Task description"),
  status: z
    .enum(["todo", "in-progress", "blocked", "done"])
    .optional()
    .describe("Initial status (default: 'todo')"),
  tags: z.string().optional().describe("Comma-separated tags"),
});

export const UpdateTaskStatusSchema = z.object({
  id: z.number().int().describe("Task ID"),
  status: z
    .enum(["todo", "in-progress", "blocked", "done"])
    .describe("New status"),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerPlanTasksTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── add_plan_item ──
  server.registerTool(
    "add_plan_item",
    {
      description: "Add a roadmap/plan item",
      inputSchema: AddPlanItemSchema,
    },
    wrapHandler(
      "add_plan_item",
      async ({ phase, title, description, status, order_index }) => {
        const stmt = db.prepare(`
        INSERT INTO plan (phase, title, description, status, order_index)
        VALUES (?, ?, ?, ?, ?)
      `);
        const result = stmt.run(
          phase ?? null,
          title,
          description ?? null,
          status ?? "planned",
          order_index ?? 0,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                id: result.lastInsertRowid,
                message: `Plan item added: "${title}"`,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── update_plan_status ──
  server.registerTool(
    "update_plan_status",
    {
      description: "Update the status of a plan item",
      inputSchema: UpdatePlanStatusSchema,
    },
    wrapHandler("update_plan_status", async ({ id, status }) => {
      const stmt = db.prepare(`
        UPDATE plan SET status = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      const result = stmt.run(status, id);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Plan item ${id} not found`,
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
              message: `Plan item ${id} status → ${status}`,
            }),
          },
        ],
      };
    }),
  );

  // ── create_task ──
  server.registerTool(
    "create_task",
    {
      description:
        "Create an actionable task, optionally linked to a plan item",
      inputSchema: CreateTaskSchema,
    },
    wrapHandler(
      "create_task",
      async ({ plan_id, session_id, title, description, status, tags }) => {
        const stmt = db.prepare(`
        INSERT INTO tasks (plan_id, session_id, title, description, status, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
        const result = stmt.run(
          plan_id ?? null,
          session_id ?? null,
          title,
          description ?? null,
          status ?? "todo",
          tags ?? null,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                id: result.lastInsertRowid,
                message: `Task created: "${title}"`,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── update_task_status ──
  server.registerTool(
    "update_task_status",
    {
      description: "Update the status of a task",
      inputSchema: UpdateTaskStatusSchema,
    },
    wrapHandler("update_task_status", async ({ id, status }) => {
      const stmt = db.prepare(`
        UPDATE tasks SET status = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      const result = stmt.run(status, id);
      if (result.changes === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Task ${id} not found`,
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
              message: `Task ${id} status → ${status}`,
            }),
          },
        ],
      };
    }),
  );
}
