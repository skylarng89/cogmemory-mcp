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
 * Extract named declarations from a source file.
 */
function extractSymbols(
  sourceFile: SourceFile,
  filePath: string,
  symbols: ExtractedSymbol[],
  symbolIndex: Map<string, ExtractedSymbol>,
): void {
  // Functions
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue; // Skip anonymous functions
    const sym: ExtractedSymbol = {
      file_path: filePath,
      symbol_name: name,
      symbol_type: fn.isAsync() ? "async-function" : "function",
      start_line: fn.getStartLineNumber(),
      end_line: fn.getEndLineNumber(),
    };
    symbols.push(sym);
    symbolIndex.set(`${filePath}:${name}`, sym);
  }

  // Classes
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    const sym: ExtractedSymbol = {
      file_path: filePath,
      symbol_name: name,
      symbol_type: "class",
      start_line: cls.getStartLineNumber(),
      end_line: cls.getEndLineNumber(),
    };
    symbols.push(sym);
    symbolIndex.set(`${filePath}:${name}`, sym);

    // Methods within class
    for (const method of cls.getMethods()) {
      const methodName = method.getName();
      const mSym: ExtractedSymbol = {
        file_path: filePath,
        symbol_name: `${name}.${methodName}`,
        symbol_type: "method",
        start_line: method.getStartLineNumber(),
        end_line: method.getEndLineNumber(),
      };
      symbols.push(mSym);
      symbolIndex.set(`${filePath}:${name}.${methodName}`, mSym);
    }
  }

  // Interfaces
  for (const iface of sourceFile.getInterfaces()) {
    const name = iface.getName();
    const sym: ExtractedSymbol = {
      file_path: filePath,
      symbol_name: name,
      symbol_type: "interface",
      start_line: iface.getStartLineNumber(),
      end_line: iface.getEndLineNumber(),
    };
    symbols.push(sym);
    symbolIndex.set(`${filePath}:${name}`, sym);
  }

  // Type aliases
  for (const ta of sourceFile.getTypeAliases()) {
    const name = ta.getName();
    const sym: ExtractedSymbol = {
      file_path: filePath,
      symbol_name: name,
      symbol_type: "type-alias",
      start_line: ta.getStartLineNumber(),
      end_line: ta.getEndLineNumber(),
    };
    symbols.push(sym);
    symbolIndex.set(`${filePath}:${name}`, sym);
  }

  // Enums
  for (const en of sourceFile.getEnums()) {
    const name = en.getName();
    const sym: ExtractedSymbol = {
      file_path: filePath,
      symbol_name: name,
      symbol_type: "enum",
      start_line: en.getStartLineNumber(),
      end_line: en.getEndLineNumber(),
    };
    symbols.push(sym);
    symbolIndex.set(`${filePath}:${name}`, sym);
  }

  // Variable declarations (exported const/let/var with function or object values)
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (!name) continue;
    // Only include top-level declarations (not inside functions)
    const parentKind = varDecl.getParent()?.getParent()?.getKind();
    if (parentKind === SyntaxKind.VariableStatement) {
      const sym: ExtractedSymbol = {
        file_path: filePath,
        symbol_name: name,
        symbol_type: "variable",
        start_line: varDecl.getStartLineNumber(),
        end_line: varDecl.getEndLineNumber(),
      };
      symbols.push(sym);
      symbolIndex.set(`${filePath}:${name}`, sym);
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
  // Import edges
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const resolved = resolveImportPath(
      sourceFile.getFilePath(),
      moduleSpecifier,
      rootDir,
    );

    if (resolved) {
      const namedImports = importDecl.getNamedImports();
      for (const named of namedImports) {
        edges.push({
          from_file: filePath,
          from_name: filePath,
          from_start_line: importDecl.getStartLineNumber(),
          to_file: resolved,
          to_name: named.getName(),
          to_start_line: null,
          edge_type: "imports",
        });
      }

      // Default import
      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        edges.push({
          from_file: filePath,
          from_name: filePath,
          from_start_line: importDecl.getStartLineNumber(),
          to_file: resolved,
          to_name: "default",
          to_start_line: null,
          edge_type: "imports",
        });
      }
    }
  }

  // Call expression edges
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      const startLine = node.getStartLineNumber();

      // Direct function call: foo()
      if (Node.isIdentifier(expr)) {
        const calleeName = expr.getText();
        // Look up in the same file
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

      // Method call: obj.method()
      if (Node.isPropertyAccessExpression(expr)) {
        const methodName = expr.getName();
        // We can only track calls to known methods
        // This is a heuristic — we record the call but can't always resolve the target
        edges.push({
          from_file: filePath,
          from_name: findEnclosingSymbol(node, filePath),
          from_start_line: startLine,
          to_file: filePath,
          to_name: methodName,
          to_start_line: null,
          edge_type: "calls",
        });
      }
    }
  });

  // Class extends/implements edges
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

    const interfaces = cls.getImplements();
    for (const iface of interfaces) {
      const ifaceName = iface.getExpression().getText();
      edges.push({
        from_file: filePath,
        from_name: className,
        from_start_line: cls.getStartLineNumber(),
        to_file: filePath,
        to_name: ifaceName,
        to_start_line: null,
        edge_type: "implements",
      });
    }
  }
}

/**
 * Find the name of the enclosing symbol (function/class/method) for a node.
 */
function findEnclosingSymbol(node: Node, filePath: string): string {
  let current: Node | undefined = node;
  while (current) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current)
    ) {
      const name = current.getName();
      if (name) return name;
    }
    if (Node.isMethodDeclaration(current)) {
      const name = current.getName();
      const parentClass = current.getParent();
      if (Node.isClassDeclaration(parentClass)) {
        const className = parentClass.getName();
        if (className) return `${className}.${name}`;
      }
      return name;
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

  // For relative imports, compute the resolved path
  const dir = dirname(fromFile);
  let resolved = pathJoin(dir, moduleSpecifier);

  // Add common extensions if not present
  const exts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
  ];
  if (!exts.some((ext) => resolved.endsWith(ext))) {
    // Try extensions in order
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      try {
        const fullPath = pathJoin(_rootDir, resolved + ext);
        if (existsSync(fullPath)) {
          return resolved + ext;
        }
      } catch {
        // Continue
      }
    }
    // Try index files
    for (const ext of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) {
      try {
        const fullPath = pathJoin(_rootDir, resolved + ext);
        if (existsSync(fullPath)) {
          return resolved + ext;
        }
      } catch {
        // Continue
      }
    }
  }

  return resolved;
}
