# CogMemory MCP — Multi-Language Analyzer Architecture

## 1. Goal

Extend `index_codebase` beyond JS/TS (ts-morph) and Python (tree-sitter) to a fixed target set, without rewriting `walker.ts`, the DB layer, or `index_codebase` itself for every new language.

**Target languages:** Java, JS/TS (existing), C#, Erlang, Elixir (+ Phoenix), HTML/CSS, PHP (+ Laravel)

**Scope clarification:**

- **Phoenix** is a framework on top of Elixir, not a separate grammar — same `tree-sitter-elixir` parser, framework-aware symbol typing (see §4)
- **Laravel** is the same relationship to PHP — same `tree-sitter-php` parser, framework-aware symbol typing
- **HTML/CSS** don't have "calls/imports/extends" in the code sense — they get a different edge vocabulary (see §5)
- **Erlang** is its own grammar, unrelated to Elixir despite sharing the BEAM VM

---

## 2. Core Pattern: `LanguageAnalyzer` Interface

```typescript
// src/indexing/types.ts

export interface ExtractedSymbol {
  filePath: string;
  symbolName: string;
  symbolType: string; // 'function' | 'class' | 'interface' | 'method' | 'module' | ...
  startLine: number;
  endLine: number;
}

export interface ExtractedEdge {
  fromSymbol: string; // resolved symbol key (filePath#symbolName or similar)
  toSymbol: string;
  edgeType: string; // 'calls' | 'imports' | 'extends' | 'implements' | ...
}

export interface LanguageAnalyzer {
  /** File extensions this analyzer handles, without the dot. */
  extensions: string[];

  /** Human-readable name for logging/errors. */
  name: string;

  /** Parse one file's content and return its symbols. */
  extractSymbols(filePath: string, content: string): ExtractedSymbol[];

  /** Given the file's symbols, extract edges (calls/imports/etc). */
  extractEdges(
    filePath: string,
    content: string,
    symbols: ExtractedSymbol[],
  ): ExtractedEdge[];
}
```

```typescript
// src/indexing/analyzer-registry.ts

import { LanguageAnalyzer } from "./types.js";
import { tsAnalyzer } from "./ts-analyzer.js";
import { pythonAnalyzer } from "./py-analyzer.js";
// import { javaAnalyzer } from './java-analyzer.js';
// import { csharpAnalyzer } from './csharp-analyzer.js';
// ...

const registry = new Map<string, LanguageAnalyzer>();

function register(analyzer: LanguageAnalyzer) {
  for (const ext of analyzer.extensions) {
    registry.set(ext, analyzer);
  }
}

register(tsAnalyzer);
register(pythonAnalyzer);
// register(javaAnalyzer);
// register(csharpAnalyzer);

export function getAnalyzerForExtension(
  ext: string,
): LanguageAnalyzer | undefined {
  return registry.get(ext);
}

export function supportedExtensions(): string[] {
  return [...registry.keys()];
}
```

`index_codebase` changes to: for each file found by `walker.ts`, look up `getAnalyzerForExtension(ext)`; if none found, skip the file (or log to `logs/errors` — consistent with your existing pattern). **No changes needed to `walker.ts`, `db/connection.ts`, or the schema when adding a language.**

---

## 3. Template: Adding a Tree-Sitter-Based Language

Every new tree-sitter analyzer (Java, C#, Erlang, Elixir, PHP) follows this shape. Use `py-analyzer.ts` as the working reference implementation.

```typescript
// src/indexing/<lang>-analyzer.ts

import Parser from 'tree-sitter';
import <Lang> from 'tree-sitter-<lang>';
import { LanguageAnalyzer, ExtractedSymbol, ExtractedEdge } from './types.js';

const parser = new Parser();
parser.setLanguage(<Lang>);

export const <lang>Analyzer: LanguageAnalyzer = {
  name: '<Lang>',
  extensions: ['<ext1>', '<ext2>'],

  extractSymbols(filePath, content) {
    const tree = parser.parse(content);
    const symbols: ExtractedSymbol[] = [];
    // Walk tree.rootNode, match node types for functions/classes/methods
    // per-language node type names — see §6 reference table
    return symbols;
  },

  extractEdges(filePath, content, symbols) {
    const tree = parser.parse(content);   // consider caching the parse from extractSymbols
    const edges: ExtractedEdge[] = [];
    // Walk tree again, match call/import/extends node types
    return edges;
  },
};
```

**Per-language work is entirely step 6 below — writing the node-type queries.** Parser setup, registry wiring, and the interface are identical every time.

---

## 4. Framework-Awareness (Phoenix, Laravel)

Frameworks don't get separate `LanguageAnalyzer`s. Instead, the base analyzer optionally tags `symbolType` more specifically when it recognizes framework conventions:

| Framework               | Detection heuristic                                                                                      | Symbol type refinement                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Phoenix** (on Elixir) | Module `use Phoenix.Controller`/`use MyAppWeb, :controller`, or file path under `lib/*_web/controllers/` | `symbolType: 'phoenix_controller'` / `'phoenix_liveview'` instead of generic `'module'` |
| **Laravel** (on PHP)    | Class `extends Controller`, file path under `app/Http/Controllers/`, or Eloquent `extends Model`         | `symbolType: 'laravel_controller'` / `'laravel_model'` instead of generic `'class'`     |

This is a small enrichment step inside `extractSymbols` — check file path patterns and base-class/use-directive names, override `symbolType` when matched. **No new tables, no new edge types** — `codemap_annotations` and `generate_codemap` already work with any `symbolType` string.

---

## 5. HTML/CSS: Different Edge Vocabulary

HTML/CSS don't have function calls or module imports in the traditional sense. Recommended symbol/edge mapping:

| Concept                    | HTML/CSS equivalent                                                         | symbolType / edgeType                                |
| -------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| Symbol                     | `<div id="app">`, `.card`, `#header`, custom elements                       | `symbolType: 'element'` / `'css-class'` / `'css-id'` |
| Edge: "imports"            | `<link>`, `<script src>`, CSS `@import`                                     | `edgeType: 'includes'`                               |
| Edge: "calls"/"references" | Class/id used in HTML matched to CSS selector defining it                   | `edgeType: 'styled-by'`                              |
| Edge: "extends"            | CSS custom property inheritance / SCSS `@extend` (if supporting SCSS later) | `edgeType: 'extends'`                                |

This still fits the existing `symbols`/`edges` tables — just a different vocabulary for `symbolType`/`edgeType`, consistent with how `conventions.category` already handles multiple concept types in one table. Treat HTML and CSS as **two separate analyzers** (`html-analyzer.ts`, `css-analyzer.ts`) since they're different grammars, but link them via the `styled-by` edge type when a codebase indexes both together.

---

## 6. Per-Language Grammar Reference

### Tier 1 — Original scope (client-stack driven)

| Language | Grammar package       | Extensions                    | Notes                                                                                                                                 |
| -------- | --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Java     | `tree-sitter-java`    | `.java`                       | Widely used, stable node types (`class_declaration`, `method_declaration`, `import_declaration`)                                      |
| C#       | `tree-sitter-c-sharp` | `.cs`                         | Actively maintained; TIOBE Language of the Year 2025; node types include `class_declaration`, `method_declaration`, `using_directive` |
| Erlang   | `tree-sitter-erlang`  | `.erl`, `.hrl`                | Functions are top-level (`fun_decl`), no classes — map to `symbolType: 'function'` / `'module'` only                                  |
| Elixir   | `tree-sitter-elixir`  | `.ex`, `.exs`                 | Production-ready, used by GitHub itself for code navigation; `def`/`defmodule`/`defp` map to function/module symbols                  |
| PHP      | `tree-sitter-php`     | `.php`                        | Actively maintained; `class_declaration`, `function_definition`, `namespace_use_declaration`                                          |
| HTML     | `tree-sitter-html`    | `.html`, `.htm`               | Element-based, see §5                                                                                                                 |
| CSS      | `tree-sitter-css`     | `.css`, `.scss` (if extended) | Selector-based, see §5                                                                                                                |

### Tier 2 — Your DevOps/infra stack

| Language      | Grammar package          | Extensions                  | Notes                                                                                                                                       |
| ------------- | ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Go            | `tree-sitter-go`         | `.go`                       | Already in your stack; `func_declaration`, `import_spec`, `type_declaration` (structs/interfaces)                                           |
| Bash/Shell    | `tree-sitter-bash`       | `.sh`, `.bash`              | Symbols = functions; edges = `source`/`.` includes — high practical value given your CI/deploy script volume                                |
| Dockerfile    | `tree-sitter-dockerfile` | `Dockerfile`, `.dockerfile` | Symbols = build stages (`FROM ... AS`); edges = `COPY --from` stage references                                                              |
| YAML          | `tree-sitter-yaml`       | `.yml`, `.yaml`             | GitHub Actions/K8s manifests/Compose files — symbols = jobs/steps/services, lower priority                                                  |
| HCL/Terraform | `tree-sitter-hcl`        | `.tf`, `.tfvars`            | Symbols = resource/module blocks; edges = resource references (`aws_instance.x.id` style) — directly relevant to your Terraform import work |

### Tier 3 — General market coverage (2026 rankings-driven)

| Language | Grammar package      | Extensions              | Why it's here                                                                                                           |
| -------- | -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Python   | `tree-sitter-python` | _(already implemented)_ | Listed for completeness — #1 on TIOBE, #1 on PYPL                                                                       |
| C        | `tree-sitter-c`      | `.c`, `.h`              | Surpassed C++ on TIOBE (#2); systems/embedded work                                                                      |
| C++      | `tree-sitter-cpp`    | `.cpp`, `.cc`, `.hpp`   | Still top-3 TIOBE despite the drop; large existing codebases                                                            |
| Rust     | `tree-sitter-rust`   | `.rs`                   | Most-admired language 9 years running; CISA memory-safety mandate driving adoption in infra/systems work                |
| Kotlin   | `tree-sitter-kotlin` | `.kt`, `.kts`           | JVM/Spring-adjacent, Android + backend                                                                                  |
| Swift    | `tree-sitter-swift`  | `.swift`                | Only relevant for iOS-touching client work                                                                              |
| Ruby     | `tree-sitter-ruby`   | `.rb`                   | Rails ecosystem, common in inherited codebases                                                                          |
| SQL      | `tree-sitter-sql`    | `.sql`                  | Different edge vocabulary — table/column references, not calls/imports; useful for migration/schema dependency tracking |
| Scala    | `tree-sitter-scala`  | `.scala`                | JVM ecosystem, data engineering contexts                                                                                |
| Lua      | `tree-sitter-lua`    | `.lua`                  | Config/scripting layer in some infra tools (nginx, Redis modules)                                                       |

All packages confirmed actively maintained/published on npm. Install per-language as you build each analyzer — no need to install all upfront. Tiers reflect priority ordering, not a hard sequence — pick from any tier based on what a given client project needs.

---

## 7. Task List

### Phase A — Refactor Existing Analyzers Into the Interface

- [ ] Create `src/indexing/types.ts` with `LanguageAnalyzer`, `ExtractedSymbol`, `ExtractedEdge`
- [ ] Refactor `ts-analyzer.ts` to export `tsAnalyzer: LanguageAnalyzer` matching the interface (should be mostly a reshape, not new logic)
- [ ] Refactor `py-analyzer.ts` the same way
- [ ] Create `analyzer-registry.ts`, register both
- [ ] Update `index_codebase` in `code-graph.ts` to dispatch via `getAnalyzerForExtension` instead of any hardcoded branching
- [ ] Regression test: run existing smoke-test script, confirm JS/TS + Python indexing still produces identical results

### Phase B — Add Java

- [ ] `npm i tree-sitter-java`
- [ ] Write `java-analyzer.ts`: symbols = `class_declaration`, `interface_declaration`, `method_declaration`, `enum_declaration`
- [ ] Edges: `method_invocation` (calls), `import_declaration` (imports), `superclass`/`super_interfaces` (extends/implements)
- [ ] Register in registry
- [ ] Test against a real Java file (e.g. sample from one of your Spring Boot projects)

### Phase C — Add `C#`

- [ ] `npm i tree-sitter-c-sharp`
- [ ] Write `csharp-analyzer.ts`: symbols = `class_declaration`, `interface_declaration`, `method_declaration`, `namespace_declaration`
- [ ] Edges: `invocation_expression` (calls), `using_directive` (imports), `base_list` (extends/implements)
- [ ] Register, test against a sample C# file

### Phase D — Add PHP (+ Laravel awareness)

- [ ] `npm i tree-sitter-php`
- [ ] Write `php-analyzer.ts`: symbols = `class_declaration`, `function_definition`, `method_declaration`
- [ ] Edges: `function_call_expression` (calls), `namespace_use_declaration` (imports), `class_base_clause` (extends)
- [ ] Add Laravel detection: check `extends Controller` / `extends Model` / file path under `app/Http/Controllers` or `app/Models`, override `symbolType`
- [ ] Register, test against a Laravel sample (controller + model)

### Phase E — Add Elixir (+ Phoenix awareness)

- [ ] `npm i tree-sitter-elixir`
- [ ] Write `elixir-analyzer.ts`: symbols = `defmodule` (module), `def`/`defp` (function)
- [ ] Edges: function calls within pipe/call expressions, `alias`/`import`/`use` directives (imports)
- [ ] Add Phoenix detection: `use Phoenix.Controller`, `use MyAppWeb, :controller`, or path under `lib/*_web/`, override `symbolType`
- [ ] Register, test against a Phoenix sample (controller + LiveView if available)

### Phase F — Add Erlang

- [ ] `npm i tree-sitter-erlang`
- [ ] Write `erlang-analyzer.ts`: symbols = `fun_decl` (function), module attribute (`-module(...)`) for file-level symbol
- [ ] Edges: function calls, `-import` attribute
- [ ] Register, test against a sample `.erl` file

### Phase G — Add HTML/CSS

- [ ] `npm i tree-sitter-html tree-sitter-css`
- [ ] Write `html-analyzer.ts`: symbols = tagged elements with `id`/custom element names; edges = `<link>`/`<script src>` as `includes`
- [ ] Write `css-analyzer.ts`: symbols = class/id selectors; edges = `@import` as `includes`
- [ ] Implement `styled-by` cross-file edge: after both HTML and CSS symbols exist for a project, match HTML class/id usage to CSS selector definitions
- [ ] Register both, test against a sample HTML+CSS pair

### Phase I — Add Go

- [ ] `npm i tree-sitter-go`
- [ ] Write `go-analyzer.ts`: symbols = `function_declaration`, `method_declaration`, `type_declaration` (structs/interfaces)
- [ ] Edges: `call_expression` (calls), `import_spec` (imports), struct embedding as a form of `extends`
- [ ] Register, test against a sample Go file

### Phase J — Add Bash/Shell

- [ ] `npm i tree-sitter-bash`
- [ ] Write `bash-analyzer.ts`: symbols = `function_definition`; file itself is a symbol too (script-level)
- [ ] Edges: `source`/`.` statements as `includes`; command invocations of other scripts as `calls`
- [ ] Register, test against a deploy/CI script

### Phase K — Add Dockerfile

- [ ] `npm i tree-sitter-dockerfile`
- [ ] Write `dockerfile-analyzer.ts`: symbols = build stages (`FROM ... AS <name>`)
- [ ] Edges: `COPY --from=<stage>` as a stage-reference edge
- [ ] Register, test against a multi-stage Dockerfile

### Phase L — Add YAML (CI/K8s manifests)

- [ ] `npm i tree-sitter-yaml`
- [ ] Write `yaml-analyzer.ts`: symbols = top-level keys relevant to context (GitHub Actions `jobs.<id>`, K8s `kind`+`metadata.name`, Compose `services.<name>`)
- [ ] Edges: `needs:` (GitHub Actions job dependency), `depends_on:` (Compose) as `depends_on` edge type
- [ ] Register, test against a GitHub Actions workflow file

### Phase M — Add HCL/Terraform

- [ ] `npm i tree-sitter-hcl`
- [ ] Write `hcl-analyzer.ts`: symbols = `resource "<type>" "<name>"`, `module "<name>"`, `variable "<name>"`
- [ ] Edges: interpolation references (`aws_instance.web.id` style) as `references`
- [ ] Register, test against a `.tf` file — natural fit given your Terraform import workflow

### Phase N — Add C

- [ ] `npm i tree-sitter-c`
- [ ] Write `c-analyzer.ts`: symbols = `function_definition`, `struct_specifier`
- [ ] Edges: `call_expression` (calls), `#include` preprocessor directive (imports)
- [ ] Register, test against a sample C file

### Phase O — Add C++

- [ ] `npm i tree-sitter-cpp`
- [ ] Write `cpp-analyzer.ts`: symbols = `function_definition`, `class_specifier`, `namespace_definition`
- [ ] Edges: `call_expression`, `#include`, `base_class_clause` (extends)
- [ ] Register, test against a sample C++ file

### Phase P — Add Rust

- [ ] `npm i tree-sitter-rust`
- [ ] Write `rust-analyzer.ts`: symbols = `function_item`, `struct_item`, `impl_item`, `trait_item`
- [ ] Edges: `call_expression` (calls), `use_declaration` (imports), `impl ... for` as `implements`
- [ ] Register, test against a sample Rust file

### Phase Q — Add Kotlin

- [ ] `npm i tree-sitter-kotlin`
- [ ] Write `kotlin-analyzer.ts`: symbols = `class_declaration`, `function_declaration`, `object_declaration`
- [ ] Edges: call expressions, `import_header` (imports), supertype list (extends/implements)
- [ ] Register, test against a sample Kotlin file

### Phase R — Add Swift

- [ ] `npm i tree-sitter-swift`
- [ ] Write `swift-analyzer.ts`: symbols = `class_declaration`, `function_declaration`, `protocol_declaration`
- [ ] Edges: call expressions, `import_declaration`, inheritance clause (extends/implements)
- [ ] Register, test against a sample Swift file

### Phase S — Add Ruby

- [ ] `npm i tree-sitter-ruby`
- [ ] Write `ruby-analyzer.ts`: symbols = `class`, `module`, `method` (`def`)
- [ ] Edges: method calls, `require`/`require_relative` (imports), `superclass` (extends)
- [ ] Optional Rails detection (same pattern as Laravel/Phoenix): `< ApplicationController`, `< ApplicationRecord` → refined `symbolType`
- [ ] Register, test against a sample Ruby/Rails file

### Phase T — Add SQL

- [ ] `npm i tree-sitter-sql`
- [ ] Write `sql-analyzer.ts`: symbols = `CREATE TABLE`/`CREATE VIEW` definitions (table/view name), columns as sub-symbols if useful
- [ ] Edges: `FOREIGN KEY` references, `JOIN` table references — different vocabulary (`references` not `calls`), useful for migration/schema dependency tracking across your PostgreSQL work
- [ ] Register, test against a schema migration file

### Phase U — Add Scala

- [ ] `npm i tree-sitter-scala`
- [ ] Write `scala-analyzer.ts`: symbols = `class_definition`, `object_definition`, `trait_definition`, `function_definition`
- [ ] Edges: call expressions, `import_declaration`, extends/with clauses
- [ ] Register, test against a sample Scala file

### Phase V — Add Lua

- [ ] `npm i tree-sitter-lua`
- [ ] Write `lua-analyzer.ts`: symbols = `function_declaration`, `local_function`
- [ ] Edges: `require(...)` calls as `imports`, function calls as `calls`
- [ ] Register, test against an nginx/Redis Lua module sample

### Phase W — Documentation & Polish

- [ ] Update README "Supported Languages" table with all new languages/extensions
- [ ] Update `index_codebase` tool description/schema if `extensions` param needs updated defaults
- [ ] Add a CONTRIBUTING note describing the `LanguageAnalyzer` interface so future languages (or community contributions) follow the same pattern
- [ ] Full smoke test across a multi-language sample repo (or synthetic fixture directory with one file per language)

---

## 8. Design Notes

- **No schema changes required for any of the ~25 languages above.** `symbols.symbol_type` and `edges.edge_type` are free-text columns — every new language/framework just introduces new string values, no migrations needed regardless of tier.
- **Order of implementation is fully flexible** across all tiers/phases — none depend on each other once Phase A (the registry refactor) is done. This list is a menu, not a sequence; implement in whatever order matches active client work.
- **Config-format analyzers (YAML, HCL, Dockerfile) use a different mental model** than programming-language analyzers — "symbols" are structural blocks (jobs, resources, stages) and "edges" are references/dependencies rather than function calls. The `LanguageAnalyzer` interface still fits; just don't force a `calls`/`imports` framing where `references`/`depends_on` is more accurate.
- **Parsing cost:** each analyzer currently re-parses the file for both `extractSymbols` and `extractEdges` in the template above. Once several languages are in and indexing time is measurable on a real repo, consider caching the parsed `tree` per file within one `index_codebase` run — not needed until it's actually slow.
- **`tree-sitter-language-pack`** (the 371-language bundled package) remains a valid future swap if the per-language install list grows unwieldy — but with ~25 named languages and direct control over query logic being valuable for each, per-language `tree-sitter-<lang>` packages are still the better default.
- **Framework-awareness pattern (§4) extends to Ruby/Rails too** (Phase S) — same technique as Phoenix/Laravel: base-class/directive detection, no new tables.
