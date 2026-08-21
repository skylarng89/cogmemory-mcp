// CogMemory MCP — Shared TypeScript types mirroring the SQLite schema

// ─── MEMORY ───────────────────────────────────────────────

export interface Session {
  id: number;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export interface Decision {
  id: number;
  session_id: number | null;
  title: string;
  rationale: string | null;
  tags: string | null;
  created_at: string;
}

export interface Convention {
  id: number;
  category: string;
  key: string;
  value: string | null;
  description: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErrorEntry {
  id: number;
  session_id: number | null;
  error_signature: string;
  description: string | null;
  resolution: string | null;
  tags: string | null;
  created_at: string;
}

export interface ContextEntry {
  key: string;
  value: string | null;
  updated_at: string;
}

export interface ChangelogEntry {
  id: number;
  session_id: number | null;
  summary: string;
  ref: string | null;
  created_at: string;
}

export interface PlanItem {
  id: number;
  phase: string | null;
  title: string;
  description: string | null;
  status: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  plan_id: number | null;
  session_id: number | null;
  title: string;
  description: string | null;
  status: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

// ─── KNOWLEDGE GRAPH ──────────────────────────────────────

export interface Entity {
  id: number;
  name: string;
  type: string;
  created_at: string;
}

export interface Relation {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relation_type: string;
  created_at: string;
}

export interface Observation {
  id: number;
  entity_id: number;
  content: string;
  created_at: string;
}

// ─── SPECS ────────────────────────────────────────────────

export interface Spec {
  id: number;
  entity_id: number | null;
  title: string;
  content: string;
  format: string;
  version: number;
  created_at: string;
  updated_at: string;
}

// ─── CODE GRAPH ───────────────────────────────────────────

export interface Symbol {
  id: number;
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  start_line: number | null;
  end_line: number | null;
  updated_at: string;
}

export interface Edge {
  id: number;
  from_symbol_id: number;
  to_symbol_id: number;
  edge_type: string;
  created_at: string;
}

export interface ExecutionTrace {
  id: number;
  name: string;
  description: string | null;
  symbol_sequence: string; // JSON array of symbol ids
  created_at: string;
}

export interface CodemapAnnotation {
  id: number;
  symbol_id: number | null;
  trace_id: number | null;
  annotation: string;
  created_at: string;
}

// ─── CODE GRAPH QUERY RESULTS ─────────────────────────────

export interface SymbolWithRelations {
  symbol: Symbol;
  callers: Symbol[];
  callees: Symbol[];
  imports: Symbol[];
}

export interface CodemapNode {
  symbol: Symbol;
  depth: number;
}

export interface CodemapResult {
  nodes: CodemapNode[];
  edges: Edge[];
  traces?: ExecutionTrace[];
  annotations?: CodemapAnnotation[];
}
