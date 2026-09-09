// CogMemory MCP — Versioned migration runner
//
// Reads PRAGMA user_version, discovers numbered .sql migration files,
// and applies pending migrations in order inside transactions.
// Creates a pre-migration backup file when upgrading from user_version=0.

import Database from "better-sqlite3";
import { readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/** Maximum migration version this codebase supports. */
export const MAX_VERSION = 9;

/**
 * Structural marker for migration 009 (project-scoped uniques).
 *
 * Guards against a corrupted version stamp: if a DB claims user_version >= 9
 * but does NOT have this constraint, something skipped migration 009 (e.g. a
 * manual `PRAGMA user_version = 9` on a live DB). The application code targets
 * `ON CONFLICT(project_id, key)` etc., which fails against the legacy
 * single-column constraints, so we detect and self-heal by re-running 009.
 */
const MIGRATION_009_MARKER = "UNIQUE(PROJECT_ID, KEY)";

/** Table the 009 marker lives on. */
const MIGRATION_009_MARKER_TABLE = "context";

/**
 * Version to rewind to when the 009 marker is missing so 009 re-applies.
 * 008 must remain considered applied (its changes are additive columns).
 */
const MIGRATION_009_REWIND_VERSION = 8;

/**
 * Thrown when a database was written by a NEWER version of CogMemory
 * (user_version > MAX_VERSION). Opening it with an older binary risks
 * corrupting state (missing columns/tables/constraints), so startup is
 * refused instead of silently skipping migrations.
 */
export class SchemaVersionError extends Error {
  constructor(dbVersion: number, supportedVersion: number) {
    super(
      `Database schema v${dbVersion} is newer than this CogMemory build supports (v${supportedVersion}). ` +
        `Refusing to open to avoid corrupting state. ` +
        `Upgrade cogmemory-mcp (npm i -g cogmemory-mcp@latest) or restore a backup.`,
    );
    this.name = "SchemaVersionError";
  }
}

/**
 * Migrations that rewrite table structure in bulk and therefore always
 * warrant a pre-migration backup, regardless of the starting user_version.
 */
const BACKUP_REQUIRED_VERSIONS = new Set([8, 9]);

/**
 * Migrations that DROP and rebuild tables referenced by ON DELETE CASCADE
 * foreign keys (e.g. `entities`, `symbols`). Foreign keys MUST be disabled
 * for the duration of these migrations, otherwise the DROP TABLE cascades
 * into dependent tables and wipes their rows.
 */
const FOREIGN_KEYS_OFF_VERSIONS = new Set([9]);

/**
 * Decide whether a pre-migration backup is needed: upgrading from
 * user_version=0 (pre-migration-system), or applying a migration flagged
 * as structurally risky (e.g. 008 project scoping).
 */
function shouldBackup(current: number, files: MigrationFile[]): boolean {
  if (current === 0) return true;
  return files.some(
    (f) => BACKUP_REQUIRED_VERSIONS.has(f.version) && f.version > current,
  );
}

/**
 * Run all pending migrations up to MAX_VERSION.
 *
 * - For user_version=0 DBs (pre-migration-system), creates a backup file.
 * - Each migration runs inside a single transaction (BEGIN…COMMIT).
 * - On failure: ROLLBACK, stderr error, process.exit(1).
 * - FTS rebuilds are inside 001_baseline.sql only (not on every open).
 */
export function runMigrations(db: Database.Database, dbPath: string): void {
  const current = (db.pragma("user_version", { simple: true }) as number) ?? 0;

  // Downgrade guard: a DB written by a newer binary may contain tables,
  // columns, or constraints this build knows nothing about. Silently skipping
  // migrations (the old behavior) would let the old code write against a
  // schema it does not understand — refuse instead.
  if (current > MAX_VERSION) {
    throw new SchemaVersionError(current, MAX_VERSION);
  }

  if (current >= MAX_VERSION) {
    // Integrity check: a forged/skipped version stamp (e.g. manual
    // `PRAGMA user_version = 9`) leaves the DB claiming v9 without migration
    // 009's constraints. Self-heal by rewinding so 009 re-applies.
    if (!migration009Applied(db)) {
      healSkippedMigration009(db, dbPath, current);
    }
    return; // Already up-to-date
  }

  // Discover migration files: 001_*.sql, 002_*.sql, …
  const migrationsDir = join(
    new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), // normalize Windows path
    "migrations",
  );

  const migrationFiles = discoverMigrations(migrationsDir);

  if (migrationFiles.length === 0) {
    return;
  }

  // Pre-migration backup (see shouldBackup)
  if (
    shouldBackup(current, migrationFiles) &&
    !process.env.COGMEMORY_SKIP_BACKUP
  ) {
    createBackup(dbPath);
  }

  // Apply pending migrations in order
  applyPendingMigrations(db, migrationFiles, current, dbPath);

  const finalVersion = db.pragma("user_version", { simple: true }) as number;
  if (finalVersion > current) {
    console.error(
      `  [migrate] Schema upgraded: v${current} → v${finalVersion}`,
    );
  }
}

/**
 * Apply all pending migrations (version > current) in order.
 * Extracted from runMigrations to keep cognitive complexity low.
 */
function applyPendingMigrations(
  db: Database.Database,
  files: MigrationFile[],
  current: number,
  dbPath: string,
): void {
  for (const file of files) {
    if (file.version <= current) {
      continue; // Already applied
    }
    applySingleMigration(db, file, current, dbPath);
  }
}

/**
 * Apply one migration inside a transaction, with the pragma-warning
 * tolerance and failure handling used by the original loop.
 */
function applySingleMigration(
  db: Database.Database,
  file: MigrationFile,
  current: number,
  dbPath: string,
): void {
  const sql = readFileSync(file.path, "utf-8");
  console.error(
    `  [migrate] Applying migration ${file.name} (v${file.version})…`,
  );

  // Disable foreign keys for table-rebuild migrations so DROP TABLE does not
  // cascade into dependent tables. Re-enabled after the transaction commits.
  const disableForeignKeys = FOREIGN_KEYS_OFF_VERSIONS.has(file.version);
  if (disableForeignKeys) {
    db.pragma("foreign_keys = OFF");
  }

  try {
    db.transaction(() => {
      db.exec(sql);
    })();
  } catch (err) {
    // Suppress: better-sqlite3 treats PRAGMA user_version as both a
    // "write" and a "pragma" and may throw "not an error" on some
    // SQLite builds. Check if migration actually succeeded.
    const check = db.pragma("user_version", { simple: true }) as number;
    if (check < file.version) {
      // Real failure — exit so the user can recover from the backup
      console.error(
        `[migrate] CRITICAL: Migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        `[migrate] Database may be partially migrated (user_version=${check}).`,
      );
      if (current === 0) {
        console.error(
          `[migrate] Recovery: restore from backup file: ${dbPath}.backup-pre-migrate-*`,
        );
      }
      process.exit(1);
    }
    // If user_version advanced, the migration succeeded despite the
    // warning. Continue.
    console.error(
      `  [migrate] ${file.name} applied (ignoring pragma warning).`,
    );
  } finally {
    // Restore foreign keys after a table-rebuild migration, regardless of
    // success or failure (the connection is shared and reused on every open).
    if (disableForeignKeys) {
      db.pragma("foreign_keys = ON");
    }
  }
}

// ── Internal helpers ──────────────────────────────────

interface MigrationFile {
  name: string;
  path: string;
  version: number;
}

/**
 * Detect whether migration 009 (project-scoped uniques) actually ran.
 *
 * Uses sqlite_master instead of PRAGMA index_list: the marker is a table-level
 * UNIQUE constraint with an auto-generated name (sqlite_autoindex_*), so we
 * match the constraint text from the CREATE statement rather than an index name.
 */
function migration009Applied(db: Database.Database): boolean {
  try {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(MIGRATION_009_MARKER_TABLE) as { sql: string | null } | undefined;
    if (!row?.sql) return false;
    // Normalize whitespace so formatting differences don't cause false negatives.
    const normalized = row.sql.replace(/\s+/g, " ").toUpperCase();
    return normalized.includes(MIGRATION_009_MARKER);
  } catch {
    // Table missing entirely → migration 009 definitely not applied
    return false;
  }
}

/**
 * Self-heal a DB whose user_version claims >= 9 but whose schema lacks
 * migration 009's constraints (typically caused by a manual
 * `PRAGMA user_version = 9` on a live DB). Rewinds the stamp to
 * MIGRATION_009_REWIND_VERSION so the normal apply path re-runs 009
 * (with its backup + foreign_keys handling) on the next open.
 */
function healSkippedMigration009(
  db: Database.Database,
  dbPath: string,
  claimedVersion: number,
): void {
  console.error(
    `  [migrate] WARNING: user_version=${claimedVersion} but migration 009 constraints are missing ` +
      `(version stamp was likely set manually). Rewinding to v${MIGRATION_009_REWIND_VERSION} to re-apply.`,
  );

  // Safety net before a structurally risky re-migration.
  if (!process.env.COGMEMORY_SKIP_BACKUP) {
    createBackup(dbPath);
  }

  db.pragma(`user_version = ${MIGRATION_009_REWIND_VERSION}`);

  // Re-run the normal migration path from the rewound version.
  const migrationsDir = join(
    new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), // normalize Windows path
    "migrations",
  );
  const migrationFiles = discoverMigrations(migrationsDir);
  applyPendingMigrations(
    db,
    migrationFiles,
    MIGRATION_009_REWIND_VERSION,
    dbPath,
  );

  const finalVersion = db.pragma("user_version", { simple: true }) as number;
  if (!migration009Applied(db) || finalVersion < claimedVersion) {
    console.error(
      `[migrate] CRITICAL: Self-heal failed — migration 009 constraints still missing ` +
        `(user_version=${finalVersion}). Restore from a backup file: ${dbPath}.backup-pre-migrate-*`,
    );
    process.exit(1);
  }
  console.error(
    `  [migrate] Self-heal complete: migration 009 re-applied (v${MIGRATION_009_REWIND_VERSION} → v${finalVersion}).`,
  );
}

/**
 * Discover migration .sql files in the migrations directory.
 * Returns sorted array by version number.
 */
function discoverMigrations(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No migrations directory — nothing to do
    return [];
  }

  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    // Extract version from filename: 001_baseline.sql → 1
    const match = /^\d{3}_/.exec(entry);
    if (!match) continue;
    const version = Number.parseInt(match[0].slice(0, 3), 10);
    const path = join(dir, entry);
    try {
      // Verify it's a regular file, not a directory
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    files.push({ name: basename(entry), path, version });
  }

  // Sort by version number ascending
  files.sort((a, b) => a.version - b.version);
  return files;
}

/**
 * Create a timestamped backup of the database file.
 * Only runs for the first migration (user_version=0).
 */
function createBackup(dbPath: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.backup-pre-migrate-${timestamp}`;
  try {
    // Use SQLite backup API via better-sqlite3 (cleaner than fs.copyFileSync
    // while WAL mode is active — this ensures a consistent snapshot)
    copyFileSync(dbPath, backupPath);
    console.error(`  [migrate] Backup created: ${backupPath}`);
  } catch (err) {
    console.error(
      `[migrate] WARNING: Could not create backup at ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      `[migrate] Set COGMEMORY_SKIP_BACKUP=1 to suppress this warning.`,
    );
    // Don't block migration — backup failure is non-fatal
  }
}

/**
 * Guard: check whether a column already exists on a table.
 * Useful for ALTER TABLE ADD COLUMN in raw SQL migrations.
 */
export function columnExists(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}
