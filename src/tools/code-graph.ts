// CogMemory MCP — Code Graph tools: index_codebase, query_code_graph

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { walkFilesWithMtime } from "../indexing/walker.js";
import {
  analyzeMixed,
  getSupportedExtensions,
} from "../indexing/analyzer-registry.js";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { wrapHandler, jsonOk, projectPredicate } from "./utils.js";
// EDGE_TYPES and STRUCTURAL_EDGE_TYPES are imported but not used in this file
// They were previously used for validation but are no longer needed

/** Default extensions derived from the analyzer registry. */
function getDefaultExtensions(): string[] {
  // Strip leading dots for the walker (which expects bare extensions).
  return getSupportedExtensions().map((e) => e.replace(/^\./, ""));
}

// ─── Tokenizer (same as code-analysis.ts) ───────────────

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "but",
  "and",
  "or",
  "if",
  "while",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "what",
  "which",
  "who",
  "whom",
  "function",
  "const",
  "let",
  "var",
  "return",
  "import",
  "from",
  "export",
  "default",
  "class",
  "interface",
  "type",
  "enum",
  "async",
  "await",
  "def",
  "self",
  "lambda",
  "yield",
  "pass",
  "raise",
  "try",
  "except",
  "finally",
  "with",
  "as",
  "global",
  "nonlocal",
  "assert",
  "del",
]);

function tokenizeSymbolBody(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function computeBodyHash(bodyText: string): string {
  return createHash("sha256").update(bodyText).digest("hex").slice(0, 16);
}

// ─── Schema-aware column check ──────────────────────────

function tableHasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  try {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).get();
    return true;
  } catch {
    return false;
  }
}

// ─── Index helper functions ───────────────────────────────

interface ClassifyResult {
  filesToAnalyze: string[];
  deletedFiles: string[];
}

function classifyFiles(
  currentFiles: Map<string, number>,
  storedFiles: Map<string, number>,
  isFull: boolean,
  db: Database.Database,
  projectId: number,
): ClassifyResult {
  if (isFull) {
    const p = projectPredicate();
    db.prepare(`DELETE FROM edges WHERE ${p}`).run(projectId);
    db.prepare(`DELETE FROM symbols WHERE ${p}`).run(projectId);
    db.prepare(`DELETE FROM file_index WHERE ${p}`).run(projectId);
    // Also clear derived tables if they exist
    try {
      db.prepare(
        `DELETE FROM symbol_tokens WHERE symbol_id IN (SELECT id FROM symbols WHERE ${p})`,
      ).run(projectId);
    } catch {
      /* table may not exist */
    }
    try {
      db.prepare(
        `DELETE FROM symbol_minhash WHERE symbol_id IN (SELECT id FROM symbols WHERE ${p})`,
      ).run(projectId);
    } catch {
      /* table may not exist */
    }
    return { filesToAnalyze: [...currentFiles.keys()], deletedFiles: [] };
  }

  const newFiles: string[] = [];
  const changedFiles: string[] = [];
  for (const [path, mtime] of currentFiles) {
    const storedMtime = storedFiles.get(path);
    if (storedMtime === undefined) {
      newFiles.push(path);
    } else if (storedMtime !== mtime) {
      changedFiles.push(path);
    }
  }

  const deletedFiles: string[] = [];
  for (const [path] of storedFiles) {
    if (!currentFiles.has(path)) {
      deletedFiles.push(path);
    }
  }

  const filesToDelete = [...deletedFiles, ...changedFiles];
  if (filesToDelete.length > 0) {
    const p = projectPredicate();
    const deleteSymbols = db.prepare(
      `DELETE FROM symbols WHERE file_path = ? AND ${p}`,
    );
    const deleteFileIdx = db.prepare(
      `DELETE FROM file_index WHERE file_path = ? AND ${p}`,
    );
    db.transaction(() => {
      for (const path of filesToDelete) {
        deleteSymbols.run(path, projectId);
        deleteFileIdx.run(path, projectId);
      }
    })();
  }

  return { filesToAnalyze: [...newFiles, ...changedFiles], deletedFiles };
}

function buildSymbolIdMap(
  isFull: boolean,
  db: Database.Database,
  projectId: number,
): Map<string, number> {
  const symbolIdMap = new Map<string, number>();
  if (!isFull) {
    const existingSymbols = db
      .prepare(
        `SELECT id, file_path, symbol_name, start_line FROM symbols WHERE ${projectPredicate()}`,
      )
      .all(projectId) as {
      id: number;
      file_path: string;
      symbol_name: string;
      start_line: number;
    }[];
    for (const sym of existingSymbols) {
      symbolIdMap.set(
        `${sym.file_path}:${sym.symbol_name}:${sym.start_line}`,
        sym.id,
      );
    }
  }
  return symbolIdMap;
}

function resolveSymbolId(
  symbolIdMap: Map<string, number>,
  file: string,
  name: string,
  startLine: number | null,
): number | undefined {
  const exact = symbolIdMap.get(`${file}:${name}:${startLine}`);
  if (exact) return exact;
  const prefix = `${file}:${name}:`;
  for (const [key, id] of symbolIdMap) {
    if (key.startsWith(prefix)) return id;
  }
  return undefined;
}

function analyzeAndInsert(
  filesToAnalyze: string[],
  targetDir: string,
  db: Database.Database,
  symbolIdMap: Map<string, number>,
  projectId: number,
): { newSymbolCount: number; newEdgeCount: number } {
  if (filesToAnalyze.length === 0) {
    return { newSymbolCount: 0, newEdgeCount: 0 };
  }

  const result = analyzeMixed(filesToAnalyze, targetDir);

  // Detect schema capabilities
  const hasExported = tableHasColumn(db, "symbols", "is_exported");
  const hasBodyHash = tableHasColumn(db, "symbols", "body_hash");
  const hasTokenCount = tableHasColumn(db, "symbols", "token_count");
  const hasTokensTable = tableExists(db, "symbol_tokens");

  // Prepare the correct INSERT statement based on available columns
  let insertSymbol: Database.Statement;
  if (hasExported && hasBodyHash && hasTokenCount) {
    insertSymbol = db.prepare(`
      INSERT INTO symbols (project_id, file_path, symbol_name, symbol_type, start_line, end_line, is_exported, body_hash, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  } else {
    insertSymbol = db.prepare(`
      INSERT INTO symbols (project_id, file_path, symbol_name, symbol_type, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  // Prepare token insert if table exists
  const insertToken = hasTokensTable
    ? db.prepare(
        "INSERT OR IGNORE INTO symbol_tokens (symbol_id, token, tf) VALUES (?, ?, ?)",
      )
    : null;

  const fileCache = new Map<string, string[]>();

  function getFileLines(filePath: string): string[] {
    if (fileCache.has(filePath)) return fileCache.get(filePath)!;
    const absPath = resolve(targetDir, filePath);
    let lines: string[];
    try {
      if (existsSync(absPath)) {
        lines = readFileSync(absPath, "utf-8").split("\n");
      } else {
        lines = [];
      }
    } catch {
      lines = [];
    }
    fileCache.set(filePath, lines);
    return lines;
  }

  db.transaction(() => {
    for (const sym of result.symbols) {
      insertAnalyzedSymbol(
        db,
        insertSymbol,
        symbolIdMap,
        sym,
        getFileLines,
        { hasFullColumns: hasExported && hasBodyHash && hasTokenCount, hasTokensTable },
        projectId,
      );
    }
  })();

  const newEdgeCount = insertResolvedEdges(db, result.edges, symbolIdMap, projectId);

  return { newSymbolCount: result.symbols.length, newEdgeCount };
}

/** Schema capability flags for the symbols table. */
interface SymbolColumnFlags {
  hasFullColumns: boolean;
  hasTokensTable: boolean;
}

/** Insert one analyzed symbol (plus its TF-IDF tokens) and register its ID. */
function insertAnalyzedSymbol(
  db: Database.Database,
  insertSymbol: Database.Statement,
  symbolIdMap: Map<string, number>,
  sym: { file_path: string; symbol_name: string; symbol_type: string; start_line: number | null; end_line: number | null; is_exported?: boolean },
  getFileLines: (filePath: string) => string[],
  flags: SymbolColumnFlags,
  projectId: number,
): void {
  const insertToken = flags.hasTokensTable
    ? db.prepare(
        "INSERT OR IGNORE INTO symbol_tokens (symbol_id, token, tf) VALUES (?, ?, ?)",
      )
    : null;
  // Extract source code for body_hash / tokenization
  const lines = getFileLines(sym.file_path);
  const startLine = sym.start_line ?? 1;
  const endLine = sym.end_line ?? lines.length;
  const bodyText = lines.slice(startLine - 1, endLine).join("\n");

  const isExported = sym.is_exported ? 1 : 0;
  const bodyHash = bodyText.length > 0 ? computeBodyHash(bodyText) : null;
  const tokens = bodyText.length > 0 ? tokenizeSymbolBody(bodyText) : [];
  const tokenCount = tokens.length;

  let symbolId: number;
  if (flags.hasFullColumns) {
    const r = insertSymbol.run(
      projectId,
      sym.file_path,
      sym.symbol_name,
      sym.symbol_type,
      sym.start_line,
      sym.end_line,
      isExported,
      bodyHash,
      tokenCount,
    );
    symbolId = r.lastInsertRowid as number;
  } else {
    const r = insertSymbol.run(
      projectId,
      sym.file_path,
      sym.symbol_name,
      sym.symbol_type,
      sym.start_line,
      sym.end_line,
    );
    symbolId = r.lastInsertRowid as number;
  }

  symbolIdMap.set(
    `${sym.file_path}:${sym.symbol_name}:${sym.start_line}`,
    symbolId,
  );

  // Populate symbol_tokens for TF-IDF
  if (insertToken && tokenCount > 0) {
    // Compute term frequency
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    // Normalize TF
    for (const [token, count] of termFreq) {
      const tf = count / tokenCount;
      insertToken.run(symbolId, token, tf);
    }
  }
}

/** Resolve and insert structural edges; returns the count inserted. */
function insertResolvedEdges(
  db: Database.Database,
  edges: Array<{ from_file: string; from_name: string; from_start_line: number | null; to_file: string; to_name: string; to_start_line: number | null; edge_type: string }>,
  symbolIdMap: Map<string, number>,
  projectId: number,
): number {
  let newEdgeCount = 0;
  const insertEdge = db.prepare(`
    INSERT INTO edges (project_id, from_symbol_id, to_symbol_id, edge_type)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const edge of edges) {
      const fromId = resolveSymbolId(
        symbolIdMap,
        edge.from_file,
        edge.from_name,
        edge.from_start_line,
      );
      const toId = resolveSymbolId(
        symbolIdMap,
        edge.to_file,
        edge.to_name,
        edge.to_start_line,
      );
      if (fromId && toId) {
        try {
          insertEdge.run(projectId, fromId, toId, edge.edge_type);
          newEdgeCount++;
        } catch {
          // Skip duplicate edges
        }
      }
    }
  })();
  return newEdgeCount;
}

/**
 * Cross-file edge resolution post-pass.
 *
 * After structural edges are inserted, resolve import edges to the actual
 * exported symbol in the target file, creating "resolves" edges.
 * This closes the gap where import edges only point to file-level symbols
 * rather than the specific imported definition.
 */
function resolveCrossFileEdges(
  targetDir: string,
  db: Database.Database,
  projectId: number,
): number {
  // Build a global map: (file_path, symbol_name) → symbol_id for exported symbols
  const exportedSymbols = db
    .prepare(
      `SELECT id, file_path, symbol_name FROM symbols WHERE is_exported = 1 AND symbol_type != 'file' AND ${projectPredicate()}`,
    )
    .all(projectId) as { id: number; file_path: string; symbol_name: string }[];
  const exportMap = new Map<string, number>();
  for (const sym of exportedSymbols) {
    exportMap.set(`${sym.file_path}:${sym.symbol_name}`, sym.id);
  }

  // Also build a non-exported fallback map (for names that match unexported symbols)
  const allSymbols = db
    .prepare(
      `SELECT id, file_path, symbol_name FROM symbols WHERE symbol_type != 'file' AND ${projectPredicate()}`,
    )
    .all(projectId) as { id: number; file_path: string; symbol_name: string }[];
  const nameMap = new Map<string, { id: number; file_path: string }[]>();
  for (const sym of allSymbols) {
    const list = nameMap.get(sym.symbol_name) ?? [];
    list.push({ id: sym.id, file_path: sym.file_path });
    nameMap.set(sym.symbol_name, list);
  }

  // Get all import edges (scoped to this project's symbols)
  const importEdges = db
    .prepare(
      `SELECT e.id AS edge_id, e.from_symbol_id, e.to_symbol_id,
              fs.file_path AS from_file, ts.file_path AS to_file,
              ts.symbol_name AS to_name
       FROM edges e
       JOIN symbols fs ON e.from_symbol_id = fs.id
       JOIN symbols ts ON e.to_symbol_id = ts.id
       WHERE e.edge_type = 'imports' AND ${projectPredicate("e")}`,
    )
    .all(projectId) as {
    edge_id: number;
    from_symbol_id: number;
    to_symbol_id: number;
    from_file: string;
    to_file: string;
    to_name: string;
  }[];

  // For each import edge, try to find the concrete exported symbol in
  // the target file and create a "resolves" edge.
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (project_id, from_symbol_id, to_symbol_id, edge_type)
    VALUES (?, ?, ?, ?)
  `);

  let resolved = 0;
  db.transaction(() => {
    for (const edge of importEdges) {
      // Skip self-imports and wildcard imports
      if (edge.to_name === "*") continue;
      // The "to_file" is actually stored as a symbol_name for the file-level symbol;
      // look up the real file path from the symbol ID.
      const toFileSym = db
        .prepare("SELECT file_path FROM symbols WHERE id = ?")
        .get(edge.to_symbol_id) as { file_path: string } | undefined;
      if (!toFileSym) continue;
      const targetFile = toFileSym.file_path;

      // Try export first, then any symbol in the target file
      const matchKey = `${targetFile}:${edge.to_name}`;
      const exportedId = exportMap.get(matchKey);
      if (exportedId) {
        insertEdge.run(projectId, edge.from_symbol_id, exportedId, "resolves");
        resolved++;
        continue;
      }

      // Fallback: match by name in the target file (may be an unexported symbol)
      const candidates = nameMap.get(edge.to_name);
      if (candidates) {
        const exact = candidates.find((c) => c.file_path === targetFile);
        if (exact) {
          insertEdge.run(projectId, edge.from_symbol_id, exact.id, "resolves");
          resolved++;
        }
      }
    }
  })();

  return resolved;
}

function updateFileIndex(
  db: Database.Database,
  filesToAnalyze: string[],
  currentFiles: Map<string, number>,
  projectId: number,
): void {
  const upsertFileIndex = db.prepare(`
    INSERT INTO file_index (project_id, file_path, mtime_ms, indexed_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      project_id = excluded.project_id,
      mtime_ms = excluded.mtime_ms,
      indexed_at = datetime('now')
  `);
  db.transaction(() => {
    for (const path of filesToAnalyze) {
      upsertFileIndex.run(projectId, path, currentFiles.get(path)!);
    }
  })();
}

function buildIndexStatusResponse(
  totalFiles: number,
  db: Database.Database,
  isFull: boolean,
  targetDir: string,
  projectId: number,
) {
  const symCount = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM symbols WHERE ${projectPredicate()}`,
      )
      .get(projectId) as { cnt: number }
  ).cnt;
  const edgeCount = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM edges WHERE ${projectPredicate()}`)
      .get(projectId) as { cnt: number }
  ).cnt;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          message: isFull
            ? `Full index of ${targetDir}`
            : "Index up to date \u2014 no changes detected",
          mode: isFull ? "full" : "incremental",
          files: totalFiles,
          changed: 0,
          deleted: 0,
          symbols: symCount,
          edges: edgeCount,
        }),
      },
    ],
  };
}

interface IndexResultOpts {
  isFull: boolean;
  targetDir: string;
  totalFiles: number;
  analyzed: number;
  deleted: number;
  newSymbolCount: number;
  newEdgeCount: number;
  resolvedEdgeCount: number;
}

function buildIndexResultResponse(
  opts: IndexResultOpts,
  db: Database.Database,
  projectId: number,
) {
  const totalSymbols = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt FROM symbols WHERE ${projectPredicate()}`,
      )
      .get(projectId) as { cnt: number }
  ).cnt;
  const totalEdges = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM edges WHERE ${projectPredicate()}`)
      .get(projectId) as { cnt: number }
  ).cnt;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          message: opts.isFull
            ? `Full index of ${opts.targetDir}`
            : `Incremental index of ${opts.targetDir}`,
          mode: opts.isFull ? "full" : "incremental",
          files: opts.totalFiles,
          analyzed: opts.analyzed,
          deleted: opts.deleted,
          newSymbols: opts.newSymbolCount,
          newEdges: opts.newEdgeCount,
          resolvedEdges: opts.resolvedEdgeCount,
          totalSymbols,
          totalEdges,
        }),
      },
    ],
  };
}

// ─── ZOD SCHEMAS ──────────────────────────────────────────

export const IndexCodebaseSchema = z.object({
  root_dir: z
    .string()
    .optional()
    .describe("Root directory to index (default: workspace root from config)"),
  extensions: z
    .array(z.string())
    .optional()
    .describe(
      "File extensions to index (default: all extensions registered in the analyzer registry — currently ts, tsx, js, jsx, mjs, cjs, py, go).",
    ),
  full: z
    .boolean()
    .optional()
    .describe("Force full re-index instead of incremental (default: false)"),
});

export const QueryCodeGraphSchema = z
  .object({
    symbol_name: z
      .string()
      .optional()
      .describe("Symbol name to look up (exact match)"),
    symbol_id: z.number().int().optional().describe("Symbol ID to look up"),
    file_path: z
      .string()
      .optional()
      .describe("File path to list all symbols in"),
  })
  .refine(
    (data) =>
      data.symbol_name !== undefined ||
      data.symbol_id !== undefined ||
      data.file_path !== undefined,
    {
      message:
        "At least one of symbol_name, symbol_id, or file_path must be provided",
    },
  );

// ─── TOOL REGISTRATION ────────────────────────────────────

export function registerCodeGraphTools(
  server: McpServer,
  db: Database.Database,
  workspaceRoot: string,
  projectId: number,
): void {
  // ── index_codebase ──
  server.registerTool(
    "index_codebase",
    {
      description:
        "Walk the workspace and extract symbols + edges. Dispatches files to the correct language analyzer automatically via the analyzer registry. Incremental by default (only re-analyzes changed files); use full=true to force complete re-index.",
      inputSchema: IndexCodebaseSchema,
    },
    async ({ root_dir, extensions, full }) => {
      const targetDir = resolve(root_dir ?? workspaceRoot);
      const exts = extensions ?? getDefaultExtensions();

      try {
        const filesWithMtime = walkFilesWithMtime(targetDir, {
          extensions: exts,
        });
        const currentFiles = new Map(
          filesWithMtime.map((f) => [f.path, f.mtime]),
        );

        if (currentFiles.size === 0) {
          return jsonOk({
            message: "No matching files found",
            files: 0,
            symbols: 0,
            edges: 0,
          });
        }

        const storedIndex = db
          .prepare(
            `SELECT file_path, mtime_ms FROM file_index WHERE ${projectPredicate()}`,
          )
          .all(projectId) as { file_path: string; mtime_ms: number }[];
        const storedFiles = new Map(
          storedIndex.map((f) => [f.file_path, f.mtime_ms]),
        );

        const isFull = full || storedFiles.size === 0;
        const { filesToAnalyze, deletedFiles } = classifyFiles(
          currentFiles,
          storedFiles,
          isFull,
          db,
          projectId,
        );

        if (filesToAnalyze.length === 0 && deletedFiles.length === 0) {
          return buildIndexStatusResponse(
            currentFiles.size,
            db,
            isFull,
            targetDir,
            projectId,
          );
        }

        const symbolIdMap = buildSymbolIdMap(isFull, db, projectId);
        const { newSymbolCount, newEdgeCount } = analyzeAndInsert(
          filesToAnalyze,
          targetDir,
          db,
          symbolIdMap,
          projectId,
        );
        // Cross-file resolution: link imports to their target exported symbols
        const resolvedEdgeCount = resolveCrossFileEdges(
          targetDir,
          db,
          projectId,
        );
        updateFileIndex(db, filesToAnalyze, currentFiles, projectId);

        return buildIndexResultResponse(
          {
            isFull,
            targetDir,
            totalFiles: currentFiles.size,
            analyzed: filesToAnalyze.length,
            deleted: deletedFiles.length,
            newSymbolCount,
            newEdgeCount,
            resolvedEdgeCount: resolvedEdgeCount,
          },
          db,
          projectId,
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `Indexing failed: ${errorMessage}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── query_code_graph ──
  server.registerTool(
    "query_code_graph",
    {
      description:
        "Look up a symbol by name, ID, or file path — returns its callers, callees, and imports (1-hop)",
      inputSchema: QueryCodeGraphSchema,
    },
    wrapHandler(
      "query_code_graph",
      async ({ symbol_name, symbol_id, file_path }) => {
        let symbol: Record<string, unknown> | undefined;

        if (symbol_id !== undefined) {
          symbol = db
            .prepare(
              `SELECT * FROM symbols WHERE id = ? AND ${projectPredicate()}`,
            )
            .get(symbol_id, projectId) as Record<string, unknown> | undefined;
        } else if (symbol_name) {
          // Prefer non-file symbols, then most recent
          symbol = db
            .prepare(
              `SELECT * FROM symbols WHERE symbol_name = ? AND symbol_type != 'file' AND ${projectPredicate()} ORDER BY updated_at DESC LIMIT 1`,
            )
            .get(symbol_name, projectId) as Record<string, unknown> | undefined;

          symbol ??= db
            .prepare(
              `SELECT * FROM symbols WHERE symbol_name = ? AND ${projectPredicate()} LIMIT 1`,
            )
            .get(symbol_name, projectId) as Record<string, unknown> | undefined;
        } else if (file_path) {
          const symbols = db
            .prepare(
              `SELECT * FROM symbols WHERE file_path = ? AND ${projectPredicate()} ORDER BY start_line`,
            )
            .all(file_path, projectId);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  file_path,
                  symbols,
                }),
              },
            ],
          };
        }

        if (!symbol) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  message: "Symbol not found",
                }),
              },
            ],
          };
        }

        const symId = symbol.id as number;

        // Callers: edges where this symbol is the target
        const callers = db
          .prepare(
            `SELECT s.* FROM edges e
           JOIN symbols s ON e.from_symbol_id = s.id
           WHERE e.to_symbol_id = ?
           ORDER BY s.file_path, s.start_line`,
          )
          .all(symId);

        // Callees: edges where this symbol is the source
        const callees = db
          .prepare(
            `SELECT s.* FROM edges e
           JOIN symbols s ON e.to_symbol_id = s.id
           WHERE e.from_symbol_id = ?
           ORDER BY s.file_path, s.start_line`,
          )
          .all(symId);

        // Imports: edges of type 'imports' where this symbol is the source
        const imports = db
          .prepare(
            `SELECT s.*, e.edge_type FROM edges e
           JOIN symbols s ON e.to_symbol_id = s.id
           WHERE e.from_symbol_id = ? AND e.edge_type = 'imports'
           ORDER BY s.file_path`,
          )
          .all(symId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                symbol,
                callers,
                callees,
                imports,
              }),
            },
          ],
        };
      },
    ),
  );
}
