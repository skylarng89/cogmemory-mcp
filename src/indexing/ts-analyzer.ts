// CogMemory MCP — ts-morph based symbol and edge extraction for JS/TS

import { Project, SyntaxKind, Node, type SourceFile } from "ts-morph";
import { relative, dirname, join as pathJoin } from "node:path";
import { existsSync } from "node:fs";

export interface ExtractedSymbol {
  file_path: string;
  symbol_name: string;
  symbol_type: string;
  start_line: number | null;
  end_line: number | null;
}

export interface ExtractedEdge {
  from_file: string;
  from_name: string;
  from_start_line: number | null;
  to_file: string;
  to_name: string;
  to_start_line: number | null;
  edge_type: string;
}

export interface AnalysisResult {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

/**
 * Analyze a set of JS/TS files using ts-morph and extract symbols + edges.
 * Symbols: files, functions, classes, interfaces, methods, type aliases, enums
 * Edges: function calls, imports, class extends/implements
 */
export function analyzeFiles(files: string[], rootDir: string): AnalysisResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      jsx: 4, // JsxEmit.React
      target: 99, // ScriptTarget.ESNext
      module: 99, // ModuleKind.ESNext
      moduleResolution: 3, // ModuleResolutionKind.NodeJs
    },
  });

  // Add all files to the project
  for (const file of files) {
    project.addSourceFileAtPath(file);
  }

  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];

  // Collect all symbols first to build a name → symbol map
  const symbolIndex = new Map<string, ExtractedSymbol>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = relative(rootDir, sourceFile.getFilePath());

    // File-level symbol
    symbols.push({
      file_path: filePath,
      symbol_name: filePath,
      symbol_type: "file",
      start_line: 1,
      end_line: sourceFile.getEndLineNumber(),
    });

    extractSymbols(sourceFile, filePath, symbols, symbolIndex);
    extractEdges(sourceFile, filePath, edges, symbolIndex, rootDir);
  }

  return { symbols, edges };
}

/**
 * Register a symbol in the collection and index.
 */
function registerSymbol(
  filePath: string,
  name: string,
  symbolType: string,
  startLine: number,
  endLine: number,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  const sym: ExtractedSymbol = {
    file_path: filePath,
    symbol_name: name,
    symbol_type: symbolType,
    start_line: startLine,
    end_line: endLine,
  };
  symbols.push(sym);
  symbolIndex.set(`${filePath}:${name}`, sym);
}

/**
 * Extract named declarations from a source file.
 */
function extractSymbols(
  sourceFile: SourceFile,
  filePath: string,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  extractFunctions(sourceFile, filePath, symbols, symbolIndex);
  extractClasses(sourceFile, filePath, symbols, symbolIndex);
  extractSimpleDeclarations(sourceFile, filePath, symbols, symbolIndex);
  extractVariables(sourceFile, filePath, symbols, symbolIndex);
}

function extractFunctions(
  sourceFile: SourceFile,
  filePath: string,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const type = fn.isAsync() ? "async-function" : "function";
    registerSymbol(
      filePath,
      name,
      type,
      fn.getStartLineNumber(),
      fn.getEndLineNumber(),
      symbols,
      symbolIndex,
    );
  }
}

function extractClasses(
  sourceFile: SourceFile,
  filePath: string,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    registerSymbol(
      filePath,
      name,
      "class",
      cls.getStartLineNumber(),
      cls.getEndLineNumber(),
      symbols,
      symbolIndex,
    );
    for (const method of cls.getMethods()) {
      registerSymbol(
        filePath,
        `${name}.${method.getName()}`,
        "method",
        method.getStartLineNumber(),
        method.getEndLineNumber(),
        symbols,
        symbolIndex,
      );
    }
  }
}

function extractSimpleDeclarations(
  sourceFile: SourceFile,
  filePath: string,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  for (const iface of sourceFile.getInterfaces()) {
    registerSymbol(
      filePath,
      iface.getName(),
      "interface",
      iface.getStartLineNumber(),
      iface.getEndLineNumber(),
      symbols,
      symbolIndex,
    );
  }
  for (const ta of sourceFile.getTypeAliases()) {
    registerSymbol(
      filePath,
      ta.getName(),
      "type-alias",
      ta.getStartLineNumber(),
      ta.getEndLineNumber(),
      symbols,
      symbolIndex,
    );
  }
  for (const en of sourceFile.getEnums()) {
    registerSymbol(
      filePath,
      en.getName(),
      "enum",
      en.getStartLineNumber(),
      en.getEndLineNumber(),
      symbols,
      symbolIndex,
    );
  }
}

function extractVariables(
  sourceFile: SourceFile,
  filePath: string,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (!name) continue;
    const parentKind = varDecl.getParent()?.getParent()?.getKind();
    if (parentKind === SyntaxKind.VariableStatement) {
      registerSymbol(
        filePath,
        name,
        "variable",
        varDecl.getStartLineNumber(),
        varDecl.getEndLineNumber(),
        symbols,
        symbolIndex,
      );
    }
  }
}

/**
 * Extract edges (calls, imports, extends, implements) from a source file.
 */
function extractEdges(
  sourceFile: SourceFile,
  filePath: string,
  edges: ExtractedEdge[],
  symbolIndex: Map<string, ExtractedSymbol>,
  rootDir: string,
): void {
  processImportEdges(sourceFile, filePath, edges, rootDir);
  sourceFile.forEachDescendant((node) => {
    processCallExpression(node, filePath, edges, symbolIndex);
  });
  processClassHierarchyEdges(sourceFile, filePath, edges, rootDir);
}

function processImportEdges(
  sourceFile: SourceFile,
  filePath: string,
  edges: ExtractedEdge[],
  rootDir: string,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const resolved = resolveImportPath(
      sourceFile.getFilePath(),
      importDecl.getModuleSpecifierValue(),
      rootDir,
    );
    if (!resolved) continue;

    const startLine = importDecl.getStartLineNumber();
    for (const named of importDecl.getNamedImports()) {
      edges.push({
        from_file: filePath,
        from_name: filePath,
        from_start_line: startLine,
        to_file: resolved,
        to_name: named.getName(),
        to_start_line: null,
        edge_type: "imports",
      });
    }

    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) {
      edges.push({
        from_file: filePath,
        from_name: filePath,
        from_start_line: startLine,
        to_file: resolved,
        to_name: "default",
        to_start_line: null,
        edge_type: "imports",
      });
    }
  }
}

function processCallExpression(
  node: Node,
  filePath: string,
  edges: ExtractedEdge[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  if (!Node.isCallExpression(node)) return;
  const expr = node.getExpression();
  const startLine = node.getStartLineNumber();

  if (Node.isIdentifier(expr)) {
    const calleeName = expr.getText();
    const key = `${filePath}:${calleeName}`;
    if (symbolIndex.has(key)) {
      edges.push({
        from_file: filePath,
        from_name: findEnclosingSymbol(node, filePath),
        from_start_line: startLine,
        to_file: filePath,
        to_name: calleeName,
        to_start_line: symbolIndex.get(key)!.start_line,
        edge_type: "calls",
      });
    }
  }

  if (Node.isPropertyAccessExpression(expr)) {
    edges.push({
      from_file: filePath,
      from_name: findEnclosingSymbol(node, filePath),
      from_start_line: startLine,
      to_file: filePath,
      to_name: expr.getName(),
      to_start_line: null,
      edge_type: "calls",
    });
  }
}

function processClassHierarchyEdges(
  sourceFile: SourceFile,
  filePath: string,
  edges: ExtractedEdge[],
  rootDir: string,
): void {
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName();
    if (!className) continue;

    const baseClass = cls.getBaseClass();
    if (baseClass) {
      const baseName = baseClass.getName() ?? "AnonymousBase";
      const baseFilePath =
        relative(rootDir, baseClass.getSourceFile().getFilePath()) ?? filePath;
      edges.push({
        from_file: filePath,
        from_name: className,
        from_start_line: cls.getStartLineNumber(),
        to_file: baseFilePath,
        to_name: baseName,
        to_start_line: baseClass.getStartLineNumber(),
        edge_type: "extends",
      });
    }

    for (const iface of cls.getImplements()) {
      edges.push({
        from_file: filePath,
        from_name: className,
        from_start_line: cls.getStartLineNumber(),
        to_file: filePath,
        to_name: iface.getExpression().getText(),
        to_start_line: null,
        edge_type: "implements",
      });
    }
  }
}

/**
 * Resolve a method declaration to its qualified name (ClassName.methodName).
 */
function resolveMethodSymbol(node: Node): string | null {
  if (!Node.isMethodDeclaration(node)) return null;
  const name = node.getName();
  const parentClass = node.getParent();
  if (Node.isClassDeclaration(parentClass)) {
    const className = parentClass.getName();
    if (className) return `${className}.${name}`;
  }
  return name;
}

/**
 * Find the name of the enclosing symbol (function/class/method) for a node.
 */
function findEnclosingSymbol(node: Node, filePath: string): string {
  let current: Node | undefined = node;
  while (current) {
    const methodResult = resolveMethodSymbol(current);
    if (methodResult !== null) return methodResult;

    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current)
    ) {
      const name = current.getName();
      if (name) return name;
    }
    if (Node.isClassDeclaration(current)) {
      const name = current.getName();
      if (name) return name;
    }
    current = current.getParent();
  }
  return filePath;
}

/**
 * Attempt to resolve an import module specifier to a relative file path.
 * Returns null if not resolvable (e.g. node_modules packages).
 */
function resolveImportPath(
  fromFile: string,
  moduleSpecifier: string,
  _rootDir: string,
): string | null {
  // Skip node_modules-style imports (no relative path)
  if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
    return null;
  }

  const dir = dirname(fromFile);
  const resolved = pathJoin(dir, moduleSpecifier);

  const knownExts = [".ts", ".tsx", ".js", ".jsx"];
  if (knownExts.some((ext) => resolved.endsWith(ext))) {
    return resolved;
  }

  const candidates = [
    ...knownExts.map((ext) => resolved + ext),
    ...knownExts.map((ext) => resolved + "/index" + ext),
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(pathJoin(_rootDir, candidate))) {
        return candidate;
      }
    } catch {
      // Continue
    }
  }

  return resolved;
}
