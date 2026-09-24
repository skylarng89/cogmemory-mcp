// CogMemory MCP — Scope & path resolution

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  renameSync,
  readdirSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { withFileLock } from "./file-lock.js";

export type Scope = "workspace" | "global" | "project";

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
  /** Existing database filename UUID, when recovering pre-fix identity drift. */
  project_database_id?: string;
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
 * 1. `.cogmemory/config.json` in workspace root → `"scope": "workspace" | "global" | "project"`
 * 2. Environment variable `COGMEMORY_SCOPE`
 * 3. User-level `~/.cogmemory/config.json` (scope/settings fallback)
 * 4. Default: `project` (one database per clone under ~/.cogmemory/projects/)
 */
export function resolveConfig(workspaceRoot: string, dataDir = join(homedir(), ".cogmemory")): Config {
  workspaceRoot = validateWorkspaceRoot(workspaceRoot);
  const local = readConfigFile(workspaceRoot);
  if (local.scope === "global") return buildGlobalConfig(workspaceRoot, dataDir);
  if (local.scope === "workspace") return buildWorkspaceConfig(workspaceRoot);
  if (local.scope === "project") return buildProjectConfig(workspaceRoot, dataDir);

  // 2. Environment variable
  const envScope = process.env.COGMEMORY_SCOPE;
  if (envScope === "global") {
    return buildGlobalConfig(workspaceRoot, dataDir);
  }
  if (envScope === "workspace") {
    return buildWorkspaceConfig(workspaceRoot);
  }
  if (envScope === "project") {
    return buildProjectConfig(workspaceRoot, dataDir);
  }

  // 3. User-level fallback: ~/.cogmemory/config.json acts as a global
  //    settings file (scope only — never project identity, per ADR-8).
  const userConfigPath = join(dataDir, "config.json");
  if (existsSync(userConfigPath)) {
    let settings: ConfigFile;
    try {
      settings = JSON.parse(readFileSync(userConfigPath, "utf-8"));
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("expected object");
      if (settings.scope !== undefined && !["workspace", "project", "global"].includes(settings.scope)) throw new Error("invalid scope");
    } catch (error) {
      throw new Error(`PROJECT_CONFIG_INVALID: ${userConfigPath}: ${error instanceof Error ? error.message : error}. Restore valid scope settings before opening memory.`);
    }
    // Do not catch builder errors and silently fall back to another scope.
    if (settings.scope === "workspace") return buildWorkspaceConfig(workspaceRoot);
    if (settings.scope === "project") return buildProjectConfig(workspaceRoot, dataDir);
    if (settings.scope === "global") return buildGlobalConfig(workspaceRoot, dataDir);
  }

  // 4. Default: one database per clone under ~/.cogmemory/projects/.
  // Advisory for upgraders: if this workspace has an existing pre-default
  // workspace DB, point it out so the scope switch isn't silent.
  const legacyWsDb = join(workspaceRoot, ".cogmemory", "memory.db");
  if (existsSync(legacyWsDb)) {
    console.error(
      `[cogmemory] Defaulting to project scope; this workspace has an existing legacy DB at ${legacyWsDb}. Add {"scope": "workspace"} to ${join(workspaceRoot, ".cogmemory", "config.json")} to keep using it.`,
    );
  }
  return buildProjectConfig(workspaceRoot, dataDir);
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

/**
 * Global scope shares one DB (~/.cogmemory/global.db) across all projects,
 * but project identity is still anchored to the discovered workspace root —
 * NOT to the home directory (ADR-8). This keeps ~/.cogmemory/config.json a
 * pure scope/settings file and prevents one stale slug from being reused as
 * the identity for every project the user opens.
 */
function buildGlobalConfig(workspaceRoot: string, dir: string): Config {
  mkdirSync(dir, { recursive: true });
  return {
    scope: "global",
    dbPath: join(dir, "global.db"),
    workspaceRoot,
  };
}

/**
 * Store each clone in its own user-level database while keeping the project
 * identity in the clone's ignored .cogmemory/config.json. The UUID is used in
 * the filename so the path remains stable when the project is renamed or
 * moved, and no untrusted project label can become part of a filesystem path.
 */
function buildProjectConfig(workspaceRoot: string, dataDir: string): Config {
  const dir = join(dataDir, "projects");
  mkdirSync(dir, { recursive: true });
  return withWorkspaceLock(workspaceRoot, () => {
    const config = readConfigFile(workspaceRoot);
    let slug = config.project_id;
    const explicit = config.project_database_id;
    const candidates: Array<{ databaseId: string; slug: string }> = [];
    for (const entry of readdirSync(dir)) {
      const match = /^memory-([0-9a-f-]+)\.db$/i.exec(entry);
      if (!match || !PROJECT_ID_PATTERN.test(match[1])) continue;
      if (explicit && match[1] !== explicit) continue;
      let candidate: Database.Database | undefined;
      try {
        candidate = new Database(join(dir, entry), { readonly: true, fileMustExist: true });
        const rows = candidate.prepare(
          "SELECT slug, root_path_hint FROM projects WHERE slug != 'legacy-unassigned'",
        ).all() as Array<{ slug: string; root_path_hint: string | null }>;
        if (match[1] === (explicit ?? slug) && rows.length &&
            !rows.some(row => row.slug === slug || (!explicit && row.root_path_hint === workspaceRoot))) {
          throw new Error(`PROJECT_IDENTITY_MISMATCH: selected database ${entry} contains different identities: ${JSON.stringify(rows)}. Restore the intended project_id/project_database_id pair; no memories were changed.`);
        }
        for (const row of rows) {
          if (row.slug === slug || (!explicit && row.root_path_hint === workspaceRoot)) {
            candidates.push({ databaseId: match[1], slug: row.slug });
          }
        }
      } catch (error) {
        // Never silently replace the selected database when it cannot be inspected.
        if (match[1] === (explicit ?? slug)) throw error;
      } finally {
        candidate?.close();
      }
    }
    if (candidates.length > 1) {
      throw new Error(
        `PROJECT_IDENTITY_AMBIGUOUS: multiple memory stores match ${workspaceRoot}: ` +
        JSON.stringify(candidates) + ". Select project_database_id and project_id in .cogmemory/config.json from the intended candidate; all databases are preserved.",
      );
    }
    const recovered = candidates[0];
    if (explicit && (!recovered || recovered.slug !== slug)) {
      throw new Error("PROJECT_IDENTITY_MISMATCH: project_database_id must select an existing database containing project_id. Existing memories were not changed.");
    }
    if (recovered) {
      slug = recovered.slug;
      const next = { ...config, project_id: slug, project_database_id: recovered.databaseId };
      if (config.project_id !== slug || config.project_database_id !== recovered.databaseId) {
        writeConfigFile(workspaceRoot, next);
      }
      return { scope: "project", dbPath: join(dir, `memory-${recovered.databaseId}.db`), workspaceRoot };
    }
    slug ??= randomUUID();
    if (config.project_id !== slug) writeConfigFile(workspaceRoot, { ...config, project_id: slug });
    return { scope: "project", dbPath: join(dir, `memory-${slug}.db`), workspaceRoot };
  });
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
 * Walk up from a starting directory looking for a `.git/` entry (file or
 * directory — covers worktrees/submodules where .git is a file).
 * Returns the directory containing it, or null if not found.
 */
function findGitRoot(start: string): string | null {
  let current = resolve(start);
  const fsRoot = dirname(current);
  while (current !== fsRoot) {
    const candidate = join(current, ".git");
    try {
      if (existsSync(candidate)) {
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
export function validateWorkspaceRoot(path: string): string {
  const root = realpathSync(resolve(path));
  if (!statSync(root).isDirectory() || root === realpathSync(homedir()) || dirname(root) === root) {
    throw new Error(`Invalid project workspace: ${path}. Use an existing project directory, not home or filesystem root.`);
  }
  return root;
}

export type ResolutionSource =
  | "override"
  | "git-root"
  | "dotcogmemory"
  | "cwd-fallback"
  | "runtime-switch";

export interface WorkspaceResolution {
  root: string;
  source: ResolutionSource;
}

/**
 * Determine the workspace root using the following priority:
 * 1. `--workspace <path>` CLI argument (explicit override)
 * 2. `COGMEMORY_WORKSPACE` environment variable (explicit override)
 * 3. Walk up from CWD looking for a `.git/` entry (git-root discovery, ADR-7)
 * 4. Walk up from CWD looking for a `.cogmemory/` directory
 * 5. Fall back to CWD
 */
export function resolveWorkspaceRoot(argv: string[]): WorkspaceResolution {
  const argIdx = argv.indexOf("--workspace");
  if (argIdx !== -1) {
    if (!argv[argIdx + 1]) throw new Error("--workspace requires a project directory");
    return { root: validateWorkspaceRoot(argv[argIdx + 1]), source: "override" };
  }

  if (process.env.COGMEMORY_WORKSPACE) {
    return { root: validateWorkspaceRoot(process.env.COGMEMORY_WORKSPACE), source: "override" };
  }

  const gitRoot = findGitRoot(".");
  if (gitRoot) return { root: gitRoot, source: "git-root" };

  const cogDir = findCogmemoryDir(".");
  if (cogDir) return { root: cogDir, source: "dotcogmemory" };

  const fallbackRoot = resolve(".");
  const userHome = resolve(homedir());
  const filesystemRoot = dirname(fallbackRoot) === fallbackRoot;
  if (fallbackRoot === userHome || filesystemRoot) {
    throw new Error(
      `[cogmemory] Refusing to create project memory from unsafe fallback directory "${fallbackRoot}". ` +
        "Open a project workspace, set --workspace, or set COGMEMORY_WORKSPACE to its literal absolute path.",
    );
  }

  return { root: fallbackRoot, source: "cwd-fallback" };
}

// ─── Project identity resolution ──────────────────────────

function configFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".cogmemory", "config.json");
}

const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readProjectBinding(workspaceRoot: string): string {
  const config = readConfigFile(workspaceRoot);
  return JSON.stringify([config.project_id, config.project_database_id, config.scope]);
}

function readConfigFile(workspaceRoot: string): ConfigFile {
  const path = configFilePath(workspaceRoot);
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let config: ConfigFile;
  try {
    config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("expected object");
    for (const key of ["project_id", "project_database_id"] as const) {
      if (config[key] !== undefined && (typeof config[key] !== "string" || !PROJECT_ID_PATTERN.test(config[key]!))) {
        throw new Error(`invalid ${key}`);
      }
    }
    if (config.scope !== undefined && !["project", "workspace", "global"].includes(config.scope)) throw new Error("invalid scope");
  } catch (error) {
    throw new Error(`PROJECT_CONFIG_INVALID: ${path}: ${error instanceof Error ? error.message : error}. Restore the valid config/UUID; existing memory and config are preserved.`);
  }
  return config;
}

function withWorkspaceLock<T>(root: string, work: () => T): T {
  mkdirSync(join(root, ".cogmemory"), { recursive: true });
  return withFileLock(join(root, ".cogmemory", "identity.lock"), work);
}

function writeConfigFile(root: string, config: ConfigFile): void {
  const path = configFilePath(root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Keep the persisted UUID authoritative; serialize bootstrap across MCP processes. */
export function resolveProjectIdentity(
  workspaceRoot: string,
  db: Database.Database,
  scope: Scope,
): ProjectIdentity {
  return withWorkspaceLock(workspaceRoot, () => {
    const config = readConfigFile(workspaceRoot);
    const rows = db.prepare("SELECT id, slug, label, root_path_hint FROM projects WHERE slug != 'legacy-unassigned'")
      .all() as Array<{ id: number; slug: string; label: string | null; root_path_hint?: string }>;
    // Recover a lost config only from unambiguous stored identity evidence.
    const prior = scope === "workspace" ? rows : rows.filter(row => row.root_path_hint === workspaceRoot);
    if (!config.project_id && prior.length > 1) {
      throw new Error(`PROJECT_IDENTITY_AMBIGUOUS: multiple identities exist for ${workspaceRoot}: ${JSON.stringify(prior.map(row => ({ slug: row.slug, id: row.id })))}. Restore project_id in .cogmemory/config.json; no memories were changed.`);
    }
    const slug = config.project_id ?? (prior.length === 1 ? prior[0].slug : randomUUID());
    if (scope === "workspace" && rows.length && !rows.some(row => row.slug === slug)) {
      throw new Error("PROJECT_IDENTITY_MISMATCH: workspace database contains a different project. Restore project_id from its projects table; no data was changed.");
    }
    const label = basename(workspaceRoot) || "workspace";
    const result = db.transaction(() => {
      let row = db.prepare("SELECT id, slug, label FROM projects WHERE slug = ?").get(slug) as typeof rows[number] | undefined;
      let isNewProject = false;
      if (!row && scope === "workspace" && rows.length === 0) {
        db.prepare("UPDATE projects SET slug = ?, label = ? WHERE slug = 'legacy-unassigned'").run(slug, label);
        row = db.prepare("SELECT id, slug, label FROM projects WHERE slug = ?").get(slug) as typeof row;
      }
      if (!row) {
        db.prepare("INSERT INTO projects (slug, label, root_path_hint) VALUES (?, ?, ?) ON CONFLICT(slug) DO NOTHING")
          .run(slug, label, workspaceRoot);
        row = db.prepare("SELECT id, slug, label FROM projects WHERE slug = ?").get(slug) as typeof rows[number];
        isNewProject = true;
      }
      db.prepare("UPDATE projects SET last_seen_at = datetime('now'), root_path_hint = ? WHERE id = ?")
        .run(workspaceRoot, row.id);
      return { projectId: row.id, slug, label: row.label ?? label, isNewProject };
    }).immediate();
    if (config.project_id !== slug) writeConfigFile(workspaceRoot, { ...config, project_id: slug });
    return result;
  });
}
