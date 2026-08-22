// CogMemory MCP — File walker with gitignore respect

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ignore from "ignore";

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cogmemory",
  "__pycache__",
  ".venv",
  "venv",
  "*.min.js",
  "*.min.css",
  "*.map",
];

export interface WalkOptions {
  /** File extensions to include (without dot), e.g. ['ts', 'tsx', 'js', 'jsx'] */
  extensions: string[];
  /** Maximum directory depth (default 20) */
  maxDepth?: number;
  /** Additional ignore patterns */
  extraIgnore?: string[];
}

/**
 * Walk a directory tree, respecting .gitignore and collecting matching file paths.
 * Returns absolute paths.
 */
export function walkFiles(rootDir: string, options: WalkOptions): string[] {
  const { extensions, maxDepth = 20, extraIgnore = [] } = options;
  const results: string[] = [];

  // Build ignore instance from .gitignore if present
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS).add(extraIgnore);

  // Load .gitignore from root
  const gitignorePath = join(rootDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const gitignoreContent = readFileSync(gitignorePath, "utf-8");
      ig.add(gitignoreContent);
    } catch {
      // Ignore errors reading .gitignore
    }
  }

  const extSet = new Set(extensions.map((e) => `.${e}`));

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) {
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Permission errors, etc.
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(rootDir, fullPath);

      // Check ignore
      if (ig.ignores(relPath + (statSync(fullPath).isDirectory() ? "/" : ""))) {
        continue;
      }

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        // Check extension
        const dotIndex = entry.lastIndexOf(".");
        if (dotIndex > 0) {
          const ext = entry.substring(dotIndex);
          if (extSet.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    }
  }

  walk(rootDir, 0);
  return results;
}

/**
 * Walk files and return paths with modification times for incremental indexing.
 */
export function walkFilesWithMtime(
  rootDir: string,
  options: WalkOptions,
): { path: string; mtime: number }[] {
  const { extensions, maxDepth = 20, extraIgnore = [] } = options;
  const results: { path: string; mtime: number }[] = [];

  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS).add(extraIgnore);

  const gitignorePath = join(rootDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      ig.add(readFileSync(gitignorePath, "utf-8"));
    } catch {
      // Ignore errors
    }
  }

  const extSet = new Set(extensions.map((e) => `.${e}`));

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(rootDir, fullPath);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (ig.ignores(relPath + (stat.isDirectory() ? "/" : ""))) continue;
      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const dotIndex = entry.lastIndexOf(".");
        if (dotIndex > 0 && extSet.has(entry.substring(dotIndex))) {
          results.push({ path: fullPath, mtime: stat.mtimeMs });
        }
      }
    }
  }

  walk(rootDir, 0);
  return results;
}
