// CogMemory MCP — Mutable active project reference (ADR-9)

/**
 * Mutable holder for the active project id. All tool handlers read via
 * `get()` at call time rather than closing over a boot-time constant, so
 * `switch_project` can re-resolve identity mid-session.
 */
export interface ActiveProjectRef {
  get(): number;
  set(id: number): void;
}

export function createActiveProjectRef(initial: number): ActiveProjectRef {
  let current = initial;
  return {
    get: () => current,
    set: (id: number) => {
      current = id;
    },
  };
}
