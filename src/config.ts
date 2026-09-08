// CogMemory MCP — Scope & path resolution

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type Scope = "workspace" | "global";

export interface Config {
  scope: Scope;
  dbPath: string;
  workspaceRoot: string;
}

interface ConfigFile {
  scope?: Scope;
  disable_update_check?: boolean;
  /** Opaque UUID slug identifying this project — the primary identity key. */
  project_id?: string;
}

export interface ProjectIdentity {
  /** Numeric FK into the projects table. */
  projectId: number;
  /** Opaque slug persisted in .cogmemory/config.json. */
  slug: string;
  /** Display label (defaults to folder basename; never used for identity). */
  label: string;
  /** True when a new project row was created during this boot. */
  isNewProject: boolean;
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

// ─── Project identity resolution ──────────────────────────

function configFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".cogmemory", "config.json");
}

function readConfigFile(workspaceRoot: string): ConfigFile {
  const path = configFilePath(workspaceRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConfigFile;
  } catch {
    console.error(
      "Warning: .cogmemory/config.json is malformed — regenerating project identity",
    );
    return {};
  }
}

/**
 * Persist the slug into .cogmemory/config.json using an exclusive create
 * (flag: "wx") so two processes racing on first-run converge on one slug:
 * the loser re-reads the winner's file and adopts its slug (ADR-6).
 */
function persistSlug(workspaceRoot: string, slug: string): void {
  const dir = join(workspaceRoot, ".cogmemory");
  mkdirSync(dir, { recursive: true });
  const path = configFilePath(workspaceRoot);

  const existing = readConfigFile(workspaceRoot);
  const merged: ConfigFile = { ...existing, project_id: slug };
  const body = JSON.stringify(merged, null, 2) + "\n";

  // Fast path: file already exists and already has our slug — just rewrite it.
  if (existsSync(path)) {
    try {
      writeFileSync(path, body, "utf-8");
      return;
    } catch {
      // Fall through to exclusive-create path below
    }
  }

  try {
    // Exclusive create wins the race if the file does not exist yet.
    writeFileSync(path, body, { flag: "wx", encoding: "utf-8" });
    console.error(
      "[cogmemory] Created .cogmemory/config.json — consider adding '.cogmemory/' to .gitignore " +
        "so each clone gets its own project identity (commit it only for intentional team-shared memory).",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process created it first — adopt their slug.
      const winner = readConfigFile(workspaceRoot);
      if (winner.project_id && winner.project_id !== slug) {
        console.error(
          `[cogmemory] Concurrent bootstrap detected — adopting existing project slug ${winner.project_id}`,
        );
      }
      return;
    }
    throw err;
  }
}

/**
 * Resolve the active project identity once per server process (ADR-3).
 *
 * Priority:
 * 1. `project_id` slug in `.cogmemory/config.json` → look up in projects table
 * 2. Workspace-scope DB with the synthesized 'legacy-unassigned' row → adopt it
 *    (this is a pre-migration workspace DB; it belongs to this project)
 * 3. Global-scope DB → bootstrap a fresh project row (legacy rows stay in
 *    the 'legacy-unassigned' bucket)
 * 4. Otherwise → generate a new UUID slug, insert a projects row, persist it
 */
export function resolveProjectIdentity(
  workspaceRoot: string,
  db: Database.Database,
  scope: Scope,
): ProjectIdentity {
  const label = basename(workspaceRoot) || "workspace";
  const rootHint = resolve(workspaceRoot);

  const ensureProjectsTable = () => {
    // Guard for DBs opened before migration 008 ran (should not normally
    // happen since migrations run at open, but keeps this defensive).
    const cols = db.pragma("table_info(projects)") as Array<{ name: string }>;
    if (cols.length === 0) {
      throw new Error(
        "projects table missing — schema migration 008 did not run",
      );
    }
  };

  ensureProjectsTable();

  const findBySlug = db.prepare("SELECT * FROM projects WHERE slug = ?");
  const touchStmt = db.prepare(
    "UPDATE projects SET last_seen_at = datetime('now'), root_path_hint = ? WHERE id = ?",
  );

  const adopt = (
    row: { id: number; slug: string; label: string | null },
    isNewProject: boolean,
  ): ProjectIdentity => {
    touchStmt.run(rootHint, row.id);
    return {
      projectId: row.id,
      slug: row.slug,
      label: row.label ?? label,
      isNewProject,
    };
  };

  const existingSlug = readConfigFile(workspaceRoot).project_id;
  if (existingSlug) {
    const row = findBySlug.get(existingSlug) as
      | { id: number; slug: string; label: string | null }
      | undefined;
    if (row) {
      return adopt(row, false);
    }
    console.error(
      `[cogmemory] Slug ${existingSlug} from config.json not found in projects table — re-bootstrapping`,
    );
  }

  // Workspace-scope DB: adopt the synthesized legacy row if it is still the
  // only project — this preserves continuity for pre-migration workspaces.
  if (scope === "workspace") {
    const legacy = findBySlug.get("legacy-unassigned") as
      | { id: number; slug: string; label: string | null }
      | undefined;
    const projectCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM projects").get() as {
        cnt: number;
      }
    ).cnt;
    if (legacy && projectCount === 1) {
      const slug = randomUUID();
      db.prepare(
        "UPDATE projects SET slug = ?, label = ?, root_path_hint = ?, last_seen_at = datetime('now') WHERE id = ?",
      ).run(slug, label, rootHint, legacy.id);
      persistSlug(workspaceRoot, slug);
      return {
        projectId: legacy.id,
        slug,
        label,
        isNewProject: false,
      };
    }
  }

  // Fresh project (or global scope): create a new slug.
  const slug = randomUUID();
  const result = db
    .prepare(
      "INSERT INTO projects (slug, label, root_path_hint) VALUES (?, ?, ?)",
    )
    .run(slug, label, rootHint);
  persistSlug(workspaceRoot, slug);
  return {
    projectId: result.lastInsertRowid as number,
    slug,
    label,
    isNewProject: true,
  };
}
