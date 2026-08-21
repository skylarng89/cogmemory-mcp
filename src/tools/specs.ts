// CogMemory MCP — Specs tools: long-form document CRUD

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const CreateSpecSchema = z.object({
  title: z
    .string()
    .describe("Spec title, e.g. 'Product Requirements Document'"),
  content: z
    .string()
    .describe("Full document content (markdown or plain text)"),
  format: z
    .enum(["markdown", "text"])
    .optional()
    .describe("Content format (default: 'markdown')"),
  entity_id: z
    .number()
    .int()
    .optional()
    .describe("Link to a knowledge graph entity"),
});

export const GetSpecSchema = z
  .object({
    id: z.number().int().optional().describe("Spec ID"),
    title: z.string().optional().describe("Spec title (exact match)"),
  })
  .refine((data) => data.id !== undefined || data.title !== undefined, {
    message: "Either id or title must be provided",
  });

export const UpdateSpecSchema = z.object({
  id: z.number().int().describe("Spec ID to update"),
  content: z.string().optional().describe("New content"),
  title: z.string().optional().describe("New title"),
  entity_id: z.number().int().optional().describe("New linked entity ID"),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerSpecsTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── create_spec ──
  server.registerTool(
    "create_spec",
    {
      description:
        "Store a long-form document (PRD, SRS, design doc), optionally linked to a knowledge graph entity",
      inputSchema: CreateSpecSchema,
    },
    async ({ title, content, format, entity_id }) => {
      // Validate entity_id if provided
      if (entity_id !== undefined) {
        const entity = db
          .prepare("SELECT id FROM entities WHERE id = ?")
          .get(entity_id);
        if (!entity) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `Entity ${entity_id} not found`,
                }),
              },
            ],
          };
        }
      }

      const stmt = db.prepare(`
        INSERT INTO specs (entity_id, title, content, format)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(
        entity_id ?? null,
        title,
        content,
        format ?? "markdown",
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              id: result.lastInsertRowid,
              message: `Spec created: "${title}"`,
            }),
          },
        ],
      };
    },
  );

  // ── get_spec ──
  server.registerTool(
    "get_spec",
    {
      description: "Retrieve a spec by ID or exact title",
      inputSchema: GetSpecSchema,
    },
    async ({ id, title }) => {
      let spec: Record<string, unknown> | undefined;

      if (id !== undefined) {
        spec = db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as
          | Record<string, unknown>
          | undefined;
      } else if (title) {
        spec = db.prepare("SELECT * FROM specs WHERE title = ?").get(title) as
          | Record<string, unknown>
          | undefined;
      }

      if (!spec) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: "Spec not found",
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, spec }),
          },
        ],
      };
    },
  );

  // ── update_spec ──
  server.registerTool(
    "update_spec",
    {
      description:
        "Update a spec's content, title, or entity link (auto-bumps version)",
      inputSchema: UpdateSpecSchema,
    },
    async ({ id, content, title, entity_id }) => {
      // Fetch current spec
      const current = db.prepare("SELECT * FROM specs WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;

      if (!current) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Spec ${id} not found`,
              }),
            },
          ],
        };
      }

      // Validate entity_id if provided
      if (entity_id !== undefined) {
        const entity = db
          .prepare("SELECT id FROM entities WHERE id = ?")
          .get(entity_id);
        if (!entity) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `Entity ${entity_id} not found`,
                }),
              },
            ],
          };
        }
      }

      const newContent = content ?? current.content;
      const newTitle = title ?? current.title;
      const newEntityId =
        entity_id !== undefined ? entity_id : current.entity_id;

      const stmt = db.prepare(`
        UPDATE specs
        SET content = ?, title = ?, entity_id = ?,
            version = version + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `);
      stmt.run(newContent, newTitle, newEntityId, id);

      const updated = db.prepare("SELECT * FROM specs WHERE id = ?").get(id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              spec: updated,
              message: `Spec ${id} updated`,
            }),
          },
        ],
      };
    },
  );
}
