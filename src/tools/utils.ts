// CogMemory MCP — Shared tool utilities

import type Database from "better-sqlite3";
import { z } from "zod";
import type { ProjectRuntime, ProjectContext } from "../active-project.js";

export function projectSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.extend({
    expected_project_id: z.uuid().optional().describe(
      "Optional workspace UUID from project_identity.slug or cogmemory_status. Detects stale chat context; never use the numeric database project ID here.",
    ),
  });
}

type ToolContent = { type: "text"; text: string };
type ToolResponse = { content: ToolContent[]; isError?: boolean };

/** Return a success response with JSON-serialized data */
export function jsonOk(obj: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  };
}

/** Return a failure response (success: false, no isError flag) */
export function jsonFail(message: string): ToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, message }),
      },
    ],
  };
}

/** Return an error response with isError: true — signals MCP protocol-level error */
export function jsonErr(toolName: string, err: unknown): ToolResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          message: `${toolName}: ${message}`,
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Wrap a tool handler with try/catch.
 * Catches any thrown error and returns an MCP-compliant error response
 * instead of letting the raw error propagate.
 */
export function wrapProjectHandler<T extends Record<string, unknown>>(
  runtime: ProjectRuntime,
  name: string,
  handler: (params: T, context: ProjectContext) => Promise<ToolResponse>,
): (params: T) => Promise<ToolResponse> {
  return async (params: T) => {
    try {
      return await runtime.run(name, async context => {
        if (params.expected_project_id && params.expected_project_id !== context.slug) {
          return jsonOk({ success: false, code: "PROJECT_MISMATCH",
            expected_project_id: params.expected_project_id,
            project_identity: projectIdentity(context),
            message: "The cached project UUID does not match this workspace. Check cogmemory_status and call switch_project with the intended absolute workspace root before retrying. No operation was performed.",
          });
        }
        const warnings: string[] = [];
        if (["remember_decision", "log_error", "log_change", "create_task"].includes(name)) {
          if (typeof params.session_id === "number" && resolveSessionId(context.db, params.session_id, context.projectId) === null) {
            warnings.push("Stale session_id ignored: memory saved without a session link. Use start_session or list_items(subsystem: sessions) for this project.");
          }
          if (typeof params.plan_id === "number" && resolvePlanId(context.db, params.plan_id, context.projectId) === null) {
            warnings.push("Stale plan_id ignored: task saved without a plan link. List this project's plan items to select a valid ID.");
          }
        }
        const response = await handler(params, context);
        const identity = projectIdentity(name === "switch_project" ? runtime.current : context);
        return { ...response, content: response.content.map(item => ({ ...item,
          text: JSON.stringify({ ...JSON.parse(item.text), project_identity: identity,
            ...(warnings.length ? { warnings } : {}) }),
        })) };
      });
    } catch (err) {
      return jsonErr(name, err);
    }
  };
}

function projectIdentity(context: ProjectContext) {
  return { id: context.projectId, slug: context.slug, workspace_root: context.workspaceRoot };
}

/**
 * Validate that a session_id exists in the sessions table.
 * Returns the ID if valid, or null if the ID is undefined/null or doesn't exist.
 * This prevents FOREIGN KEY constraint failures when a stale or invalid
 * session_id is passed by the caller (e.g. an AI agent with cached IDs).
 */
export function resolveSessionId(
  db: Database.Database,
  session_id: number | undefined,
  projectId: number,
): number | null {
  if (session_id === undefined || session_id === null) {
    return null;
  }
  const exists = db
    .prepare("SELECT 1 FROM sessions WHERE id = ? AND project_id = ?")
    .get(session_id, projectId);
  return exists ? session_id : null;
}

/**
 * Validate that a plan_id exists in the plan table.
 * Returns the ID if valid, or null if the ID is undefined/null or doesn't exist.
 */
export function resolvePlanId(
  db: Database.Database,
  plan_id: number | undefined,
  projectId: number,
): number | null {
  if (plan_id === undefined || plan_id === null) {
    return null;
  }
  const exists = db.prepare("SELECT 1 FROM plan WHERE id = ? AND project_id = ?").get(plan_id, projectId);
  return exists ? plan_id : null;
}

/**
 * Build a WHERE-clause fragment scoping queries to a single project.
 *
 * - `whereWith("d")` → "d.project_id = ?"
 * - `whereWith()` → "project_id = ?" (unaliased)
 *
 * Use with the projectId param appended to the query's bound parameters.
 */
export function projectPredicate(alias?: string): string {
  return alias ? `${alias}.project_id = ?` : "project_id = ?";
}

/**
 * Append a project predicate to an existing WHERE fragment list.
 * Mutates nothing — returns a new array with the predicate added.
 */
export function withProject(
  conds: string[],
  projectId: number,
  alias?: string,
): { conds: string[]; param: number } {
  return { conds: [...conds, projectPredicate(alias)], param: projectId };
}
