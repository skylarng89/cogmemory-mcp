## System Architecture Blueprint: Zero-Config Project Identity Resolution

**TL;DR**: CogMemory currently requires users to manually pin `--workspace`/`cwd` per MCP client entry, or risk every project silently collapsing into one stale identity bucket (observed: a `frontend-v2` slug leaking into an unrelated `terraform` repo because the client pinned `--workspace /home/patrick`). This blueprint removes that manual burden by (1) making the client's actual CWD + git-root discovery the primary identity signal instead of a pinned/home-directory fallback, (2) strictly separating **scope config** (`~/.cogmemory/config.json` → global vs workspace) from **project identity config** (`<repo>/.cogmemory/config.json` → `project_id` slug), and (3) adding a runtime `switch_project` escape hatch plus self-verification fields on `cogmemory_status` for clients that still pin a stale root. Net effect: opening any git repo "just works" with its own isolated memory bucket, with zero per-project MCP configuration required.

---

**1. Software Requirements Specification (SRS)**

_Functional Targets_

- FR-1: When a client launches the CogMemory server with CWD inside a git repository and no explicit `--workspace`/`COGMEMORY_WORKSPACE` override, the server MUST resolve project identity from that repository's root, not from any parent/home directory.
- FR-2: `~/.cogmemory/config.json` MUST only ever express **scope settings** (`scope`, `disable_update_check`). It MUST NOT be read as a source of `project_id` when the resolved workspace root differs from `homedir()`.
- FR-3: In global scope, the identity anchor (the directory whose `.cogmemory/config.json` holds `project_id`) MUST be the discovered project root (git root, or nearest `.cogmemory/`, or CWD) — never hardcoded to `homedir()`.
- FR-4: A new `switch_project(root_dir)` tool MUST allow re-resolving/creating project identity at runtime, for clients that pin a stale `--workspace` and cannot restart per-project. This mutates the active project context for the remainder of the server process.
- FR-5: `cogmemory_status` MUST report `workspace_root`, `root_path_hint`, and whether the resolved root came from git-root discovery, `.cogmemory/` walk-up, explicit override, or CWD fallback — so agents/users can self-diagnose misrouted identity before writing memories.
- FR-6: On boot, if an existing `project_id` slug's stored `root_path_hint` diverges materially from the freshly discovered root (e.g., resolved root is `terraform` but the slug's hint is `frontend-v2`), log a stderr advisory rather than silently reusing the mismatched slug.
- FR-7: Existing single-project workspace-scope and legacy-unassigned global-scope behavior (ADR-3/ADR-4/ADR-6 in migration 008) MUST remain intact — this is additive, not a breaking schema change.

_Non-Functional Performance SLAs_

- NFR-1: Identity resolution (git-root discovery walk + `.cogmemory/config.json` read) adds ≤5ms p99 to server boot on local filesystems (bounded walk, same order as existing `findCogmemoryDir`).
- NFR-2: `switch_project` completes in ≤50ms (single upsert + touch, no schema migration).
- NFR-3: Zero data loss / zero silent cross-project bleed: no write path may persist a row under a `project_id` that does not match the currently active, explicitly resolved project for that call.
- NFR-4: Backward compatible with all client configs that already pin `--workspace` correctly — no behavior change for correctly configured clients.

---

**2. Architecture Decision Records (ADRs)**

**ADR-7: Git-root discovery as the primary implicit identity signal**

- _Context_: `resolveWorkspaceRoot()` today only walks up looking for an _existing_ `.cogmemory/` directory before falling back to raw CWD. First-time users in a fresh repo get CWD-only resolution, which is fragile if the MCP client launches from a subdirectory or a pinned parent (as in the reported incident).
- _Selected Approach_: Insert a `findGitRoot(start)` step (walk up looking for `.git/`) between the env-var override and the `.cogmemory/` walk-up. Git root is a much stronger, ubiquitous signal of "this is a project" than an as-yet-nonexistent `.cogmemory/` folder.
- _Version Metrics (Context7)_: N/A — pure Node `fs` walk, no external dependency added (mirrors existing `findCogmemoryDir` implementation style in `src/config.ts`).
- _Consequences_: Non-git directories (rare for coding agent use) still fall back to `.cogmemory/` walk-up, then CWD, unchanged. Monorepo users who want a subdirectory (not repo root) as the identity anchor must continue to use `--workspace`/`COGMEMORY_WORKSPACE` — documented as the explicit-override tier, which still takes priority.

**ADR-8: Decouple scope config from identity config**

- _Context_: `buildGlobalConfig()` sets `workspaceRoot: homedir()`, and `resolveProjectIdentity(workspaceRoot, ...)` then reads `project_id` from _that same root's_ `.cogmemory/config.json` — i.e., `~/.cogmemory/config.json`. In global scope this file becomes a single shared identity slug for every project the user ever opens, which is exactly the reported defect.
- _Selected Approach_: `buildGlobalConfig()` now takes the already-discovered `workspaceRoot` (from ADR-7 resolution) as a parameter and returns it unchanged in the `Config`. Only `dbPath` is redirected to `~/.cogmemory/global.db`. `resolveProjectIdentity()` continues to read/write `project_id` at `<discovered-root>/.cogmemory/config.json`, never at `homedir()/.cogmemory/config.json` unless the discovered root genuinely _is_ the home directory (e.g., truly global, project-less usage).
- _Version Metrics_: N/A, internal refactor.
- _Consequences_: `~/.cogmemory/config.json` becomes purely a scope/settings file. Existing installs where a stale `project_id` was accidentally written to `~/.cogmemory/config.json` (like the reported `frontend-v2` leak) need a one-time cleanup — handled by ADR-10's mismatch advisory, not an automatic silent delete (data safety).

**ADR-9: Runtime project switching (`switch_project`)**

- _Context_: Per `src/index.ts`, `projectId` is resolved once in `main()` and threaded as an immutable number into every `register*Tools(...)` call. Some MCP clients (Codex today) pin a fixed `--workspace`/`cwd` per server entry and don't restart per project, so boot-time-only resolution cannot self-correct without a process restart.
- _Selected Approach_: Wrap `projectId` in a small mutable `ActiveProjectRef` (`{ get(): number; set(id: number): void }`) passed to tool registration instead of a raw number. Add a `switch_project` tool that calls `resolveProjectIdentity(resolve(root_dir), db, config.scope)` and updates the ref. All tool handlers read `ref.get()` at call time instead of closing over a stale constant.
- _Version Metrics_: N/A, internal refactor only; no new dependencies.
- _Consequences_: Slightly larger refactor surface (every `tools/*.ts` register function signature changes from `projectId: number` to `activeProject: ActiveProjectRef`). Mitigated by doing this as an isolated, mechanical Sprint (see Section 5) with a thin compatibility shim (`ref.get()` at the top of each handler) to minimize per-tool diff size.

**ADR-10: Mismatch advisory instead of silent slug reuse**

- _Context_: FR-6. Silently trusting a resolved slug whose `root_path_hint` no longer matches the current root risks repeating the exact incident (right slug found on disk, wrong project intended).
- _Selected Approach_: In `resolveProjectIdentity`, after finding a row by slug, compare `basename(row.root_path_hint)` to `basename(rootHint)`. On mismatch, log `[cogmemory] Warning: resolved slug <slug> was last seen at "<old-hint>", current workspace is "<new-hint>" — continuing, but if this is unexpected, run switch_project or clear .cogmemory/config.json` to stderr, then proceed (touch `root_path_hint` to the new value, since a legitimate rename/move is the common case per existing "Renames and moves are safe" design goal).
- _Version Metrics_: N/A.
- _Consequences_: Preserves the intentional "moves are safe" behavior (README) while giving observability into the specific accidental-collision case, without introducing a blocking prompt that would break non-interactive MCP tool calls.

---

**3. System Modeling & Data Boundaries (C4 Context Model)**

```mermaid
flowchart TD
    Client[MCP Client<br/>Codex / VS Code / etc.] -->|stdio, argv, cwd, env| Boot[Boot: resolveWorkspaceRoot]
    Boot -->|priority 1| Override[--workspace / COGMEMORY_WORKSPACE]
    Boot -->|priority 2 NEW| GitRoot[findGitRoot: walk up for .git/]
    Boot -->|priority 3| DotCog[findCogmemoryDir: walk up for .cogmemory/]
    Boot -->|priority 4| CwdFallback[resolve('.')]

    Override --> Root[workspaceRoot]
    GitRoot --> Root
    DotCog --> Root
    CwdFallback --> Root

    Root --> ScopeCfg[resolveConfig: reads <root>/.cogmemory/config.json for scope only]
    ScopeCfg -->|scope=workspace| WsDb[(<root>/.cogmemory/memory.db)]
    ScopeCfg -->|scope=global| GlobalDb[(~/.cogmemory/global.db)]

    Root --> Identity[resolveProjectIdentity<br/>reads/writes <root>/.cogmemory/config.json project_id]
    Identity -->|slug found| Adopt[Adopt existing project row]
    Identity -->|slug missing| Bootstrap[Create UUID slug + projects row<br/>ADR-6 race-safe wx create]
    Identity -->|hint mismatch NEW ADR-10| Advisory[stderr advisory, continue]

    Adopt --> ActiveRef[ActiveProjectRef NEW ADR-9]
    Bootstrap --> ActiveRef
    ActiveRef --> Tools[All registered tools read ref.get<br/>per call, not boot-time constant]

    Client -->|switch_project root_dir NEW| SwitchTool[switch_project tool]
    SwitchTool --> Identity
    Client -->|cogmemory_status NEW fields| StatusTool[cogmemory_status]
    StatusTool -->|reports| Report[workspace_root, root_path_hint,<br/>resolution_source, active_project]
```

_Domain boundaries_: `src/config.ts` (resolution + identity), `src/index.ts` (boot wiring + `ActiveProjectRef` construction), `src/tools/projects.ts` (new `switch_project`, existing `list_projects`/`rename_project`/`prune_projects`), `src/tools/introspection.ts` (`cogmemory_status` new fields), all `src/tools/*.ts` register functions (signature change from `projectId: number` → `activeProject: ActiveProjectRef`).

_Database flow topology_: unchanged storage shape — `projects` table (migration 008) remains the single source of identity truth; no new migration required since `root_path_hint` and `last_seen_at` columns already exist. All project-scoped tables continue to fan out via `project_id` FK.

_API contract (new/changed tool surface)_:

- `switch_project({ root_dir: string })` → `{ success: boolean, project: { id, slug, label, isNewProject } }`
- `cogmemory_status()` response gains: `workspace_root: string`, `root_path_hint: string`, `resolution_source: "override" | "git-root" | "dotcogmemory" | "cwd-fallback"`, unchanged `active_project`.

---

**4. Infrastructure, Observability & Resilience Blueprint**

- **Observability**: All resolution-tier decisions and ADR-10 mismatches log to stderr only (never stdout, preserving stdio MCP transport integrity — consistent with existing `console.error` convention throughout `src/config.ts`/`src/index.ts`). `cogmemory_status` verbose mode surfaces `resolution_source` so users/agents can self-diagnose without reading logs.
- **Resilience / Failure Modes**:
  - Non-git, non-`.cogmemory/` directory with no override → unchanged CWD fallback (no regression).
  - Two processes racing to bootstrap the same new repo → unchanged ADR-6 exclusive-create (`flag: "wx"`) race resolution, already race-safe.
  - `switch_project` called mid-session with an invalid/inaccessible `root_dir` → tool returns `{ success: false, message }` without mutating `ActiveProjectRef` (fail-closed, previous project stays active).
  - Malformed `~/.cogmemory/config.json` after the ADR-8 split → existing malformed-JSON fallback in `readConfigFile`/`resolveConfig` already handles this defensively; no new failure surface.
- **Migration/Rollout safety**: Fully additive — no schema migration needed (009+ reserved but not required for this blueprint since `projects.root_path_hint` already exists). Existing correctly-configured clients see no behavior change. Existing incorrectly-configured clients (the reported incident) self-heal on next boot once the client config drops the home-directory pin, or immediately via `switch_project` without restarting.
- **Documentation**: README "Scope Configuration", "Project Identity", and "Multi-Root / Monorepos" sections updated to describe git-root discovery as the new default recommendation over per-project `--workspace` pinning, and to document `switch_project`.

---

**5. Implementation Task List (Sprint Breakdown)**

Legend: `- [ ] Not Started` | `- [/] In Progress` | `- [x] Completed` | `- [-] Blocked/Cancelled`

### Sprint 1: Core Resolution & Config Decoupling (ADR-7, ADR-8)

- [x] Task 1.1: Add `findGitRoot(start: string): string | null` to `src/config.ts`, mirroring the bounded upward-walk style of `findCogmemoryDir`.
- [x] Task 1.2: Update `resolveWorkspaceRoot(argv)` priority order to: explicit `--workspace`/`COGMEMORY_WORKSPACE` → `findGitRoot` → `findCogmemoryDir` → CWD fallback. Track and return which tier matched (needed for FR-5).
- [x] Task 1.3: Change `buildGlobalConfig()` signature to `buildGlobalConfig(workspaceRoot: string): Config`, preserving the passed-in root instead of `homedir()`; update the sole call site in `resolveConfig()`.
- [ ] Task 1.4: Add a unit test fixture (temp dirs) verifying: (a) git-root discovery wins over CWD fallback, (b) explicit `--workspace` still wins over git-root, (c) global scope config no longer forces `workspaceRoot = homedir()`.
- [x] Task 1.5: Update `resolveConfig`/`resolveProjectIdentity` call sites in `src/index.ts` accordingly; confirm no behavior change for workspace-scope path.

### Sprint 2: Mismatch Advisory & Status Introspection (ADR-10, FR-5, FR-6)

- [x] Task 2.1: In `resolveProjectIdentity`, add the `root_path_hint` basename comparison and stderr advisory on mismatch (non-blocking, still touches `root_path_hint`).
- [x] Task 2.2: Thread the resolution-tier tag from Task 1.2 into `main()` and into whatever context object `registerIntrospectionTools` receives.
- [x] Task 2.3: Extend `cogmemory_status` output schema in `src/tools/introspection.ts` with `workspace_root`, `root_path_hint`, `resolution_source`.
- [x] Task 2.4: Update README "Project Identity" / "Multi-Root / Monorepos" sections to document git-root discovery and the new status fields.

### Sprint 3: Runtime Project Switching (ADR-9)

- [x] Task 3.1: Introduce `ActiveProjectRef` type (`{ get(): number; set(id: number): void }`) in `src/config.ts` or a new `src/active-project.ts`.
- [x] Task 3.2: Refactor `src/index.ts` `main()` to construct one `ActiveProjectRef` from the boot-resolved `projectId` and pass it to all `register*Tools(...)` calls in place of the raw `projectId: number`.
- [x] Task 3.3: Mechanically update each `src/tools/*.ts` register function signature (`sessions.ts`, `memory.ts`, `plan-tasks.ts`, `knowledge-graph.ts`, `specs.ts`, `code-graph.ts`, `codemap.ts`, `list-delete.ts`, `code-analysis.ts`, `projects.ts`) to accept `ActiveProjectRef` and call `.get()` at the top of each `wrapHandler` callback instead of closing over the old constant.
- [x] Task 3.4: Add `switch_project` tool to `src/tools/projects.ts`: validates `root_dir`, calls `resolveProjectIdentity(resolve(root_dir), db, config.scope)`, calls `activeProject.set(identity.projectId)`, returns the new identity. Guard against nonexistent paths (fail-closed, per Resilience section).
- [x] Task 3.5: Update `prune_projects`'s existing "cannot prune active project" check to read `activeProject.get()` dynamically rather than the old closed-over constant.
- [ ] Task 3.6: Add smoke-test coverage in `scripts/smoke-test.ts` for: boot in repo A → write a decision → `switch_project` to repo B → write a decision → verify each decision is scoped to the correct distinct `project_id`.

### Sprint 4: Verification, Docs & Rollout

- [ ] Task 4.1: Run full existing smoke test suite (`scripts/smoke-test.ts`) to confirm zero regression in single-project workspace/global flows.
- [ ] Task 4.2: Manual verification against the reported incident: reproduce with a client config pinning `--workspace /home/patrick`, confirm `cogmemory_status` now surfaces `resolution_source: "override"` and the _original_ stale slug (expected — override still wins), then confirm removing the pin yields `resolution_source: "git-root"` and a fresh, correctly-scoped slug for the target repo.
- [x] Task 4.3: Update `README.md` "Multi-Root / Monorepos" guidance to recommend _not_ pinning `--workspace` per project for typical single-repo-per-session clients, reserving the override for genuine monorepo sub-root pinning.
- [ ] Task 4.4: Bump `package.json` version and add a CHANGELOG/`log_change` entry describing the zero-config identity resolution behavior change.
- [ ] Task 4.5: Cut a release and validate via `npx -y cogmemory-mcp@latest` from a fresh git-cloned test repo with no `.cogmemory/` present and no client-side workspace pinning.
