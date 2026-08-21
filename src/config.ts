// CogMemory MCP — Scope & path resolution

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export type Scope = "workspace" | "global";

export interface Config {
  scope: Scope;
  dbPath: string;
}

interface ConfigFile {
  scope?: Scope;
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
  };
}

function buildGlobalConfig(): Config {
  const dir = join(homedir(), ".cogmemory");
  mkdirSync(dir, { recursive: true });
  return {
    scope: "global",
    dbPath: join(dir, "global.db"),
  };
}

/**
 * Determine the workspace root from argv or CWD.
 * Looks for a directory containing `.cogmemory/` or falls back to CWD.
 */
export function resolveWorkspaceRoot(argv: string[]): string {
  // Check if a workspace root was passed as an argument
  const argIndex = argv.indexOf("--workspace");
  if (argIndex !== -1 && argv[argIndex + 1]) {
    return resolve(argv[argIndex + 1]);
  }

  // Use COGMEMORY_WORKSPACE env var if set
  const envWorkspace = process.env.COGMEMORY_WORKSPACE;
  if (envWorkspace) {
    return resolve(envWorkspace);
  }

  // Default to CWD
  return resolve(".");
}
