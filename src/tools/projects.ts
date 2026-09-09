// CogMemory MCP — Project housekeeping tools: list_projects, rename_project, prune_projects

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { wrapHandler, jsonOk } from "./utils.js";
import type { Project } from "../types.js";
import {
  resolveProjectIdentity,
  type Scope,
  type ResolutionSource,
} from "../config.js";
import type { ActiveProjectRef } from "../active-project.js";

// ─── Constants ───────────────────────────────────────────

/** Projects not seen for this many days are flagged as stale. */
const STALE_AFTER_DAYS = 90;

/** Tables that carry a project_id column (used for row counts and pruning). */
const PROJECT_SCOPED_TABLES = [
  "sessions",
  "decisions",
  "conventions",
  "errors",
  "context",
  "changelog",
  "plan",
  "tasks",
  "entities",
  "relations",
  "observations",
  "specs",
  "file_index",
  "symbols",
  "edges",
  "execution_traces",
  "codemap_annotations",
  "index_errors",
] as const;

// ─── Helpers ─────────────────────────────────────────────

function isStale(lastSeenAt: string): boolean {
  const last = new Date(lastSeenAt.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(last)) return false;
  return Date.now() - last > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

function countProjectRows(
  db: Database.Database,
  projectId: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of PROJECT_SCOPED_TABLES) {
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE project_id = ?`)
        .get(projectId) as { cnt: number };
      counts[table] = row.cnt;
    } catch {
      counts[table] = -1;
    }
  }
  return counts;
}

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const RenameProjectSchema = z.object({
  id: z.number().int().describe("Project ID to rename"),
  label: z.string().min(1).describe("New display label (slug is immutable)"),
});

export const PruneProjectSchema = z.object({
  id: z.number().int().describe("Project ID to delete"),
  confirm: z
    .boolean()
    .describe(
      "Must be true to proceed — this permanently deletes the project and ALL of its memories",
    ),
});

export const SwitchProjectSchema = z.object({
  root_dir: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the workspace root of the project to switch to (e.g. a git repository root)",
    ),
});

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerProjectTools(
  server: McpServer,
  db: Database.Database,
  activeProject: ActiveProjectRef,
  bootWorkspaceRoot: string,
  scope: Scope,
  resolutionSource?: ResolutionSource,
): void {
  // ── list_projects ──
  server.registerTool(
    "list_projects",
    {
      description:
        "List all projects known to this CogMemory database, with row counts, last-seen timestamps, and staleness flags. The active project is marked.",
      inputSchema: z.object({}),
    },
    wrapHandler("list_projects", async () => {
      const projects = db
        .prepare(
          "SELECT id, slug, label, root_path_hint, created_at, last_seen_at FROM projects ORDER BY last_seen_at DESC",
        )
        .all() as Project[];

      const enriched = projects.map((p) => ({
        ...p,
        is_active: p.id === activeProject.get(),
        is_stale: isStale(p.last_seen_at),
        row_counts: countProjectRows(db, p.id),
      }));

      return jsonOk({
        success: true,
        total: enriched.length,
        projects: enriched,
      });
    }),
  );

  // ── rename_project ──
  server.registerTool(
    "rename_project",
    {
      description:
        "Rename a project's display label. The slug (identity) is immutable — renaming never affects memory continuity.",
      inputSchema: RenameProjectSchema,
    },
    wrapHandler("rename_project", async ({ id, label }) => {
      const result = db
        .prepare("UPDATE projects SET label = ? WHERE id = ?")
        .run(label, id);
      if (result.changes === 0) {
        return jsonOk({
          success: false,
          message: `Project ${id} not found`,
        });
      }
      return jsonOk({
        success: true,
        message: `Project ${id} label set to "${label}"`,
      });
    }),
  );

  // ── prune_projects ──
  server.registerTool(
    "prune_projects",
    {
      description:
        "Permanently delete a project and ALL of its memories (decisions, conventions, errors, sessions, code graph, etc.). Requires confirm=true. Irreversible.",
      inputSchema: PruneProjectSchema,
    },
    wrapHandler("prune_projects", async ({ id, confirm }) => {
      if (!confirm) {
        return jsonOk({
          success: false,
          message:
            "Pass confirm=true to prune_projects — this deletes the project and all of its rows",
        });
      }
      const activeId = activeProject.get();
      if (id === activeId) {
        return jsonOk({
          success: false,
          message:
            "Cannot prune the active project. Use switch_project to switch to a different project first, or use purge_subsystem to clear specific data instead.",
        });
      }

      const project = db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(id) as Project | undefined;
      if (!project) {
        return jsonOk({
          success: false,
          message: `Project ${id} not found`,
        });
      }

      const deleted = countProjectRows(db, id);
      db.transaction(() => {
        for (const table of PROJECT_SCOPED_TABLES) {
          db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
        }
        db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      })();

      return jsonOk({
        success: true,
        message: `Pruned project ${id} (${project.label ?? project.slug})`,
        deleted,
      });
    }),
  );

  // ── switch_project ──
  server.registerTool(
    "switch_project",
    {
      description:
        "Re-resolve the active project from a workspace root at runtime. Use when the MCP client pinned a stale --workspace/cwd that does not match the project being worked on (the agent can self-correct without restarting the server). Creates and persists a new project identity if the root has none.",
      inputSchema: SwitchProjectSchema,
    },
    wrapHandler("switch_project", async ({ root_dir }) => {
      // Fail-closed: never mutate the active project on an invalid path.
      const target = resolve(root_dir);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        return jsonOk({
          success: false,
          message: `root_dir does not exist or is not a directory: ${target} — active project unchanged`,
        });
      }

      try {
        const identity = resolveProjectIdentity(target, db, scope);
        activeProject.set(identity.projectId);
        return jsonOk({
          success: true,
          message: `Active project is now "${identity.label}" [${identity.slug.slice(0, 8)}…] (root: ${target})`,
          project: {
            id: identity.projectId,
            slug: identity.slug,
            label: identity.label,
            is_new_project: identity.isNewProject,
          },
          previous_boot_root: bootWorkspaceRoot,
          boot_resolution_source: resolutionSource ?? null,
        });
      } catch (err) {
        return jsonOk({
          success: false,
          message: `Failed to resolve project identity for ${target}: ${err instanceof Error ? err.message : String(err)} — active project unchanged`,
        });
      }
    }),
  );
}
