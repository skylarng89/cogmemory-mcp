// CogMemory MCP — Startup update notifier (fail-safe)
//
// Lightweight, non-blocking check for a newer published version using the
// `update-notifier` package. Design constraints:
//
// - MUST never crash the server: the dynamic import and all I/O are wrapped
//   so a missing/failed dependency is silently ignored.
// - Output goes to stderr only (the stdio transport owns stdout for MCP).
// - Honors the same disable switches as the `check_for_updates` tool:
//   `COGMEMORY_DISABLE_UPDATE_CHECK=1` env var and
//   `disable_update_check: true` in .cogmemory/config.json.
// - `update-notifier` caches its own check result in the OS cache dir and
//   only pings the npm registry once per interval (24h), so startup cost is
//   negligible after the first run.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How often to hit the npm registry (24 hours). */
const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24;

interface NotifierPkg {
  name: string;
  version: string;
}

/**
 * Check whether the update check is disabled via env var or config file.
 * Mirrors the logic in tools/introspection.ts (kept in sync intentionally —
 * both surfaces must respect the same switches).
 */
export function isUpdateCheckDisabled(workspaceRoot: string): boolean {
  if (process.env.COGMEMORY_DISABLE_UPDATE_CHECK === "1") {
    return true;
  }
  const configPath = join(workspaceRoot, ".cogmemory", "config.json");
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
        disable_update_check?: boolean;
      };
      if (parsed.disable_update_check === true) {
        return true;
      }
    } catch {
      // Malformed config — not disabled
    }
  }
  return false;
}

/**
 * Fire-and-forget update notification. Called once at server startup,
 * before the MCP handshake. Never throws.
 */
export function runStartupUpdateCheck(workspaceRoot: string): void {
  try {
    if (isUpdateCheckDisabled(workspaceRoot)) {
      return;
    }

    // Read package.json relative to the compiled module location. Works both
    // when running from src/ via tsx (src/update-check.js → ../package.json)
    // and from dist/ after tsc (dist/update-check.js → ../package.json).
    // This avoids a static JSON import, which would fail tsc's rootDir check
    // and requires deprecated `assert`/`with` import attributes.
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as NotifierPkg;
    if (!pkg?.name || !pkg?.version) {
      return;
    }

    // Dynamic import: if the dependency is missing or fails to load, the
    // server must still start. The rejection is swallowed below.
    void import("update-notifier")
      .then(({ default: updateNotifier }) => {
        const notifier = updateNotifier({
          pkg,
          updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
        });
        notifier.notify({
          message:
            "CogMemory update available: {currentVersion} → {latestVersion}\n" +
            "Run `npm i -g cogmemory-mcp` to update.",
        });
      })
      .catch(() => {
        // update-notifier unavailable or failed — non-fatal, ignore.
      });
  } catch {
    // Any unexpected failure in the notifier path must never block startup.
  }
}
