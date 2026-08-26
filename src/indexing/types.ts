// CogMemory MCP — LanguageAnalyzer interface and shared indexing types
//
// All language analyzers must conform to the LanguageAnalyzer contract.
// Types are intentionally minimal so new languages can be added cheaply.

/**
 * A symbol extracted from a source file by a language analyzer.
 */
export interface ExtractedSymbol {
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  start_line: number | null;
  end_line: number | null;
  is_exported?: boolean;
}

/**
 * A directed edge between two symbols, originating from a single source file.
 */
export interface ExtractedEdge {
  from_file: string;
  from_name: string;
  from_start_line: number | null;
  to_file: string;
  to_name: string;
  to_start_line: number | null;
  edge_type: string;
}

/**
 * Combined extraction result from a single analyzer invocation.
 */
export interface AnalysisResult {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

/**
 * Contract every language analyzer must satisfy.
 *
 * - `extensions` lists the file extensions this analyzer handles (with leading dot,
 *   e.g. ".ts", ".py"). The registry uses these to dispatch files.
 * - `analyze(files, rootDir)` processes a batch of absolute file paths and returns
 *   extracted symbols + edges.  Files are guaranteed to belong to this analyzer.
 */
export interface LanguageAnalyzer {
  /** File extensions this analyzer handles, e.g. [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] */
  readonly extensions: readonly string[];

  /**
   * Analyze a batch of files and extract symbols + edges.
   * @param files Absolute file paths (guaranteed to match `extensions`).
   * @param rootDir Absolute path to the workspace root, used for relative path computation.
   */
  analyze(files: string[], rootDir: string): AnalysisResult;
}