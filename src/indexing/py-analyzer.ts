// CogMemory MCP — tree-sitter based symbol and edge extraction for Python

import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import { relative } from "node:path";
import { readFileSync } from "node:fs";
import type {
  AnalysisResult,
  ExtractedSymbol,
  ExtractedEdge,
  LanguageAnalyzer,
} from "./types.js";

// ─── Node types from tree-sitter-python ───────────────────
// Reference: https://github.com/tree-sitter/tree-sitter-python
type TSNode = Parser.SyntaxNode;

/** Mutable context threaded through the recursive walker. */
interface WalkCtx {
  filePath: string;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  symbolIndex: Map<string, ExtractedSymbol>;
  /** Set of names from `__all__` list, if present in the file. */
  allNames: Set<string> | null;
}

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Python);
  }
  return parser;
}

// ─── Analyzer implementation ────────────────────────────────

const PY_EXTENSIONS: readonly string[] = [".py"];

function analyzePyFiles(files: string[], rootDir: string): AnalysisResult {
  const parserInstance = getParser();
  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const symbolIndex = new Map<string, ExtractedSymbol>();

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const tree = parserInstance.parse(source);
    const filePath = relative(rootDir, file);

    // Extract __all__ if present
    const allNames = extractAllNames(tree.rootNode);

    symbols.push({
      file_path: filePath,
      symbol_name: filePath,
      symbol_type: "file",
      start_line: 1,
      end_line: source.split("\n").length,
    });

    const ctx: WalkCtx = { filePath, symbols, edges, symbolIndex, allNames };
    walkNode(tree.rootNode, ctx, null);
  }

  return { symbols, edges };
}

/**
 * Python language analyzer conforming to the LanguageAnalyzer interface.
 * Handles `.py` files via tree-sitter.
 */
export const pythonAnalyzer: LanguageAnalyzer = {
  extensions: PY_EXTENSIONS,
  analyze: analyzePyFiles,
};

/**
 * Standalone entry point — preserved for backward compatibility.
 * Prefer using the `pythonAnalyzer` object and the analyzer registry for new code.
 */
export const analyzePythonFiles = analyzePyFiles;

// ─── Symbol / edge helpers ────────────────────────────────

function makeSymbol(
  filePath: string,
  name: string,
  type: string,
  node: TSNode,
  isExported: boolean = false,
): ExtractedSymbol {
  return {
    file_path: filePath,
    symbol_name: name,
    symbol_type: type,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    is_exported: isExported,
  };
}

function registerSymbol(ctx: WalkCtx, sym: ExtractedSymbol): void {
  ctx.symbols.push(sym);
  ctx.symbolIndex.set(`${ctx.filePath}:${sym.symbol_name}`, sym);
}

/**
 * Dual export rule for Python:
 * (a) If __all__ is present, a symbol is exported iff its name appears in __all__.
 * (b) Otherwise, a top-level def/class is exported iff its name does not start with _.
 */
function isExportedByRule(ctx: WalkCtx, name: string, isTopLevel: boolean): boolean {
  if (ctx.allNames !== null) {
    // __all__ is authoritative
    return ctx.allNames.has(name);
  }
  // Fallback: non-underscored top-level names are exported
  return isTopLevel && !name.startsWith("_");
}

function pushEdge(
  ctx: WalkCtx,
  fromName: string,
  fromLine: number,
  toFile: string,
  toName: string,
  toLine: number | null,
  edgeType: string,
): void {
  ctx.edges.push({
    from_file: ctx.filePath,
    from_name: fromName,
    from_start_line: fromLine,
    to_file: toFile,
    to_name: toName,
    to_start_line: toLine,
    edge_type: edgeType,
  });
}

function childText(node: TSNode, fieldName: string): string {
  return node.childForFieldName(fieldName)?.text ?? "";
}

// ─── Node-type handlers ──────────────────────────────────

/**
 * Extract names from `__all__ = [...]` assignment if present.
 * Returns null if no __all__ found.
 */
function extractAllNames(rootNode: TSNode): Set<string> | null {
  for (const child of rootNode.children) {
    if (child.type !== "expression_statement") continue;
    const expr = child.childForFieldName("body") ?? child.children[0];
    if (!expr || expr.type !== "assignment") continue;
    const left = expr.childForFieldName("left");
    if (!left || left.text !== "__all__") continue;
    const right = expr.childForFieldName("right");
    if (!right) continue;
    const names = new Set<string>();
    // __all__ can be a list or tuple
    for (const item of right.children) {
      if (item.type === "string") {
        // Strip quotes
        const val = item.text.replace(/^['"bfru]*/, "").replace(/['"]+$/, "");
        names.add(val);
      }
    }
    return names.size > 0 ? names : null;
  }
  return null;
}

function handleFunctionDef(
  node: TSNode,
  ctx: WalkCtx,
  enclosingName: string | null,
): void {
  const name = childText(node, "name");
  const isAsync = node.firstChild?.type === "async";
  const isTopLevel = enclosingName === null;
  const isExported = isExportedByRule(ctx, name, isTopLevel);
  registerSymbol(
    ctx,
    makeSymbol(
      ctx.filePath,
      name,
      isAsync ? "async-function" : "function",
      node,
      isExported,
    ),
  );

  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.children) {
      walkNode(child, ctx, name);
    }
  }
}

function handleClassDef(node: TSNode, ctx: WalkCtx): void {
  const name = childText(node, "name");
  const isExported = isExportedByRule(ctx, name, true);
  registerSymbol(ctx, makeSymbol(ctx.filePath, name, "class", node, isExported));

  extractInheritanceEdges(node, ctx, name);
  walkClassBody(node, ctx, name);
}

function extractInheritanceEdges(
  node: TSNode,
  ctx: WalkCtx,
  className: string,
): void {
  const superclasses = node.childForFieldName("superclasses");
  if (!superclasses) return;

  const startLine = node.startPosition.row + 1;
  for (const base of superclasses.children) {
    if (base.type === "argument_list") continue;
    const baseName = base.text;
    if (!baseName) continue;
    pushEdge(
      ctx,
      className,
      startLine,
      ctx.filePath,
      baseName,
      null,
      "extends",
    );
  }
}

function walkClassBody(node: TSNode, ctx: WalkCtx, className: string): void {
  const body = node.childForFieldName("body");
  if (!body) return;

  for (const child of body.children) {
    if (child.type === "function_definition") {
      handleMethodDef(child, ctx, className);
    } else {
      walkNode(child, ctx, className);
    }
  }
}

function handleMethodDef(node: TSNode, ctx: WalkCtx, className: string): void {
  const methodName = childText(node, "name");
  const qualifiedName = `${className}.${methodName}`;
  registerSymbol(ctx, makeSymbol(ctx.filePath, qualifiedName, "method", node));

  const methodBody = node.childForFieldName("body");
  if (methodBody) {
    for (const child of methodBody.children) {
      walkNode(child, ctx, qualifiedName);
    }
  }
}

// ─── Main walker ─────────────────────────────────────────

function walkNode(
  node: TSNode,
  ctx: WalkCtx,
  enclosingName: string | null,
): void {
  if (node.type === "decorated_definition") {
    for (const child of node.children) {
      walkNode(child, ctx, enclosingName);
    }
    return;
  }

  if (node.type === "function_definition") {
    handleFunctionDef(node, ctx, enclosingName);
    return;
  }

  if (node.type === "class_definition") {
    handleClassDef(node, ctx);
    return;
  }

  if (
    node.type === "import_statement" ||
    node.type === "import_from_statement"
  ) {
    extractImportEdges(node, ctx);
    return;
  }

  if (node.type === "call") {
    extractCallEdge(node, ctx, enclosingName);
  }

  for (const child of node.children) {
    walkNode(child, ctx, enclosingName);
  }
}

// ─── Edge extraction ─────────────────────────────────────

function extractImportEdges(node: TSNode, ctx: WalkCtx): void {
  const startLine = node.startPosition.row + 1;

  if (node.type === "import_statement") {
    extractSimpleImportEdges(node, ctx, startLine);
    return;
  }

  extractFromImportEdges(node, ctx, startLine);
}

function extractSimpleImportEdges(
  node: TSNode,
  ctx: WalkCtx,
  startLine: number,
): void {
  for (const child of node.children) {
    if (child.type === "dotted_name") {
      pushEdge(
        ctx,
        ctx.filePath,
        startLine,
        child.text,
        child.text,
        null,
        "imports",
      );
    } else if (child.type === "aliased_import") {
      const original = child.childForFieldName("name")?.text ?? "";
      if (original) {
        pushEdge(
          ctx,
          ctx.filePath,
          startLine,
          original,
          original,
          null,
          "imports",
        );
      }
    }
  }
}

function extractFromImportEdges(
  node: TSNode,
  ctx: WalkCtx,
  startLine: number,
): void {
  const moduleName = node.childForFieldName("module_name")?.text ?? "";

  if (node.children.some((c) => c.type === "wildcard_import")) {
    pushEdge(ctx, ctx.filePath, startLine, moduleName, "*", null, "imports");
    return;
  }

  const moduleNode = node.childForFieldName("module_name");
  for (const child of node.children) {
    if (child.type === "dotted_name" && child !== moduleNode) {
      pushEdge(
        ctx,
        ctx.filePath,
        startLine,
        moduleName,
        child.text,
        null,
        "imports",
      );
    } else if (child.type === "aliased_import") {
      const original = child.childForFieldName("name")?.text ?? "";
      if (original) {
        pushEdge(
          ctx,
          ctx.filePath,
          startLine,
          moduleName,
          original,
          null,
          "imports",
        );
      }
    }
  }
}

function extractCallEdge(
  node: TSNode,
  ctx: WalkCtx,
  enclosingName: string | null,
): void {
  const func = node.childForFieldName("function");
  if (!func) return;

  const startLine = node.startPosition.row + 1;
  const callerName = enclosingName ?? ctx.filePath;

  if (func.type === "identifier") {
    const calleeName = func.text;
    const target = ctx.symbolIndex.get(`${ctx.filePath}:${calleeName}`);
    pushEdge(
      ctx,
      callerName,
      startLine,
      ctx.filePath,
      calleeName,
      target?.start_line ?? null,
      "calls",
    );
    return;
  }

  if (func.type === "attribute") {
    const methodName = func.childForFieldName("attribute")?.text ?? "";
    if (methodName) {
      pushEdge(
        ctx,
        callerName,
        startLine,
        ctx.filePath,
        methodName,
        null,
        "calls",
      );
    }
  }
}