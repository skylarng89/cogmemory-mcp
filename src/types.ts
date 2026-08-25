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

// Extended Symbol with v1.1.0 columns (mutable via ALTER TABLE migrations)
export interface SymbolExtended extends Symbol {
  is_exported: number;   // 0 or 1
  body_hash: string | null;
  token_count: number | null;
}

export interface Edge {
  id: number;
  from_symbol_id: number;
  to_symbol_id: number;
  edge_type: string;
  created_at: string;
}

// Extended Edge with v1.1.0 metadata column
export interface EdgeExtended extends Edge {
  metadata: string | null; // JSON: {score, algorithm, ...}
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

// ─── CODE GRAPH: NEW TABLES (v1.1.0 migrations 003–007) ───

export interface IndexError {
  id: number;
  file_path: string;
  error_type: string;      // 'parse' | 'resolve' | 'io'
  error_message: string;
  occurred_at: string;
}

export interface SymbolToken {
  symbol_id: number;
  token: string;
  tf: number;
}

export interface SymbolMinhash {
  symbol_id: number;
  signature: string;       // JSON array of integer hashes
  num_hashes: number;
  shingle_k: number;
  computed_at: string;
}

export interface SymbolEmbedding {
  symbol_id: number;
  embedding: string | null; // BLOB (base64 if serialized)
  model: string;
  dim: number;
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
