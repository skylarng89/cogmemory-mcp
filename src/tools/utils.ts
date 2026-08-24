// CogMemory MCP — Shared tool utilities

import type Database from "better-sqlite3";

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
export function wrapHandler<T extends Record<string, unknown>>(
  name: string,
  handler: (params: T) => Promise<ToolResponse>,
): (params: T) => Promise<ToolResponse> {
  return async (params: T) => {
    try {
      return await handler(params);
    } catch (err) {
      return jsonErr(name, err);
    }
  };
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
): number | null {
  if (session_id === undefined || session_id === null) {
    return null;
  }
  const exists = db
    .prepare("SELECT 1 FROM sessions WHERE id = ?")
    .get(session_id);
  return exists ? session_id : null;
}

/**
 * Validate that a plan_id exists in the plan table.
 * Returns the ID if valid, or null if the ID is undefined/null or doesn't exist.
 */
export function resolvePlanId(
  db: Database.Database,
  plan_id: number | undefined,
): number | null {
  if (plan_id === undefined || plan_id === null) {
    return null;
  }
  const exists = db.prepare("SELECT 1 FROM plan WHERE id = ?").get(plan_id);
  return exists ? plan_id : null;
}
