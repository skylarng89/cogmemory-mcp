// CogMemory MCP — Analyzer registry with extension-based dispatch
//
// Central registry of all LanguageAnalyzer instances. New languages are added
// by (a) implementing the LanguageAnalyzer interface and (b) registering the
// instance in the BUILTIN_ANALYZERS array below.
//
// The registry is consumed by the indexing pipeline (code-graph.ts) which calls
// analyzeMixed() below to dispatch files to the correct analyzer.

import type { LanguageAnalyzer, AnalysisResult } from "./types.js";
import { tsAnalyzer } from "./ts-analyzer.js";
import { pythonAnalyzer } from "./py-analyzer.js";
import { goAnalyzer } from "./go-analyzer.js";

// ─── Built-in analyzers ────────────────────────────────────
// To add a new language: implement LanguageAnalyzer and add it here.
// Order does not matter — the registry deduplicates by extension.
const BUILTIN_ANALYZERS: LanguageAnalyzer[] = [
  tsAnalyzer,
  pythonAnalyzer,
  goAnalyzer,
];

// ─── Registry singleton ─────────────────────────────────

/**
 * Extension → LanguageAnalyzer map, built once from BUILTIN_ANALYZERS.
 * Keys include the leading dot, e.g. ".ts", ".py".
 */
const extensionMap = new Map<string, LanguageAnalyzer>();

/** All registered analyzers, for iteration. */
const allAnalyzers: LanguageAnalyzer[] = [...BUILTIN_ANALYZERS];

function buildExtensionMap(): void {
  extensionMap.clear();
  for (const analyzer of allAnalyzers) {
    for (const ext of analyzer.extensions) {
      const normalized = ext.startsWith(".") ? ext : `.${ext}`;
      if (extensionMap.has(normalized)) {
        console.error(
          `[analyzer-registry] WARNING: extension "${normalized}" already registered ` +
          `— skipping duplicate from analyzer with extensions [${analyzer.extensions.join(", ")}]`,
        );
        continue;
      }
      extensionMap.set(normalized, analyzer);
    }
  }
}

// Build the map eagerly so queries are synchronous.
buildExtensionMap();

// ─── Public API ────────────────────────────────────────────

/**
 * Look up the LanguageAnalyzer for a given file extension.
 * @param ext File extension WITH dot, e.g. ".ts", ".py"
 * @returns The registered analyzer, or undefined if no analyzer handles this extension.
 */
export function getAnalyzerForExtension(ext: string): LanguageAnalyzer | undefined {
  const normalized = ext.startsWith(".") ? ext : `.${ext}`;
  return extensionMap.get(normalized);
}

/**
 * Get all registered extensions.
 */
export function getSupportedExtensions(): string[] {
  return [...extensionMap.keys()];
}

/**
 * Register a new LanguageAnalyzer at runtime.
 * If any of the analyzer's extensions are already registered, those are skipped
 * with a console warning (the original registration wins).
 */
export function registerAnalyzer(analyzer: LanguageAnalyzer): void {
  allAnalyzers.push(analyzer);
  buildExtensionMap();
}

/**
 * Dispatch a mixed batch of files to the correct analyzer(s) based on extension.
 * Returns merged symbols + edges from all analyzers.
 *
 * Files with extensions not handled by any registered analyzer are silently skipped.
 */
export function analyzeMixed(
  files: string[],
  rootDir: string,
): AnalysisResult {
  // Group files by their owning analyzer
  const groups = new Map<LanguageAnalyzer, string[]>();

  for (const file of files) {
    const dotIndex = file.lastIndexOf(".");
    if (dotIndex < 0) continue; // no extension
    const ext = file.substring(dotIndex).toLowerCase();

    const analyzer = extensionMap.get(ext);
    if (!analyzer) continue;

    let list = groups.get(analyzer);
    if (!list) {
      list = [];
      groups.set(analyzer, list);
    }
    list.push(file);
  }

  // Invoke each analyzer and merge results
  const allSymbols: AnalysisResult["symbols"] = [];
  const allEdges: AnalysisResult["edges"] = [];

  for (const [analyzer, batch] of groups) {
    const result = analyzer.analyze(batch, rootDir);
    allSymbols.push(...result.symbols);
    allEdges.push(...result.edges);
  }

  return { symbols: allSymbols, edges: allEdges };
}