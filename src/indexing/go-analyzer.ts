// CogMemory MCP — tree-sitter based symbol and edge extraction for Go

import Parser from "tree-sitter";
import Go from "tree-sitter-go";
import { relative } from "node:path";
import { readFileSync } from "node:fs";
import type {
  AnalysisResult,
  ExtractedSymbol,
  ExtractedEdge,
  LanguageAnalyzer,
} from "./types.js";

type TSNode = Parser.SyntaxNode;

/** Mutable context threaded through the recursive walker. */
interface WalkCtx {
  filePath: string;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  symbolIndex: Map<string, ExtractedSymbol>;
}

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Go);
  }
  return parser;
}

// ─── Analyzer implementation ────────────────────────────────

const GO_EXTENSIONS: readonly string[] = [".go"];

function analyzeGoFiles(files: string[], rootDir: string): AnalysisResult {
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

    // File-level symbol
    symbols.push({
      file_path: filePath,
      symbol_name: filePath,
      symbol_type: "file",
      start_line: 1,
      end_line: source.split("\n").length,
    });

    const ctx: WalkCtx = { filePath, symbols, edges, symbolIndex };
    walkNode(tree.rootNode, ctx, null);
  }

  return { symbols, edges };
}

/**
 * Go language analyzer conforming to the LanguageAnalyzer interface.
 * Handles `.go` files via tree-sitter.
 */
export const goAnalyzer: LanguageAnalyzer = {
  extensions: GO_EXTENSIONS,
  analyze: analyzeGoFiles,
};

// ─── Export rule ────────────────────────────────────────────

/**
 * Go export rule: an identifier is exported iff its first character is
 * uppercase (Unicode class Lu). This applies to packages, types, functions,
 * methods, fields, and constants.
 */
function isExported(name: string): boolean {
  return name.length > 0 && name[0] >= "A" && name[0] <= "Z";
}

// ─── Symbol / edge helpers ─────────────────────────────────

function makeSymbol(
  filePath: string,
  name: string,
  type: string,
  node: TSNode,
  exported: boolean = false,
): ExtractedSymbol {
  return {
    file_path: filePath,
    symbol_name: name,
    symbol_type: type,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    is_exported: exported,
  };
}

function registerSymbol(ctx: WalkCtx, sym: ExtractedSymbol): void {
  ctx.symbols.push(sym);
  ctx.symbolIndex.set(`${ctx.filePath}:${sym.symbol_name}`, sym);
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

// ─── Main walker ───────────────────────────────────────────

function walkNode(
  node: TSNode,
  ctx: WalkCtx,
  enclosingName: string | null,
): void {
  switch (node.type) {
    case "function_declaration":
      handleFunctionDecl(node, ctx);
      return;
    case "method_declaration":
      handleMethodDecl(node, ctx);
      return;
    case "type_declaration":
      handleTypeDeclaration(node, ctx);
      return;
    case "import_declaration":
      extractImportEdges(node, ctx);
      return;
    case "call_expression":
      extractCallEdge(node, ctx, enclosingName);
      break;
    case "var_declaration":
    case "const_declaration":
      extractVarConstDecls(node, ctx);
      break;
  }

  for (const child of node.children) {
    walkNode(child, ctx, enclosingName);
  }
}

// ─── Declaration handlers ──────────────────────────────────

function handleFunctionDecl(node: TSNode, ctx: WalkCtx): void {
  const name = childText(node, "name");
  if (!name) return;

  const exported = isExported(name);
  registerSymbol(
    ctx,
    makeSymbol(ctx.filePath, name, "function", node, exported),
  );

  // Walk the body for call edges
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.children) {
      walkNode(child, ctx, name);
    }
  }
}

function handleMethodDecl(node: TSNode, ctx: WalkCtx): void {
  const methodName = childText(node, "name");
  if (!methodName) return;

  // Resolve receiver type name for qualified method symbol
  const receiver = node.childForFieldName("receiver");
  let receiverType = "";
  if (receiver) {
    // Receiver is a parameter_list containing a parameter_declaration
    // The type is either a type_identifier (value receiver) or
    // pointer_type → type_identifier (pointer receiver)
    const paramDecl = receiver.children.find(
      (c) => c.type === "parameter_declaration",
    );
    if (paramDecl) {
      const typeNode = paramDecl.childForFieldName("type");
      if (typeNode) {
        if (typeNode.type === "type_identifier") {
          receiverType = typeNode.text;
        } else if (typeNode.type === "pointer_type") {
          // pointer_type contains a type_identifier
          const inner = typeNode.children.find(
            (c) => c.type === "type_identifier",
          );
          receiverType = inner?.text ?? "";
        }
      }
    }
  }

  const qualifiedName = receiverType
    ? `${receiverType}.${methodName}`
    : methodName;

  registerSymbol(
    ctx,
    makeSymbol(ctx.filePath, qualifiedName, "method", node, isExported(methodName)),
  );

  // Walk the body for call edges
  const body = node.childForFieldName("body");
  if (body) {
    for (const child of body.children) {
      walkNode(child, ctx, qualifiedName);
    }
  }
}

function handleTypeDeclaration(node: TSNode, ctx: WalkCtx): void {
  // A type_declaration contains one or more type_spec children
  for (const child of node.children) {
    if (child.type === "type_spec") {
      handleTypeSpec(child, ctx);
    }
  }
}

function handleTypeSpec(node: TSNode, ctx: WalkCtx): void {
  const name = childText(node, "name");
  if (!name) return;

  const exported = isExported(name);
  const typeNode = node.childForFieldName("type");
  if (!typeNode) {
    // Simple type alias — register as type-alias
    registerSymbol(
      ctx,
      makeSymbol(ctx.filePath, name, "type-alias", node, exported),
    );
    return;
  }

  switch (typeNode.type) {
    case "struct_type":
      registerSymbol(
        ctx,
        makeSymbol(ctx.filePath, name, "class", node, exported),
      );
      extractStructEmbedding(typeNode, ctx, name);
      break;
    case "interface_type":
      registerSymbol(
        ctx,
        makeSymbol(ctx.filePath, name, "interface", node, exported),
      );
      break;
    default:
      // Other type definitions (type aliases, etc.)
      registerSymbol(
        ctx,
        makeSymbol(ctx.filePath, name, "type-alias", node, exported),
      );
      break;
  }
}

/**
 * Extract struct embedding edges (Go's composition pattern).
 * An embedded field is a field_declaration whose only child is a type
 * identifier (no field name). This is Go's equivalent of inheritance/extends.
 */
function extractStructEmbedding(
  structNode: TSNode,
  ctx: WalkCtx,
  structName: string,
): void {
  // The field_declaration_list is a child of struct_type but has no field
  // name in tree-sitter-go, so we find it by type.
  let fieldList: TSNode | null = null;
  for (const child of structNode.children) {
    if (child.type === "field_declaration_list") {
      fieldList = child;
      break;
    }
  }
  if (!fieldList) return;

  for (const field of fieldList.children) {
    if (field.type !== "field_declaration") continue;

    // An embedded field has no `name` field — the type IS the field.
    // tree-sitter-go represents embedded types directly as children.
    const fieldNameNode = field.childForFieldName("name");
    if (fieldNameNode) continue; // Named field, not embedded

    // The type is the embedded type
    const typeNode = field.childForFieldName("type");
    if (!typeNode) continue;

    let embeddedType = "";
    if (typeNode.type === "type_identifier") {
      embeddedType = typeNode.text;
    } else if (typeNode.type === "pointer_type") {
      const inner = typeNode.children.find(
        (c) => c.type === "type_identifier",
      );
      embeddedType = inner?.text ?? "";
    } else if (typeNode.type === "qualified_type") {
      // pkg.TypeName — take the type part
      const typePart = typeNode.childForFieldName("type");
      embeddedType = typePart?.text ?? typeNode.text;
    }

    if (embeddedType) {
      pushEdge(
        ctx,
        structName,
        field.startPosition.row + 1,
        ctx.filePath,
        embeddedType,
        null,
        "extends",
      );
    }
  }
}

/**
 * Extract variable and constant declarations as symbols.
 * Go var/const declarations can declare multiple names.
 */
function extractVarConstDecls(node: TSNode, ctx: WalkCtx): void {
  // var_declaration / const_declaration contain:
  // - var_spec / const_spec (single)
  // - or multiple var_spec / const_spec in a group (var_spec_list)
  for (const child of node.children) {
    if (child.type === "var_spec" || child.type === "const_spec") {
      registerVarSpec(child, ctx);
    }
  }
}

function registerVarSpec(node: TSNode, ctx: WalkCtx): void {
  // var_spec / const_spec has a `name` field that is an identifier
  // or an identifier_list (multiple names)
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;

  if (nameNode.type === "identifier") {
    const name = nameNode.text;
    registerSymbol(
      ctx,
      makeSymbol(ctx.filePath, name, "variable", node, isExported(name)),
    );
  } else {
    // identifier_list — multiple names
    for (const idNode of nameNode.children) {
      if (idNode.type === "identifier") {
        const name = idNode.text;
        registerSymbol(
          ctx,
          makeSymbol(ctx.filePath, name, "variable", node, isExported(name)),
        );
      }
    }
  }
}

// ─── Edge extraction ──────────────────────────────────────

function extractImportEdges(node: TSNode, ctx: WalkCtx): void {
  const startLine = node.startPosition.row + 1;

  // import_declaration children can be:
  //   - "import" keyword
  //   - import_path (interpreted_string_literal) for single imports: import "fmt"
  //   - import_spec_list for grouped imports: import ( "fmt"; "strings" )
  //     which contains import_spec children
  for (const child of node.children) {
    if (child.type === "import_spec") {
      // Single import (rare — usually only in grouped form)
      handleImportSpec(child, ctx, startLine);
    } else if (child.type === "import_spec_list") {
      // Grouped imports — iterate the import_spec children inside
      for (const spec of child.children) {
        if (spec.type === "import_spec") {
          handleImportSpec(spec, ctx, startLine);
        }
      }
    } else if (child.type === "interpreted_string_literal") {
      // Single import without grouping: import "fmt"
      const importPath = stripQuotes(child.text);
      if (importPath) {
        pushEdge(
          ctx,
          ctx.filePath,
          startLine,
          importPath,
          importPath,
          null,
          "imports",
        );
      }
    }
  }
}

function handleImportSpec(
  node: TSNode,
  ctx: WalkCtx,
  startLine: number,
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;
  const importPath = stripQuotes(pathNode.text);
  if (!importPath) return;

  // Check for package alias: import alias "path"
  const aliasNode = node.childForFieldName("name");

  // Use the package name (alias or last segment of path) as the import name
  let importName: string;
  if (aliasNode) {
    importName = aliasNode.text;
  } else {
    const segments = importPath.split("/");
    importName = segments[segments.length - 1] || importPath;
  }

  pushEdge(
    ctx,
    ctx.filePath,
    startLine,
    importPath,
    importName,
    null,
    "imports",
  );
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

  if (func.type === "selector_expression") {
    // pkg.Func() or obj.Method() — extract the method/function name
    const fieldNode = func.childForFieldName("field");
    if (fieldNode) {
      const calleeName = fieldNode.text;
      pushEdge(
        ctx,
        callerName,
        startLine,
        ctx.filePath,
        calleeName,
        null,
        "calls",
      );
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}