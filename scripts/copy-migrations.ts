// CogMemory MCP — Post-build script
// Copies migration .sql files from src/db/migrations/ to dist/db/migrations/
// because tsc only compiles .ts files and does not copy .sql assets.

import { cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "src", "db", "migrations");
const dest = join(__dirname, "..", "dist", "db", "migrations");

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[postbuild] Copied migration .sql files to dist/db/migrations/`);
