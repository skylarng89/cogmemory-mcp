// CogMemory MCP — Edge type constants

export const EDGE_TYPES = {
  CALLS: "calls",
  IMPORTS: "imports",
  EXTENDS: "extends",
  IMPLEMENTS: "implements",
  SIMILAR_TO: "similarto",
  SEMANTICALLY_RELATED: "semrelated",
} as const;

export const STRUCTURAL_EDGE_TYPES: readonly string[] = [
  EDGE_TYPES.CALLS,
  EDGE_TYPES.IMPORTS,
  EDGE_TYPES.EXTENDS,
  EDGE_TYPES.IMPLEMENTS,
] as const;

export const ALL_EDGE_TYPES: readonly string[] = [
  ...STRUCTURAL_EDGE_TYPES,
  EDGE_TYPES.SIMILAR_TO,
  EDGE_TYPES.SEMANTICALLY_RELATED,
] as const;