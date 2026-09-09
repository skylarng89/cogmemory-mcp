// CogMemory MCP — Introspection tools: cogmemory_status, check_for_updates

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler, jsonOk, projectPredicate } from "./utils.js";
import { VERSION } from "../version.js";
import type { ResolutionSource } from "../config.js";
import type { ActiveProjectRef } from "../active-project.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Constants ──────────────────────────────────────────

const NPM_REGISTRY_URL = "https://registry.npmjs.org/cogmemory-mcp/latest";

const CACHE_KEY = "npm_latest_version_cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Helper: check if update check is disabled ──────────

function isUpdateCheckDisabled(workspaceRoot: string): boolean {
  // Env var override
  if (process.env.COGMEMORY_DISABLE_UPDATE_CHECK === "1") {
    return true;
  }
  // Config file override
  const configPath = join(workspaceRoot, ".cogmemory", "config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.disable_update_check === true) {
        return true;
      }
    } catch {
      // Malformed config — not disabled
    }
  }
  return false;
}

// ─── Helper: get table counts ───────────────────────────

const TABLE_NAMES = [
  "sessions",
  "decisions",
  "conventions",
  "errors",
  "context",
  "changelog",
  "plan",
  "tasks",
  "entities",
  "relations",
  "observations",
  "specs",
  "symbols",
  "edges",
  "execution_traces",
  "codemap_annotations",
  "file_index",
  "recall_docs",
  "kg_docs",
  "index_errors",
  "symbol_tokens",
  "symbol_minhash",
  "symbol_embeddings",
];

function getTableCounts(
  db: Database.Database,
  projectId?: number,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of TABLE_NAMES) {
    try {
      if (projectId !== undefined) {
        // Project-scoped count; tables without a project_id column report -1
        const cols = db.pragma(`table_info(${table})`) as Array<{
          name: string;
        }>;
        const hasProject = cols.some((c) => c.name === "project_id");
        if (!hasProject) {
          counts[table] = -1;
          continue;
        }
        const row = db
          .prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE project_id = ?`)
          .get(projectId) as { cnt: number };
        counts[table] = row.cnt;
      } else {
        const row = db
          .prepare(`SELECT COUNT(*) as cnt FROM ${table}`)
          .get() as { cnt: number };
        counts[table] = row.cnt;
      }
    } catch {
      // Table may not exist if migration hasn't run yet
      counts[table] = -1;
    }
  }
  return counts;
}

// ─── Helper: compute index coverage ─────────────────────

function computeIndexCoverage(
  db: Database.Database,
  projectId?: number,
): { coveragePct: number; lastIndexedAt: string | null } {
  try {
    const symbols = (
      projectId !== undefined
        ? (db
            .prepare("SELECT COUNT(*) as cnt FROM symbols WHERE project_id = ?")
            .get(projectId) as { cnt: number })
        : (db.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as {
            cnt: number;
          })
    ).cnt;
    const lastIdx = (
      projectId !== undefined
        ? db
            .prepare(
              "SELECT indexed_at FROM file_index WHERE project_id = ? ORDER BY indexed_at DESC LIMIT 1",
            )
            .get(projectId)
        : db
            .prepare(
              "SELECT indexed_at FROM file_index ORDER BY indexed_at DESC LIMIT 1",
            )
            .get()
    ) as { indexed_at: string } | undefined;

    return {
      coveragePct: symbols > 0 ? 100 : 0,
      lastIndexedAt: lastIdx?.indexed_at ?? null,
    };
  } catch {
    return { coveragePct: 0, lastIndexedAt: null };
  }
}

// ─── Tool Registration ──────────────────────────────────

export function registerIntrospectionTools(
  server: McpServer,
  db: Database.Database,
  workspaceRoot: string,
  activeProject: ActiveProjectRef,
  resolutionSource: ResolutionSource,
): void {
  // ── cogmemory_status ──
  server.registerTool(
    "cogmemory_status",
    {
      description:
        "Show runtime configuration: package version, schema version, db path, workspace root, scope, index coverage, and subsystem counts. Use this to understand the current state of CogMemory.",
      inputSchema: z.object({
        verbose: z
          .boolean()
          .optional()
          .describe("Include per-subsystem row counts (default: false)"),
      }),
    },
    wrapHandler("cogmemory_status", async ({ verbose }) => {
      const projectId = activeProject.get();
      const rootPathHint =
        (
          db
            .prepare("SELECT root_path_hint FROM projects WHERE id = ?")
            .get(projectId) as { root_path_hint: string | null } | undefined
        )?.root_path_hint ?? null;
      const schemaVersion = db.pragma("user_version", {
        simple: true,
      }) as number;

      const dbPath = db.name;
      const scope: string = dbPath.includes("global.db")
        ? "global"
        : "workspace";

      const { coveragePct, lastIndexedAt } = computeIndexCoverage(
        db,
        projectId,
      );
      const symbolCount = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM symbols WHERE ${projectPredicate()}`,
          )
          .get(projectId) as { cnt: number }
      ).cnt;
      const edgeCount = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM edges WHERE ${projectPredicate()}`,
          )
          .get(projectId) as { cnt: number }
      ).cnt;

      const result: Record<string, unknown> = {
        package_version: VERSION,
        schema_version: schemaVersion,
        workspace_root: workspaceRoot,
        root_path_hint: rootPathHint,
        resolution_source: resolutionSource,
        db_path: dbPath,
        scope,
        node_version: process.version,
        update_check_enabled: !isUpdateCheckDisabled(workspaceRoot),
        active_project: {
          id: projectId,
          slug: (
            db
              .prepare("SELECT slug FROM projects WHERE id = ?")
              .get(projectId) as { slug: string } | undefined
          )?.slug,
          label: (
            db
              .prepare("SELECT label FROM projects WHERE id = ?")
              .get(projectId) as { label: string | null } | undefined
          )?.label,
        },
        index: {
          total_symbols: symbolCount,
          total_edges: edgeCount,
          coverage_pct: coveragePct,
          last_indexed_at: lastIndexedAt,
        },
      };

      if (verbose) {
        result.counts = getTableCounts(db, projectId);
      }

      return jsonOk(result);
    }),
  );

  // ── check_for_updates ──
  server.registerTool(
    "check_for_updates",
    {
      description:
        "Check if a newer version of cogmemory-mcp is available on npm. Makes a read-only HTTPS GET to registry.npmjs.org (cached 24h). Disable with COGMEMORY_DISABLE_UPDATE_CHECK=1 or config.json disable_update_check=true.",
      inputSchema: z.object({}),
    },
    wrapHandler("check_for_updates", async () => {
      if (isUpdateCheckDisabled(workspaceRoot)) {
        return jsonOk({
          current_version: VERSION,
          latest_version: null,
          update_available: null,
          disabled: true,
          message: "Update check is disabled via config or env var",
        });
      }

      // Check cache
      try {
        const cached = db
          .prepare("SELECT value FROM context WHERE key = ? AND project_id = ?")
          .get(CACHE_KEY, activeProject.get()) as { value: string } | undefined;

        if (cached) {
          const parsed = JSON.parse(cached.value);
          const age = Date.now() - parsed.timestamp;
          if (age < CACHE_TTL_MS) {
            const updateAvailable = compareVersions(parsed.latest, VERSION);
            return jsonOk({
              current_version: VERSION,
              latest_version: parsed.latest,
              update_available: updateAvailable,
              cached: true,
              cache_age_hours: Math.round(age / 3600000),
            });
          }
        }
      } catch {
        // Cache read failure — fetch fresh
      }

      // Fetch from npm registry
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const resp = await fetch(NPM_REGISTRY_URL, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          return jsonOk({
            current_version: VERSION,
            latest_version: null,
            update_available: null,
            error: `registry responded ${resp.status}`,
          });
        }

        const data = (await resp.json()) as { version: string };
        const latest = data.version;
        const updateAvailable = compareVersions(latest, VERSION);

        // Cache the result
        try {
          db.prepare(
            `INSERT INTO context (project_id, key, value, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          ).run(
            activeProject.get(),
            CACHE_KEY,
            JSON.stringify({ latest, timestamp: Date.now() }),
          );
        } catch {
          // Cache write failure — non-fatal
        }

        return jsonOk({
          current_version: VERSION,
          latest_version: latest,
          update_available: updateAvailable,
          instructions: updateAvailable
            ? `Run: npm update -g cogmemory-mcp  (or: npx cogmemory-mcp@latest)`
            : "You are running the latest version.",
        });
      } catch (err) {
        return jsonOk({
          current_version: VERSION,
          latest_version: null,
          update_available: null,
          error: err instanceof Error ? err.message : "network error",
          message:
            "Could not reach npm registry. Check your network connection.",
        });
      }
    }),
  );
}

// ─── Version comparison ─────────────────────────────────

/**
 * Compare two semver strings. Returns true if `remote` is newer than `local`.
 */
function compareVersions(remote: string, local: string): boolean {
  const remoteParts = remote.split(".").map(Number);
  const localParts = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const r = remoteParts[i] ?? 0;
    const l = localParts[i] ?? 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}
