// CogMemory MCP — Shared tool utilities

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
