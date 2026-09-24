// CogMemory MCP — Consistent, per-call project state.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./file-lock.js";
import type Database from "better-sqlite3";
import { resolveConfig, resolveProjectIdentity, readProjectBinding, validateWorkspaceRoot } from "./config.js";
import type { Config, ProjectIdentity, ResolutionSource } from "./config.js";
import { openDatabase, closeDatabase } from "./db/connection.js";

export interface ProjectContext extends Config, ProjectIdentity {
  db: Database.Database;
  resolutionSource: ResolutionSource;
  binding: string;
}

export class ProjectRuntime {
  private active!: ProjectContext;
  private readonly leases = new Map<Database.Database, number>();

  constructor(root: string, source: ResolutionSource = "override", private readonly dataDir?: string) {
    this.switchTo(root, source);
  }

  get current(): ProjectContext { return this.active; }

  /** Publish the entire target context only after it has opened successfully. */
  switchTo(root: string, source: ResolutionSource = "runtime-switch"): ProjectContext {
    const workspaceRoot = validateWorkspaceRoot(root);
    mkdirSync(join(workspaceRoot, ".cogmemory"), { recursive: true });
    return withFileLock(join(workspaceRoot, ".cogmemory", "runtime.lock"), () => {
      const config = resolveConfig(workspaceRoot, this.dataDir);
      const db = this.active?.dbPath === config.dbPath ? this.active.db : openDatabase(config.dbPath);
      let next: ProjectContext;
      try {
        const project = resolveProjectIdentity(workspaceRoot, db, config.scope);
        next = { ...config, ...project, db, resolutionSource: source, binding: readProjectBinding(workspaceRoot) };
      } catch (error) {
        if (db !== this.active?.db && !this.leases.has(db)) closeDatabase(db);
        throw error;
      }
      const previous = this.active;
      this.active = next;
      if (previous && previous.db !== db && !this.leases.has(previous.db)) closeDatabase(previous.db);
      return this.active;
    });
  }

  /** In-flight asynchronous work retains its original database until completion. */
  async run<T>(name: string, work: (context: ProjectContext) => Promise<T>): Promise<T> {
    if (name !== "switch_project" && name !== "cogmemory_status") {
      if (readProjectBinding(this.active.workspaceRoot) !== this.active.binding) {
        this.switchTo(this.active.workspaceRoot);
      }
    }
    const snapshot = this.active;
    this.leases.set(snapshot.db, (this.leases.get(snapshot.db) ?? 0) + 1);
    try { return await work(snapshot); }
    finally {
      const remaining = this.leases.get(snapshot.db)! - 1;
      if (remaining) this.leases.set(snapshot.db, remaining);
      else {
        this.leases.delete(snapshot.db);
        if (snapshot.db !== this.active.db) closeDatabase(snapshot.db);
      }
    }
  }
}
