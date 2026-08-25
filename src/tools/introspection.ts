// CogMemory MCP — Introspection tools: cogmemory_status, check_for_updates

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { wrapHandler, jsonOk, jsonErr } from "./utils.js";
import { VERSION } from "../version.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Constants ──────────────────────────────────────────

const NPM_REGISTRY_URL =
  "https://registry.npmjs.org/cogmemory-mcp/latest";

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
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of TABLE_NAMES) {
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as cnt FROM ${table}`)
        .get() as { cnt: number };
      counts[table] = row.cnt;
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
): { coveragePct: number; lastIndexedAt: string | null } {
  try {
    const indexed = (
      db.prepare("SELECT COUNT(*) as cnt FROM file_index").get() as {
        cnt: number;
      }
    ).cnt;
    const symbols = (
      db.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as {
        cnt: number;
      }
    ).cnt;
    const lastIdx = db
      .prepare("SELECT indexed_at FROM file_index ORDER BY indexed_at DESC LIMIT 1")
      .get() as { indexed_at: string } | undefined;

    const coveragePct = indexed > 0 ? 100 : 0; // Full coverage if any files indexed
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
      const schemaVersion = db.pragma("user_version", {
        simple: true,
      }) as number;

      const dbPath = db.name;
      const scope: string =
        dbPath.includes("global.db") ? "global" : "workspace";

      const { coveragePct, lastIndexedAt } = computeIndexCoverage(db);
      const symbolCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as {
          cnt: number;
        }
      ).cnt;
      const edgeCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM edges").get() as {
          cnt: number;
        }
      ).cnt;

      const result: Record<string, unknown> = {
        package_version: VERSION,
        schema_version: schemaVersion,
        workspace_root: workspaceRoot,
        db_path: dbPath,
        scope,
        node_version: process.version,
        update_check_enabled: !isUpdateCheckDisabled(workspaceRoot),
        index: {
          total_symbols: symbolCount,
          total_edges: edgeCount,
          coverage_pct: coveragePct,
          last_indexed_at: lastIndexedAt,
        },
      };

      if (verbose) {
        result.counts = getTableCounts(db);
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
          .prepare("SELECT value FROM context WHERE key = ?")
          .get(CACHE_KEY) as { value: string } | undefined;

        if (cached) {
          const parsed = JSON.parse(cached.value);
          const age = Date.now() - parsed.timestamp;
          if (age < CACHE_TTL_MS) {
            const updateAvailable = compareVersions(
              parsed.latest,
              VERSION,
            );
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
            `INSERT INTO context (key, value, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          ).run(
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
          message: "Could not reach npm registry. Check your network connection.",
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