// CogMemory MCP — Pre-build script
// Syncs server.json version from package.json (single source of truth).
// Runs as part of the prebuild hook alongside generate-version.ts.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const srv = JSON.parse(readFileSync(join(root, "server.json"), "utf-8"));

const version = pkg.version;

srv.version = version;
if (srv.packages && srv.packages[0]) {
  srv.packages[0].version = version;
}

writeFileSync(join(root, "server.json"), JSON.stringify(srv, null, 2) + "\n");
console.log(`[prebuild] server.json synced → "${version}"`);
