// CogMemory MCP — Code analysis tools
// find_dead_code, find_duplicates, find_related, query_graph,
// analyze_impact, get_code_snippet, check_index_coverage, semantic_code_search

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler, jsonOk, jsonErr } from "./utils.js";
import { walkFilesWithMtime } from "../indexing/walker.js";
import { EDGE_TYPES, STRUCTURAL_EDGE_TYPES } from "../indexing/edge-types.js";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { execSync } from "node:child_process";

// ─── Stopwords / language keywords for tokenization ─────

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could",
  "should","may","might","must","shall","can","need","to","of",
  "in","for","on","with","at","by","from","as","into","through",
  "during","before","after","above","below","between","out","off",
  "under","again","further","then","once","here","there","when",
  "where","why","how","all","both","each","few","more","most",
  "other","some","such","no","nor","not","only","own","same",
  "so","than","too","very","just","because","but","and","or",
  "if","while","this","that","these","those","i","me","my",
  "we","our","you","your","he","him","his","she","her","it",
  "its","they","them","their","what","which","who","whom",
  // Language keywords (stop noise)
  "function","const","let","var","return","import","from","export",
  "default","class","interface","type","enum","async","await",
  "def","self","lambda","yield","pass","raise","try","except",
  "finally","with","as","global","nonlocal","assert","del",
]);

// ─── TF-IDF Tokenizer ──────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ─── MinHash helpers ────────────────────────────────────

const MINHASH_NUM_HASHES = 64;
const MINHASH_SHINGLE_K = 3;

function shingle(tokens: string[], k: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= tokens.length - k; i++) {
    set.add(tokens.slice(i, i + k).join(" "));
  }
  return set;
}

/** Simple MinHash: compute num_hashes hash values for a shingle set. */
function computeMinHash(shingles: Set<string>, numHashes: number): number[] {
  const signature: number[] = new Array(numHashes).fill(Infinity);
  for (const sh of shingles) {
    // FNV-like hash seeds
    for (let i = 0; i < numHashes; i++) {
      let hash = 2166136261 ^ (i * 16777619);
      for (let j = 0; j < sh.length; j++) {
        hash ^= sh.charCodeAt(j);
        hash = (hash * 16777619) >>> 0;
      }
      if (hash < signature[i]) {
        signature[i] = hash;
      }
    }
  }
  return signature;
}

function jaccardFromSignatures(a: number[], b: number[]): number {
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}

// ─── Schema-aware column check ──────────────────────────

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

// ─── TOOL REGISTRATION ──────────────────────────────────

export function registerCodeAnalysisTools(
  server: McpServer,
  db: Database.Database,
  workspaceRoot: string,
): void {
  const hasBodyHash = hasColumn(db, "symbols", "body_hash");
  const hasIsExported = hasColumn(db, "symbols", "is_exported");
  const hasMetadata = hasColumn(db, "edges", "metadata");
  const hasMinhash = (() => {
    try {
      db.prepare("SELECT 1 FROM symbol_minhash LIMIT 0").get();
      return true;
    } catch {
      return false;
    }
  })();
  const hasTokens = (() => {
    try {
      db.prepare("SELECT 1 FROM symbol_tokens LIMIT 0").get();
      return true;
    } catch {
      return false;
    }
  })();

  // ── get_code_snippet ──
  server.registerTool(
    "get_code_snippet",
    {
      description:
        "Get the source code lines for a symbol by ID or name. Returns the file content between start_line and end_line, with optional context padding.",
      inputSchema: z.object({
        symbol_id: z.number().int().optional().describe("Symbol ID to fetch"),
        symbol_name: z.string().optional().describe("Symbol name to look up (exact match; first match if ambiguous)"),
        file_path: z.string().optional().describe("Narrow search to this file path"),
        context_lines: z.number().int().min(0).max(50).optional().describe("Extra lines before/after (default: 0)"),
      }),
    },
    wrapHandler("get_code_snippet", async ({ symbol_id, symbol_name, file_path, context_lines: ctxLines }) => {
      const padding = ctxLines ?? 0;

      let symbol: Record<string, unknown> | undefined;
      if (symbol_id !== undefined) {
        symbol = db.prepare("SELECT * FROM symbols WHERE id = ?").get(symbol_id) as Record<string, unknown> | undefined;
      } else if (symbol_name) {
        symbol = file_path
          ? db.prepare("SELECT * FROM symbols WHERE symbol_name = ? AND file_path = ? LIMIT 1").get(symbol_name, file_path) as Record<string, unknown> | undefined
          : db.prepare("SELECT * FROM symbols WHERE symbol_name = ? AND symbol_type != 'file' ORDER BY updated_at DESC LIMIT 1").get(symbol_name) as Record<string, unknown> | undefined;
      }

      if (!symbol) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: "Symbol not found" }) }] };
      }

      const symFile = symbol.file_path as string;
      const absPath = resolve(workspaceRoot, symFile);
      if (!existsSync(absPath)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: `File not found on disk: ${absPath}` }) }] };
      }

      const lines = readFileSync(absPath, "utf-8").split("\n");
      const start = Math.max(1, (symbol.start_line as number) - padding);
      const end = Math.min(lines.length, (symbol.end_line as number) + padding);
      const snippet = lines.slice(start - 1, end).join("\n");

      const ext = extname(symFile).slice(1).toLowerCase();
      return jsonOk({
        file_path: symFile,
        start_line: start,
        end_line: end,
        content: snippet,
        language: ext === "py" ? "python" : ext === "ts" || ext === "tsx" ? "typescript" : ext === "js" || ext === "jsx" ? "javascript" : ext,
        symbol_name: symbol.symbol_name,
        symbol_id: symbol.id,
      });
    }),
  );

  // ── check_index_coverage ──
  server.registerTool(
    "check_index_coverage",
    {
      description:
        "Report indexed vs. unindexed vs. stale files and per-language breakdowns. Use to understand how much of the workspace the code graph covers.",
      inputSchema: z.object({
        root_dir: z.string().optional().describe("Root directory to check (default: workspace root)"),
        extensions: z.array(z.string()).optional().describe("File extensions to check (default: ts,tsx,js,jsx,mjs,cjs,py)"),
      }),
    },
    wrapHandler("check_index_coverage", async ({ root_dir, extensions }) => {
      const targetDir = resolve(root_dir ?? workspaceRoot);
      const exts = extensions ?? ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"];

      const currentFiles = walkFilesWithMtime(targetDir, { extensions: exts });
      const storedIdx = db.prepare("SELECT file_path, mtime_ms FROM file_index").all() as { file_path: string; mtime_ms: number }[];
      const storedMap = new Map(storedIdx.map((f) => [f.file_path, f.mtime_ms]));

      const unindexed: { path: string; reason: string }[] = [];
      const stale: { path: string; indexed_mtime: number; current_mtime: number }[] = [];
      const byLang: Record<string, { total: number; indexed: number }> = {};

      for (const { path, mtime } of currentFiles) {
        const ext = extname(path).slice(1).toLowerCase();
        if (!byLang[ext]) byLang[ext] = { total: 0, indexed: 0 };
        byLang[ext].total++;

        const storedMtime = storedMap.get(path);
        if (storedMtime === undefined) {
          unindexed.push({ path, reason: "never indexed" });
        } else if (storedMtime !== mtime) {
          stale.push({ path, indexed_mtime: storedMtime, current_mtime: mtime });
        } else {
          byLang[ext].indexed++;
        }
      }

      // Parse errors
      let parseErrors: { path: string; error: string }[] = [];
      try {
        parseErrors = db.prepare("SELECT file_path as path, error_message as error FROM index_errors").all() as { path: string; error: string }[];
      } catch { /* table may not exist */ }

      const total = currentFiles.length;
      const indexedCount = total - unindexed.length;

      return jsonOk({
        total_files: total,
        indexed_files: indexedCount,
        unindexed_files: unindexed.slice(0, 1000),
        stale_files: stale.slice(0, 1000),
        coverage_pct: total > 0 ? Math.round((indexedCount / total) * 10000) / 100 : 100,
        by_language: byLang,
        parse_errors: parseErrors,
        total_unindexed: unindexed.length,
        total_stale: stale.length,
      });
    }),
  );

  // ── find_dead_code ──
  server.registerTool(
    "find_dead_code",
    {
      description:
        "Find symbols with zero inbound structural edges (calls, imports, extends, implements). Excludes exported symbols, configurable entry-point patterns, and test files.",
      inputSchema: z.object({
        entry_point_patterns: z.array(z.string()).optional().describe("Symbol name patterns to exclude as entry points (default: main,index,cli,server,handler,setup,run)"),
        exclude_tests: z.boolean().optional().describe("Exclude test files *.test.* / *.spec.* / test_* (default: true)"),
        exclude_exported: z.boolean().optional().describe("Exclude exported symbols (default: true; requires migration 002)"),
        file_pattern: z.string().optional().describe("Only consider symbols whose file_path matches this substring"),
        limit: z.number().int().optional().describe("Max results (default: 200)"),
      }),
    },
    wrapHandler("find_dead_code", async (params) => {
      const patterns = params.entry_point_patterns ?? ["main", "index", "cli", "server", "handler", "setup", "run"];
      const excludeTests = params.exclude_tests !== false;
      const excludeExported = params.exclude_exported !== false;
      const limit = params.limit ?? 200;

      // Build entry-point LIKE conditions
      const entryConds = patterns.map(() => "s.symbol_name LIKE ?").join(" OR ");
      const entryParams = patterns.map((p) => `%${p}%`);

      // Build test file conditions
      const testConds = excludeTests
        ? "AND s.file_path NOT LIKE '%.test.%' AND s.file_path NOT LIKE '%.spec.%' AND s.file_path NOT LIKE '%/test_%' AND s.file_path NOT LIKE '%/test/%' AND s.file_path NOT LIKE '%/__tests__/%'"
        : "";

      // Build exported condition
      const exportedCond = excludeExported && hasIsExported
        ? "AND (s.is_exported = 0 OR s.is_exported IS NULL)"
        : "";

      // File pattern condition
      const fileCond = params.file_pattern ? "AND s.file_path LIKE ?" : "";
      const fileArgs = params.file_pattern ? [`%${params.file_pattern}%`] : [];

      const sql = `
        SELECT s.*
        FROM symbols s
        WHERE s.symbol_type != 'file'
          AND NOT (${entryConds})
          ${testConds}
          ${exportedCond}
          ${fileCond}
          AND NOT EXISTS (
            SELECT 1 FROM edges e
            WHERE e.to_symbol_id = s.id
              AND e.edge_type IN ('calls','imports','extends','implements')
          )
        ORDER BY s.file_path, s.start_line
        LIMIT ?
      `;

      const rows = db.prepare(sql).all(...entryParams, ...fileArgs, limit) as Record<string, unknown>[];

      return jsonOk({
        dead_symbols: rows,
        total: rows.length,
        entry_point_patterns: patterns,
        exclude_tests: excludeTests,
        exclude_exported: excludeExported && hasIsExported,
      });
    }),
  );

  // ── query_graph ──
  server.registerTool(
    "query_graph",
    {
      description:
        "Multi-hop structural graph query using recursive CTE. Start from a symbol and traverse outbound/inbound/both through edges of specified types up to max_depth. Returns nodes and paths.",
      inputSchema: z.object({
        start_symbol: z.string().min(1).describe("Starting symbol name or ID (string)"),
        edge_types: z.array(z.string()).optional().describe("Edge types to traverse (default: all structural types)"),
        direction: z.enum(["inbound", "outbound", "both"]).optional().describe("Direction of traversal (default: both)"),
        max_depth: z.number().int().min(1).max(20).optional().describe("Maximum depth (default: 5)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum nodes returned (default: 100)"),
        filter: z.object({
          symbol_type: z.string().optional().describe("Only include symbols of this type"),
          file_pattern: z.string().optional().describe("Only include symbols whose file_path matches"),
        }).optional(),
      }),
    },
    wrapHandler("query_graph", async (params) => {
      const maxDepth = params.max_depth ?? 5;
      const direction = params.direction ?? "both";
      const types = params.edge_types ?? STRUCTURAL_EDGE_TYPES.slice();
      const limit = params.limit ?? 100;

      // Resolve start symbol
      const startId = parseInt(params.start_symbol, 10);
      let startSymbol: Record<string, unknown> | undefined;
      if (!isNaN(startId)) {
        startSymbol = db.prepare("SELECT * FROM symbols WHERE id = ?").get(startId) as Record<string, unknown> | undefined;
      } else {
        startSymbol = db.prepare("SELECT * FROM symbols WHERE symbol_name = ? ORDER BY updated_at DESC LIMIT 1").get(params.start_symbol) as Record<string, unknown> | undefined;
      }
      if (!startSymbol) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: `Symbol not found: ${params.start_symbol}` }) }] };
      }

      const typePlaceholders = types.map(() => "?").join(",");
      const typeArgs = [...types];

      // Build the recursive CTE based on direction
      let edgeJoin: string;
      if (direction === "outbound") {
        edgeJoin = `JOIN edges e ON e.from_symbol_id = r.id WHERE e.edge_type IN (${typePlaceholders})`;
      } else if (direction === "inbound") {
        edgeJoin = `JOIN edges e ON e.to_symbol_id = r.id WHERE e.edge_type IN (${typePlaceholders})`;
      } else {
        edgeJoin = `JOIN edges e ON (e.from_symbol_id = r.id OR e.to_symbol_id = r.id)
                    WHERE e.edge_type IN (${typePlaceholders})`;
      }
      const nextIdExpr = direction === "inbound" ? "e.from_symbol_id" : direction === "outbound" ? "e.to_symbol_id" : "CASE WHEN e.from_symbol_id = r.id THEN e.to_symbol_id ELSE e.from_symbol_id END";

      let filterClauses = "";
      const extraArgs: unknown[] = [];
      if (params.filter?.symbol_type) {
        filterClauses += " AND n.symbol_type = ?";
        extraArgs.push(params.filter.symbol_type);
      }
      if (params.filter?.file_pattern) {
        filterClauses += " AND n.file_path LIKE ?";
        extraArgs.push(`%${params.filter.file_pattern}%`);
      }

      const cte = `
        WITH RECURSIVE reach(id, depth, path) AS (
          SELECT id, 0, CAST(id AS TEXT)
          FROM symbols
          WHERE id = ?
          UNION ALL
          SELECT ${nextIdExpr}, r.depth + 1, r.path || '/' || ${nextIdExpr}
          FROM reach r
          ${edgeJoin}
          AND r.depth < ?
          AND r.path NOT LIKE '%' || ${nextIdExpr} || '%'
        )
        SELECT DISTINCT n.id, n.file_path, n.symbol_name, n.symbol_type, n.start_line, n.end_line,
               MIN(r.depth) as depth
        FROM reach r
        JOIN symbols n ON n.id = r.id
        WHERE 1=1 ${filterClauses}
        GROUP BY n.id
        ORDER BY depth, n.file_path, n.start_line
        LIMIT ?
      `;

      const nodes = db.prepare(cte).all(
        startSymbol.id,
        ...typeArgs,
        maxDepth,
        ...extraArgs,
        limit,
      ) as Record<string, unknown>[];

      return jsonOk({
        start: startSymbol,
        nodes,
        total_reachable: nodes.length,
        max_depth: maxDepth,
        direction,
        edge_types: types,
      });
    }),
  );

  // ── analyze_impact ──
  server.registerTool(
    "analyze_impact",
    {
      description:
        "Analyze the impact of uncommitted changes. Auto-detects changed files via `git diff`, maps them to indexed symbols, and computes the reverse transitive caller closure. Returns impacted symbols with depth and path.",
      inputSchema: z.object({
        changed_files: z.array(z.string()).optional().describe("Override: explicit list of changed files (skip git diff)"),
        max_depth: z.number().int().min(1).max(20).optional().describe("Max transitive depth (default: 5)"),
        edge_types: z.array(z.string()).optional().describe("Edge types to follow (default: calls, imports)"),
        include_tests: z.boolean().optional().describe("Include test files in results (default: false)"),
      }),
    },
    wrapHandler("analyze_impact", async (params) => {
      const maxDepth = params.max_depth ?? 5;
      const types = params.edge_types ?? [EDGE_TYPES.CALLS, EDGE_TYPES.IMPORTS];
      const includeTests = params.include_tests === true;

      // Detect changed files
      let changedFiles: string[];
      if (params.changed_files) {
        changedFiles = params.changed_files;
      } else {
        try {
          const diffOutput = execSync("git diff --name-only HEAD", {
            cwd: workspaceRoot,
            encoding: "utf-8",
            timeout: 10000,
          }).trim();
          // Also get untracked files
          let untracked = "";
          try {
            untracked = execSync("git ls-files --others --exclude-standard", {
              cwd: workspaceRoot,
              encoding: "utf-8",
              timeout: 10000,
            }).trim();
          } catch { /* ok */ }

          const allChanges = [diffOutput, untracked]
            .filter(Boolean)
            .join("\n")
            .split("\n")
            .filter(Boolean);

          if (allChanges.length === 0) {
            return jsonOk({
              message: "No uncommitted changes detected (git diff returned empty). Pass changed_files manually.",
              changed_files: [],
              changed_symbols: [],
              impacted_symbols: [],
              summary: { total_impacted: 0 },
            });
          }
          changedFiles = allChanges;
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                message: `git diff failed — workspace may not be a git repository. Pass changed_files manually. Error: ${err instanceof Error ? err.message : String(err)}`,
              }),
            }],
          };
        }
      }

      // Map changed files to symbols
      if (changedFiles.length === 0) {
        return jsonOk({ message: "No changed files", changed_files: [], changed_symbols: [], impacted_symbols: [], summary: { total_impacted: 0 } });
      }

      const placeholders = changedFiles.map(() => "?").join(",");
      const testFilter = includeTests ? "" : "AND file_path NOT LIKE '%.test.%' AND file_path NOT LIKE '%.spec.%'";
      const changedSymbolSql = `SELECT id, symbol_name, file_path, symbol_type FROM symbols WHERE file_path IN (${placeholders}) ${testFilter}`;
      const changedSymbols = db.prepare(changedSymbolSql).all(...changedFiles) as { id: number; symbol_name: string; file_path: string; symbol_type: string }[];

      if (changedSymbols.length === 0) {
        return jsonOk({
          message: "Changed files found, but no indexed symbols match. Run index_codebase first.",
          changed_files: changedFiles,
          changed_symbols: [],
          impacted_symbols: [],
          summary: { total_impacted: 0 },
        });
      }

      // Reverse transitive closure via recursive CTE
      const typePlaceholders = types.map(() => "?").join(",");
      const changedIds = changedSymbols.map((s) => s.id);
      const idPlaceholders = changedIds.map(() => "?").join(",");

      const cte = `
        WITH RECURSIVE callers(source_id, depth) AS (
          SELECT id, 0 FROM symbols WHERE id IN (${idPlaceholders})
          UNION
          SELECT DISTINCT e.from_symbol_id, c.depth + 1
          FROM callers c
          JOIN edges e ON e.to_symbol_id = c.source_id
          WHERE e.edge_type IN (${typePlaceholders})
            AND c.depth < ?
            AND e.from_symbol_id != c.source_id
        )
        SELECT DISTINCT s.id, s.symbol_name, s.file_path, s.symbol_type,
               MIN(c.depth) as depth
        FROM callers c
        JOIN symbols s ON s.id = c.source_id
        WHERE c.depth > 0 ${includeTests ? "" : "AND s.file_path NOT LIKE '%.test.%'"}
        GROUP BY s.id
        ORDER BY depth, s.file_path
        LIMIT 500
      `;

      const impacted = db.prepare(cte).all(...changedIds, ...types, maxDepth) as Record<string, unknown>[];

      // Enrich with path info
      const impactWithPaths: Record<string, unknown>[] = [];
      for (const imp of impacted) {
        // Fetch the shortest caller chain (1-hop detail)
        const chain = db.prepare(`
          SELECT e.from_symbol_id, s2.symbol_name as caller_name
          FROM edges e
          JOIN symbols s2 ON s2.id = e.from_symbol_id
          WHERE e.to_symbol_id = ?
            AND e.edge_type IN (${typePlaceholders})
          LIMIT 3
        `).all(imp.id, ...types) as Record<string, unknown>[];

        impactWithPaths.push({
          ...imp,
          callers: chain.map((c) => c.caller_name),
        });
      }

      return jsonOk({
        changed_files: changedFiles,
        changed_symbols: changedSymbols,
        impacted_symbols: impactWithPaths,
        summary: {
          total_impacted: impactWithPaths.length,
          max_depth_reached: (impactWithPaths[impactWithPaths.length - 1]?.depth as number) ?? 0,
        },
      });
    }),
  );

  // ── find_duplicates ──
  server.registerTool(
    "find_duplicates",
    {
      description:
        "Find duplicate/clone symbol pairs via exact body_hash match and MinHash similarity. Inserts SIMILAR_TO edges for pairs above threshold.",
      inputSchema: z.object({
        threshold: z.number().min(0).max(1).optional().describe("Jaccard similarity threshold (default: 0.7)"),
        min_tokens: z.number().int().min(1).optional().describe("Minimum tokens per symbol to compare (default: 10)"),
        recompute: z.boolean().optional().describe("Recompute MinHash signatures from scratch (default: false — uses stored signatures)"),
        file_pattern: z.string().optional().describe("Only consider symbols whose file_path matches"),
      }),
    },
    wrapHandler("find_duplicates", async (params) => {
      const threshold = params.threshold ?? 0.7;
      const minTokens = params.min_tokens ?? 10;
      const recompute = params.recompute === true;

      const fileFilter = params.file_pattern ? "AND s.file_path LIKE ?" : "";
      const fileArgs = params.file_pattern ? [`%${params.file_pattern}%`] : [];

      // Step 1: Exact clones via body_hash
      let exactCloneCount = 0;
      if (hasBodyHash && hasMetadata) {
        const exactSql = `
          SELECT s1.id as id_a, s2.id as id_b, s1.body_hash
          FROM symbols s1
          JOIN symbols s2 ON s1.body_hash = s2.body_hash AND s1.id < s2.id
          WHERE s1.body_hash IS NOT NULL AND s1.body_hash != ''
            ${fileFilter}
          LIMIT 1000
        `;
        const exactPairs = db.prepare(exactSql).all(...fileArgs) as { id_a: number; id_b: number; body_hash: string }[];
        const insertEdge = db.prepare(`
          INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, edge_type, metadata)
          VALUES (?, ?, ?, ?)
        `);
        for (const pair of exactPairs) {
          insertEdge.run(pair.id_a, pair.id_b, EDGE_TYPES.SIMILAR_TO, JSON.stringify({ score: 1.0, algorithm: "exact" }));
          exactCloneCount++;
        }
      }

      // Step 2: Near-duplicates via MinHash
      let nearDupeCount = 0;
      let signaturesSource = "not_available";

      if (recompute && hasMinhash) {
        // Recompute signatures
        const symbols = db.prepare(`SELECT s.* FROM symbols s WHERE s.symbol_type != 'file' AND s.token_count >= ? ${fileFilter} ORDER BY s.file_path`).all(minTokens, ...fileArgs) as Record<string, unknown>[];

        const upsertMinhash = db.prepare(`
          INSERT INTO symbol_minhash (symbol_id, signature, num_hashes, shingle_k, computed_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(symbol_id) DO UPDATE SET signature = excluded.signature, num_hashes = excluded.num_hashes, shingle_k = excluded.shingle_k, computed_at = datetime('now')
        `);

        const allSigs: Map<number, number[]> = new Map();
        db.transaction(() => {
          for (const sym of symbols) {
            const filePath = sym.file_path as string;
            const absPath = resolve(workspaceRoot, filePath);
            if (!existsSync(absPath)) continue;
            try {
              const lines = readFileSync(absPath, "utf-8").split("\n");
              const startLine = (sym.start_line as number) ?? 1;
              const endLine = (sym.end_line as number) ?? lines.length;
              const bodyText = lines.slice(startLine - 1, endLine).join(" ");
              const tokens = tokenize(bodyText);
              if (tokens.length < minTokens) continue;
              const shingles = shingle(tokens, MINHASH_SHINGLE_K);
              const sig = computeMinHash(shingles, MINHASH_NUM_HASHES);
              allSigs.set(sym.id as number, sig);
              upsertMinhash.run(sym.id as number, JSON.stringify(sig), MINHASH_NUM_HASHES, MINHASH_SHINGLE_K);
            } catch { /* file read error — skip */ }
          }
        })();

        nearDupeCount = computeNearDuplicates(db, allSigs, threshold, hasMetadata);
        signaturesSource = "recomputed";
      } else if (hasMinhash) {
        // Use stored signatures
        const stored = db.prepare("SELECT symbol_id, signature FROM symbol_minhash").all() as { symbol_id: number; signature: string }[];
        const allSigs = new Map<number, number[]>();
        for (const row of stored) {
          try {
            allSigs.set(row.symbol_id, JSON.parse(row.signature));
          } catch { /* corrupt signature */ }
        }

        nearDupeCount = computeNearDuplicates(db, allSigs, threshold, hasMetadata);
        signaturesSource = allSigs.size > 0 ? "table" : "none";
      }

      // Collect all SIMILAR_TO edges for the result
      const simEdges = db.prepare(`
        SELECT e.*, s1.symbol_name as name_a, s1.file_path as file_a,
               s2.symbol_name as name_b, s2.file_path as file_b
        FROM edges e
        JOIN symbols s1 ON e.from_symbol_id = s1.id
        JOIN symbols s2 ON e.to_symbol_id = s2.id
        WHERE e.edge_type = ?
        ORDER BY e.created_at DESC
        LIMIT 500
      `).all(EDGE_TYPES.SIMILAR_TO) as Record<string, unknown>[];

      return jsonOk({
        duplicates: simEdges.map((e) => ({
          symbol_a: e.name_a,
          symbol_b: e.name_b,
          file_a: e.file_a,
          file_b: e.file_b,
          similarity: e.metadata ? JSON.parse(e.metadata as string).score : null,
          algorithm: e.metadata ? JSON.parse(e.metadata as string).algorithm : null,
          edge_id: e.id,
        })),
        exact_clones_found: exactCloneCount,
        near_duplicates_found: nearDupeCount,
        edges_created: exactCloneCount + nearDupeCount,
        total_pairs_scanned: Math.max(exactCloneCount, nearDupeCount),
        signatures_source: signaturesSource,
      });
    }),
  );

  // ── find_related ──
  server.registerTool(
    "find_related",
    {
      description:
        "Find semantically-related symbols using structural heuristics: shared callers, shared imports, same file, existing SIMILAR_TO edges. Inserts SEMANTICALLY_RELATED edges.",
      inputSchema: z.object({
        symbol_name: z.string().optional().describe("Symbol name to find relations for"),
        symbol_id: z.number().int().optional().describe("Symbol ID to find relations for"),
        threshold: z.number().min(0).max(1).optional().describe("Minimum score threshold (default: 0.3)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default: 10)"),
        edge_types: z.array(z.string()).optional().describe("Edge types to consider for shared-neighbor scoring"),
      }),
    },
    wrapHandler("find_related", async (params) => {
      const threshold = params.threshold ?? 0.3;
      const limit = params.limit ?? 10;

      // Resolve target symbol
      let target: Record<string, unknown> | undefined;
      if (params.symbol_id !== undefined) {
        target = db.prepare("SELECT * FROM symbols WHERE id = ?").get(params.symbol_id) as Record<string, unknown> | undefined;
      } else if (params.symbol_name) {
        target = db.prepare("SELECT * FROM symbols WHERE symbol_name = ? AND symbol_type != 'file' ORDER BY updated_at DESC LIMIT 1").get(params.symbol_name) as Record<string, unknown> | undefined;
      }
      if (!target) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: "Target symbol not found" }) }] };
      }

      const targetId = target.id as number;

      // Score candidates using structural heuristics
      const scores = new Map<number, { score: number; reasons: string[] }>();

      // 1. Shared callers (weight 0.4)
      const callerSql = `
        SELECT DISTINCT e1.from_symbol_id as shared_id
        FROM edges e1
        JOIN edges e2 ON e1.from_symbol_id = e2.from_symbol_id AND e1.edge_type = e2.edge_type
        WHERE e1.to_symbol_id = ? AND e2.to_symbol_id != ? AND e1.edge_type = 'calls'
        LIMIT 200
      `;
      const sharedCallers = db.prepare(callerSql).all(targetId, targetId) as { shared_id: number }[];
      for (const row of sharedCallers) {
        const e = scores.get(row.shared_id) ?? { score: 0, reasons: [] };
        e.score += 0.4;
        e.reasons.push("shared_callers");
        scores.set(row.shared_id, e);
      }

      // 2. Shared imports (weight 0.3)
      const importSql = `
        SELECT DISTINCT e1.from_symbol_id as shared_id
        FROM edges e1
        JOIN edges e2 ON e1.to_symbol_id = e2.to_symbol_id AND e1.edge_type = e2.edge_type
        WHERE e1.from_symbol_id = ? AND e2.from_symbol_id != ? AND e1.edge_type = 'imports'
        LIMIT 200
      `;
      const sharedImports = db.prepare(importSql).all(targetId, targetId) as { shared_id: number }[];
      for (const row of sharedImports) {
        const e = scores.get(row.shared_id) ?? { score: 0, reasons: [] };
        e.score += 0.3;
        e.reasons.push("shared_imports");
        scores.set(row.shared_id, e);
      }

      // 3. Same file (weight 0.2)
      if (target.file_path) {
        const sameFile = db.prepare("SELECT id FROM symbols WHERE file_path = ? AND id != ? AND symbol_type != 'file' LIMIT 50").all(target.file_path, targetId) as { id: number }[];
        for (const row of sameFile) {
          const e = scores.get(row.id) ?? { score: 0, reasons: [] };
          e.score += 0.2;
          e.reasons.push("same_file");
          scores.set(row.id, e);
        }
      }

      // 4. Existing SIMILAR_TO edge (weight 0.5)
      const similarSql = `
        SELECT CASE WHEN from_symbol_id = ? THEN to_symbol_id ELSE from_symbol_id END as related_id
        FROM edges WHERE edge_type = ? AND (from_symbol_id = ? OR to_symbol_id = ?)
      `;
      const existingSimilar = db.prepare(similarSql).all(targetId, EDGE_TYPES.SIMILAR_TO, targetId, targetId) as { related_id: number }[];
      for (const row of existingSimilar) {
        const e = scores.get(row.related_id) ?? { score: 0, reasons: [] };
        e.score += 0.5;
        e.reasons.push("existing_similar_to");
        scores.set(row.related_id, e);
      }

      // Sort by score, apply threshold and limit
      const candidates = [...scores.entries()]
        .filter(([, v]) => v.score >= threshold)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit);

      // Insert SEMANTICALLY_RELATED edges and build response
      let edgesCreated = 0;
      const insertEdge = hasMetadata
        ? db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, edge_type, metadata) VALUES (?, ?, ?, ?)`)
        : db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)`);

      const related: Record<string, unknown>[] = [];
      db.transaction(() => {
        for (const [symId, { score, reasons }] of candidates) {
          if (hasMetadata) {
            insertEdge.run(targetId, symId, EDGE_TYPES.SEMANTICALLY_RELATED, JSON.stringify({ score, reasons }));
          } else {
            insertEdge.run(targetId, symId, EDGE_TYPES.SEMANTICALLY_RELATED);
          }
          edgesCreated++;

          const sym = db.prepare("SELECT id, symbol_name, file_path, symbol_type FROM symbols WHERE id = ?").get(symId) as Record<string, unknown> | undefined;
          if (sym) {
            related.push({ symbol_id: sym.id, name: sym.symbol_name, file_path: sym.file_path, type: sym.symbol_type, score: Math.round(score * 100) / 100, reasons });
          }
        }
      })();

      return jsonOk({
        target: { id: target.id, name: target.symbol_name, file_path: target.file_path },
        related,
        edges_created: edgesCreated,
      });
    }),
  );

  // ── semantic_code_search (TF-IDF) ──
  server.registerTool(
    "semantic_code_search",
    {
      description:
        "Semantic/meaning-based code search using TF-IDF over symbol names and source code. Returns symbols ranked by relevance to the natural-language query.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Natural language query describing the code you're looking for"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default: 20)"),
        threshold: z.number().min(0).optional().describe("Minimum score threshold (default: 0.0)"),
        file_pattern: z.string().optional().describe("Only search symbols whose file_path matches"),
        symbol_type: z.string().optional().describe("Only search symbols of this type"),
      }),
    },
    wrapHandler("semantic_code_search", async (params) => {
      const limit = params.limit ?? 20;
      const threshold = params.threshold ?? 0;
      const queryTokens = tokenize(params.query);

      if (!hasTokens) {
        return jsonOk({
          message: "symbol_tokens table not available. Run index_codebase first to populate the TF-IDF index.",
          results: [],
          backend: "tfidf-unavailable",
          total_matches: 0,
        });
      }

      if (queryTokens.length === 0) {
        return jsonOk({ results: [], backend: "tfidf", total_matches: 0, message: "Query contained no meaningful tokens after stopword removal" });
      }

      // Compute IDF: log(N / df) for each query token
      const totalSymbols = (db.prepare("SELECT COUNT(DISTINCT symbol_id) as cnt FROM symbol_tokens").get() as { cnt: number }).cnt;
      if (totalSymbols === 0) {
        return jsonOk({ results: [], backend: "tfidf", total_matches: 0, message: "No tokens indexed. Run index_codebase first." });
      }

      const tokenPlaceholders = queryTokens.map(() => "?").join(",");
      const dfRows = db.prepare(`
        SELECT token, COUNT(DISTINCT symbol_id) as df
        FROM symbol_tokens
        WHERE token IN (${tokenPlaceholders})
        GROUP BY token
      `).all(...queryTokens) as { token: string; df: number }[];

      const idf = new Map<string, number>();
      for (const row of dfRows) {
        idf.set(row.token, Math.log(totalSymbols / row.df));
      }

      // Compute TF-IDF scores per symbol
      const scoreSql = `
        SELECT st.symbol_id, SUM(st.tf * 0) as score_placeholder
        FROM symbol_tokens st
        WHERE st.token IN (${tokenPlaceholders})
        GROUP BY st.symbol_id
      `;

      // We'll compute manually since we need token-specific IDF
      const tokenRows = db.prepare(`
        SELECT symbol_id, token, tf
        FROM symbol_tokens
        WHERE token IN (${tokenPlaceholders})
      `).all(...queryTokens) as { symbol_id: number; token: string; tf: number }[];

      const scores = new Map<number, number>();
      for (const row of tokenRows) {
        const currentScore = scores.get(row.symbol_id) ?? 0;
        const tokenIdf = idf.get(row.token) ?? 0;
        scores.set(row.symbol_id, currentScore + row.tf * tokenIdf);
      }

      // Normalize scores to [0, 1] range
      let maxScore = 0;
      for (const score of scores.values()) {
        if (score > maxScore) maxScore = score;
      }

      const rankedCandidates = [...scores.entries()]
        .filter(([, score]) => maxScore > 0 ? (score / maxScore) >= threshold : false)
        .map(([id, score]) => ({ id, normalized_score: maxScore > 0 ? score / maxScore : 0 }))
        .sort((a, b) => b.normalized_score - a.normalized_score)
        .slice(0, limit);

      // Fetch symbol details and snippets
      const results: Record<string, unknown>[] = [];
      for (const candidate of rankedCandidates) {
        const sym = db.prepare("SELECT * FROM symbols WHERE id = ?").get(candidate.id) as Record<string, unknown> | undefined;
        if (!sym) continue;

        let snippet = "";
        try {
          const absPath = resolve(workspaceRoot, sym.file_path as string);
          if (existsSync(absPath)) {
            const lines = readFileSync(absPath, "utf-8").split("\n");
            const startLine = (sym.start_line as number) ?? 1;
            const endLine = Math.min((sym.end_line as number) ?? startLine, lines.length);
            snippet = lines.slice(startLine - 1, Math.min(endLine, startLine + 10)).join("\n").slice(0, 500);
          }
        } catch { /* skip */ }

        results.push({
          symbol_id: sym.id,
          symbol_name: sym.symbol_name,
          file_path: sym.file_path,
          symbol_type: sym.symbol_type,
          score: Math.round(candidate.normalized_score * 1000) / 1000,
          snippet,
        });
      }

      return jsonOk({
        results,
        backend: "tfidf",
        total_matches: scores.size,
        query_tokens: queryTokens.filter((t) => idf.has(t)),
      });
    }),
  );
}

// ─── Helper: compute near-duplicate pairs from MinHash signatures ─────

function computeNearDuplicates(
  db: Database.Database,
  allSigs: Map<number, number[]>,
  threshold: number,
  hasMetadata: boolean,
): number {
  const ids = [...allSigs.keys()];
  let count = 0;

  const insertEdge = hasMetadata
    ? db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, edge_type, metadata) VALUES (?, ?, ?, ?)`)
    : db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, edge_type) VALUES (?, ?, ?)`);

  db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      const sigA = allSigs.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const sigB = allSigs.get(ids[j])!;
        const sim = jaccardFromSignatures(sigA, sigB);
        if (sim >= threshold) {
          const meta = JSON.stringify({ score: Math.round(sim * 1000) / 1000, algorithm: "minhash", num_hashes: MINHASH_NUM_HASHES, shingle_k: MINHASH_SHINGLE_K });
          if (hasMetadata) {
            insertEdge.run(ids[i], ids[j], EDGE_TYPES.SIMILAR_TO, meta);
          } else {
            insertEdge.run(ids[i], ids[j], EDGE_TYPES.SIMILAR_TO);
          }
          count++;
        }
      }
    }
  })();

  return count;
}