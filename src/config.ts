// CogMemory MCP — Scope & path resolution

import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

export type Scope = "workspace" | "global";

export interface Config {
  scope: Scope;
  dbPath: string;
  workspaceRoot: string;
}

interface ConfigFile {
  scope?: Scope;
  disable_update_check?: boolean;
}

/**
 * Resolve the CogMemory configuration following priority order:
 * 1. `.cogmemory/config.json` in workspace root → `"scope": "workspace" | "global"`
 * 2. Environment variable `COGMEMORY_SCOPE`
 * 3. Default: `workspace`
 */
export function resolveConfig(workspaceRoot: string): Config {
  // 1. Check .cogmemory/config.json
  const configPath = join(workspaceRoot, ".cogmemory", "config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed: ConfigFile = JSON.parse(raw);
      if (parsed.scope === "global") {
        return buildGlobalConfig();
      }
      if (parsed.scope === "workspace") {
        return buildWorkspaceConfig(workspaceRoot);
      }
    } catch {
      // Config file is malformed — fall through to next priority
    }
  }

  // 2. Environment variable
  const envScope = process.env.COGMEMORY_SCOPE;
  if (envScope === "global") {
    return buildGlobalConfig();
  }

  // 3. Default: workspace
  return buildWorkspaceConfig(workspaceRoot);
}

function buildWorkspaceConfig(workspaceRoot: string): Config {
  const dir = join(workspaceRoot, ".cogmemory");
  mkdirSync(dir, { recursive: true });
  return {
    scope: "workspace",
    dbPath: join(dir, "memory.db"),
    workspaceRoot,
  };
}

function buildGlobalConfig(): Config {
  const dir = join(homedir(), ".cogmemory");
  mkdirSync(dir, { recursive: true });
  return {
    scope: "global",
    dbPath: join(dir, "global.db"),
    workspaceRoot: homedir(),
  };
}

// ─── Workspace root helpers ───────────────────────────────

/**
 * Walk up from a starting directory looking for `.cogmemory/`.
 * Returns the directory containing it, or null if not found.
 */
function findCogmemoryDir(start: string): string | null {
  let current = resolve(start);
  const fsRoot = dirname(current);
  while (current !== fsRoot) {
    const candidate = join(current, ".cogmemory");
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return current;
      }
    } catch {
      // Continue searching upward
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Try to resolve and validate a path. Returns it if it exists, null otherwise.
 */
function tryPath(path: string, label: string): string | null {
  const resolved = resolve(path);
  if (existsSync(resolved)) return resolved;
  console.error(
    `Warning: ${label} path does not exist: ${resolved}, falling back`,
  );
  return null;
}

/**
 * Determine the workspace root using the following priority:
 * 1. `--workspace <path>` CLI argument
 * 2. `COGMEMORY_WORKSPACE` environment variable
 * 3. Walk up from CWD looking for a `.cogmemory/` directory
 * 4. Fall back to CWD
 */
export function resolveWorkspaceRoot(argv: string[]): string {
  const argIdx = argv.indexOf("--workspace");
  if (argIdx !== -1 && argv[argIdx + 1]) {
    const r = tryPath(argv[argIdx + 1], "--workspace");
    if (r) return r;
  }

  if (process.env.COGMEMORY_WORKSPACE) {
    const r = tryPath(process.env.COGMEMORY_WORKSPACE, "COGMEMORY_WORKSPACE");
    if (r) return r;
  }

  return findCogmemoryDir(".") ?? resolve(".");
}
