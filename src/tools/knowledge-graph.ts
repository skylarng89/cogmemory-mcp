// CogMemory MCP — Knowledge Graph tools: entities, relations, observations

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler, projectPredicate } from "./utils.js";
import type { ActiveProjectRef } from "../active-project.js";

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const CreateEntitySchema = z.object({
  name: z.string().min(1).describe("Entity name, e.g. 'Auth Service'"),
  type: z
    .string()
    .min(1)
    .describe(
      "Entity type: 'concept' | 'technology' | 'component' | 'spec' | custom",
    ),
});

export const CreateRelationSchema = z.object({
  from_entity_id: z.number().int().describe("Source entity ID"),
  to_entity_id: z.number().int().describe("Target entity ID"),
  relation_type: z
    .string()
    .min(1)
    .describe("Relation label: 'uses' | 'depends_on' | 'implements' | custom"),
});

export const AddObservationSchema = z.object({
  entity_id: z.number().int().describe("Entity to attach the observation to"),
  content: z.string().min(1).describe("Observation text / fact"),
});

export const SearchKnowledgeSchema = z.object({
  entity_name: z
    .string()
    .optional()
    .describe(
      "Search entities by name (FTS5 match — supports AND/OR/NOT, phrase)",
    ),
  entity_type: z.string().optional().describe("Filter entities by exact type"),
  relation_type: z
    .string()
    .optional()
    .describe("Search relations by type (LIKE match)"),
  observation_text: z
    .string()
    .optional()
    .describe(
      "Search observations by text (FTS5 match — supports AND/OR/NOT, phrase)",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max results per category (default 50)"),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerKnowledgeGraphTools(
  server: McpServer,
  db: Database.Database,
  activeProject: ActiveProjectRef,
): void {
  // ── create_entity ──
  server.registerTool(
    "create_entity",
    {
      description:
        "Add an entity to the knowledge graph (deduped on name+type)",
      inputSchema: CreateEntitySchema,
    },
    wrapHandler("create_entity", async ({ name, type }) => {
      const projectId = activeProject.get();
      const stmt = db.prepare(`
        INSERT INTO entities (project_id, name, type)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id, name, type) DO NOTHING
      `);
      const result = stmt.run(projectId, name, type);

      // Fetch the entity (either newly created or existing)
      const entity = db
        .prepare(
          `SELECT * FROM entities WHERE name = ? AND type = ? AND ${projectPredicate()}`,
        )
        .get(name, type, projectId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              created: result.changes > 0,
              entity,
            }),
          },
        ],
      };
    }),
  );

  // ── create_relation ──
  server.registerTool(
    "create_relation",
    {
      description: "Link two entities with a typed relation",
      inputSchema: CreateRelationSchema,
    },
    wrapHandler(
      "create_relation",
      async ({ from_entity_id, to_entity_id, relation_type }) => {
        const projectId = activeProject.get();
        // Validate both entities exist (and belong to this project)
        const fromEntity = db
          .prepare(
            `SELECT id FROM entities WHERE id = ? AND ${projectPredicate()}`,
          )
          .get(from_entity_id, projectId);
        const toEntity = db
          .prepare(
            `SELECT id FROM entities WHERE id = ? AND ${projectPredicate()}`,
          )
          .get(to_entity_id, projectId);

        if (!fromEntity) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `Source entity ${from_entity_id} not found`,
                }),
              },
            ],
          };
        }
        if (!toEntity) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: `Target entity ${to_entity_id} not found`,
                }),
              },
            ],
          };
        }

        const stmt = db.prepare(`
        INSERT INTO relations (project_id, from_entity_id, to_entity_id, relation_type)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, from_entity_id, to_entity_id, relation_type) DO NOTHING
      `);
        const result = stmt.run(
          projectId,
          from_entity_id,
          to_entity_id,
          relation_type,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                created: result.changes > 0,
                message: `Relation: entity ${from_entity_id} → ${relation_type} → entity ${to_entity_id}`,
              }),
            },
          ],
        };
      },
    ),
  );

  // ── add_observation ──
  server.registerTool(
    "add_observation",
    {
      description: "Attach a fact/observation to a knowledge graph entity",
      inputSchema: AddObservationSchema,
    },
    wrapHandler("add_observation", async ({ entity_id, content }) => {
      const projectId = activeProject.get();
      // Validate entity exists (and belongs to this project)
      const entity = db
        .prepare(
          `SELECT id FROM entities WHERE id = ? AND ${projectPredicate()}`,
        )
        .get(entity_id, projectId);

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

      const stmt = db.prepare(`
        INSERT INTO observations (project_id, entity_id, content)
        VALUES (?, ?, ?)
      `);
      const result = stmt.run(projectId, entity_id, content);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              id: result.lastInsertRowid,
              message: `Observation added to entity ${entity_id}`,
            }),
          },
        ],
      };
    }),
  );

  // ── search_knowledge ──
  server.registerTool(
    "search_knowledge",
    {
      description:
        "Query the knowledge graph: entities, relations, and observations by name, type, or text",
      inputSchema: SearchKnowledgeSchema,
    },
    wrapHandler(
      "search_knowledge",
      async ({
        entity_name,
        entity_type,
        relation_type,
        observation_text,
        limit,
      }) => {
        const projectId = activeProject.get();
        const lim = limit ?? 50;
        const results: Record<string, unknown[]> = {};

        // Entities — use FTS5 for name search, exact match for type
        if (entity_name || entity_type) {
          const entConds: string[] = [];
          const entParams: unknown[] = [];

          if (entity_name) {
            // FTS5 MATCH on entity names
            entConds.push(
              "e.id IN (SELECT doc_id FROM kg_docs kd JOIN kg_fts kf ON kf.rowid = kd.id WHERE kg_fts MATCH ? AND kd.source = 'entities')",
            );
            entParams.push(entity_name);
          }
          if (entity_type) {
            entConds.push("e.type = ?");
            entParams.push(entity_type);
          }
          entConds.push(projectPredicate("e"));
          entParams.push(projectId);

          const entWhere =
            entConds.length > 0 ? `WHERE ${entConds.join(" AND ")}` : "";
          results.entities = db
            .prepare(
              `SELECT e.* FROM entities e ${entWhere} ORDER BY e.created_at DESC LIMIT ?`,
            )
            .all(...entParams, lim);
        } else {
          results.entities = [];
        }

        // Relations — keep LIKE for relation_type (it's simple and fast on this column)
        if (relation_type) {
          results.relations = db
            .prepare(
              `SELECT r.*, fe.name as from_name, fe.type as from_type, te.name as to_name, te.type as to_type
             FROM relations r
             JOIN entities fe ON r.from_entity_id = fe.id
             JOIN entities te ON r.to_entity_id = te.id
             WHERE r.relation_type LIKE ? AND ${projectPredicate("r")}
             ORDER BY r.created_at DESC LIMIT ?`,
            )
            .all(`%${relation_type}%`, projectId, lim);
        } else {
          results.relations = [];
        }

        // Observations — use FTS5 for text search
        if (observation_text) {
          results.observations = db
            .prepare(
              `SELECT o.*, e.name as entity_name, e.type as entity_type
             FROM observations o
             JOIN entities e ON o.entity_id = e.id
             WHERE o.id IN (SELECT doc_id FROM kg_docs kd JOIN kg_fts kf ON kf.rowid = kd.id WHERE kg_fts MATCH ? AND kd.source = 'observations')
               AND ${projectPredicate("o")}
             ORDER BY o.created_at DESC LIMIT ?`,
            )
            .all(observation_text, projectId, lim);
        } else {
          results.observations = [];
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results),
            },
          ],
        };
      },
    ),
  );
}
