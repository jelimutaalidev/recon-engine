# Deterministic Recon Layer (Phase 2) Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD (failing test first). Steps use
> checkbox syntax. Commits are deferred: this repo commits only on explicit user request.

**Goal:** `Solidity source -> compiler evidence -> normalized IR -> deterministic extraction -> ReconState`, with D1-D3 schema extensions, UNKNOWN conservatism, full provenance.

**Architecture:** see `docs/recon-layer-design.md` (APPROVED, binding). Pipeline:
config -> discover -> solc standard-JSON (bundled WASM) -> IR -> ordered extractors ->
Phase-1 factories -> sort -> validateReconState -> `{state, issues}`.

**Tech Stack:** TypeScript 7 strict (`noUncheckedIndexedAccess`), zod 4, vitest 5, solc-js (WASM, no native deps), better-sqlite3 (Phase 1).

**Spec:** `docs/recon-layer-design.md` + directive guardrails (chat, 2026-10-03).

## Progress

- [x] Task 1: D1+D2 schema (9 tests)
- [x] Task 2: D3 sourceContractId (12 tests)
- [x] Task 3: config + issues + timestamp (13 tests)
- [x] Task 4: discover/security (8 tests)
- [x] Task 5: versions/pragma (29 tests)
- [x] Task 6: compileProject ladder (8 tests) — 248/248 green, tsc clean
- [ ] Tasks 7-12 pending

## Global Constraints

- Evidence over inference: no fuzzy name matching ever; unresolved -> UNKNOWN + provenance + ReconIssue.
- Syntactic fidelity never fabricates semantic relationships.
- `call_kind` preserved: internal|external|super|self-external|new on CALLS; markers `unresolved-{delegatecall,staticcall,lowlevel-call,indirect-call}` otherwise.
- Structural `contract_type` only (interface/library/unknown). No Event/Modifier/TypeDef entities, no new RelationshipType, no schema change beyond D1-D3.
- Determinism: no hidden `new Date()`/random ids; byte-identical `serializeReconState` for identical inputs.
- Security: no execution of target repo code/config/scripts; root jail; caps; compiler only from binaries.soliditylang.org with sha256; cache-only supported.
- `npx tsc --noEmit` clean after every task; Phase 1 suite (`npm test`) stays green.
- Conventional commit messages reserved for user-requested commits.

---

### Task 1: D1 + D2 schema fields

**Files:** Modify `src/domain/contract.ts` (ContractShape + `is_abstract: z.boolean().optional()`),
`src/domain/state-variable.ts` (Shape + `mutability: z.enum(['mutable','constant','immutable']).optional()`).
Test: `tests/recon/schema-d1-d2.test.ts`.

**Interfaces:** `createContract({..., is_abstract: true})` -> Contract; `createStateVariable({..., mutability: 'immutable'})` -> StateVariable. Unknown enum value -> `ReconError SchemaValidationFailed`.

- [ ] Failing tests: accept `is_abstract:false`; accept each `mutability` value; reject `mutability:'const'`; strictObject still rejects unknown keys.
- [ ] Implement, run `npx vitest run tests/recon/schema-d1-d2.test.ts` PASS.
- [ ] Run full `npm test` (Phase 1 green).

### Task 2: D3 source contract identity

**Files:** Modify `src/ids/normalize.ts` (+`normalizeSourceFile`), `src/ids/ids.ts` (+`sourceContractId`),
`src/domain/contract.ts` (id rule: address wins; else `source_file` -> `sourceContractId`; else `contractId`),
`src/recon-state/validate.ts` (same expected-id rule in `assertEntityIdentity`).
Test: `tests/recon/ids-d3.test.ts`.

**Interfaces:**
```ts
normalizeSourceFile(path: string): string  // posix-ify, lowercase, '/'->'__', '.'->'_', other ->'_'
sourceContractId(sourceFile: string, name: string): string
// e.g. sourceContractId('src/Vault.sol','Vault') === 'contract:src__vault_sol:Vault'
```
Approved example uses lowercased name segment: `contract:<normalized-file>:<lowercase-name>`.

- [ ] Failing tests: path normalization cases (`src/Vault.sol`, `lib/oz@4.8/Core.sol`, `a\\b.sol` windows sep), address precedence with source_file, validate passes for source contract, duplicate normalized id -> `DuplicateCanonicalEntity`.
- [ ] Implement; `npx vitest run tests/recon/ids-d3.test.ts` PASS; full `npm test` green.

### Task 3: config + issues + timestamp

**Files:** Create `src/recon/config.ts`, `src/recon/issues.ts`, `src/recon/timestamp.ts`.
Test: `tests/recon/config.test.ts`.

**Interfaces:**
```ts
ReconConfig = { root: string; include?: string[]; exclude?: string[]; solcVersion?: string;
  compilerSource?: 'auto'|'cache-only'; remappings?: string[]; projectName?: string;
  repository?: string; timestamp?: string; recordGit?: boolean /* default true */;
  limits?: { maxFileBytes?: number /*2MiB*/; maxFiles?: number /*5000*/; timeoutMs?: number /*60000*/ } }
parseReconConfig(raw: unknown): ReconConfig          // zod, throws ReconError InvalidConfig
ReconIssue = { severity:'FATAL'|'RECOVERABLE'|'UNKNOWN'|'UNSUPPORTED'; code: string; message: string;
  file?: string; line_start?: number; line_end?: number; count?: number }
resolveTimestamp(config): Promise<{ timestamp: string; source: 'config'|'git'|'epoch' }>
```
Epoch fallback: `1970-01-01T00:00:00Z`. Git = `execFile('git', [...])` fixed args, no shell, only when
`git rev-parse --show-toplevel` equals realpath(root).

- [ ] Failing tests: defaults, invalid root type, timestamp priority config>git>epoch (temp dirs: non-git dir -> epoch), git-root mismatch -> epoch.
- [ ] Implement -> PASS.

### Task 4: source discovery (security boundary)

**Files:** Create `src/recon/discover.ts`. Test: `tests/recon/discover.test.ts`.

**Interfaces:**
```ts
DiscoveredFile = { path: string /* repo-relative posix */, absolute: string, sha256: string, bytes: number }
discoverSources(config): Promise<{ files: DiscoveredFile[]; issues: ReconIssue[] }>
```
Rules: `.sol` only; exclude `.git/`, `node_modules/`, `.recon-cache/` + config excludes; sorted by path;
size cap (issue RECOVERABLE `file_too_large`, skip); count cap (FATAL `too_many_files` when exceeded);
path jail: reject `..`, symlink escape (realpath must stay under realpath(root)) -> FATAL `path_escape`;
read failures -> RECOVERABLE skip. sha256 via node:crypto over bytes.

- [ ] Failing tests: traversal (`../`), absolute path outside root, symlink escape (junction/symlink dir), oversized skip+issue, count cap, sorted order, sha256 correct, 0 files -> FATAL `no_sources`.
- [ ] Implement -> PASS.

### Task 5: compiler versions (pragma + pin + cache)

**Files:** Create `src/recon/backend/solc/versions.ts`. Test: `tests/recon/backend-versions.test.ts`.

**Interfaces:**
```ts
parsePragmas(source: string): string[]                       // raw pragma lines
satisfies(version: string, pragmaRange: string): boolean     // subset needed: =,^,>=,<=,>,<,&&,||,x
selectVersion(config, files): Promise<{ longVersion: string; source: 'bundled'|'cache'|'download' }>
verifyChecksum(listJsonSha256: string, bytes: Buffer): boolean
```
- Selection: available = [bundled solc version] + cached dirs under `.recon-cache/solc/`;
  config.solcVersion pins (must exist bundled/cached or download in `auto`);
  else highest available satisfying ALL pragmas; none -> FATAL `solc_version_conflict`.
- Download: https only `binaries.soliditylang.org/bin/list.json`, sha256 verify, `cache-only` never
  touches network (FATAL `compiler_unavailable`).

- [ ] Failing tests: pragma parsing (multi pragma, spaces), satisfies matrix, selection highest-common,
  conflict FATAL, checksum tamper FATAL, cache-only without cache FATAL.
- [ ] Implement -> PASS (no network needed in tests: bundled + fake cache dirs).

### Task 6: compile + SolcBackend

**Files:** Create `src/recon/backend/solc/compile.ts`, `src/recon/backend/solc/index.ts`,
`src/recon/backend/types.ts`. Test: `tests/recon/backend-solc.test.ts` (live bundled compile, offline).

**Interfaces:**
```ts
interface ParserBackend { id: string; version: string;
  parse(input: { files: DiscoveredFile[]; config: ReconConfig }): Promise<ParseResult> }
ParseResult = { ir: NormalizedProject; issues: ReconIssue[] }
```
- standard-JSON: sources by relative path, `settings: { stopAfter?: 'parsing', outputSelection:
  { '*': { '': ['ast'], '*': ['storageLayout','evm.methodIdentifiers'] } } }`, remappings from config.
- Full compile; on severity:'error' -> retry once with `stopAfter:'parsing'` (fidelity 'syntactic');
  if parse-stage errors remain -> failed files dropped + RECOVERABLE `compilation_failed` (with solc
  message + line if `sourceLocation`), others kept; zero surviving sources -> FATAL.
- Import callback reads ONLY inside root (jail re-check) -> outside -> compile error surfaced.
- solc-js uses bundled `soljson` when selected version == package version; `loadRemoteVersion` +
  disk cache otherwise (network only in auto mode).

- [ ] Failing tests: live compile of tiny fixture (semantic fidelity, ast present, methodIdentifiers
  present, storageLayout present), broken-semantic fixture -> syntactic retry success + issue,
  syntax-broken fixture -> RECOVERABLE drop, import escaping root -> dropped+FATAL policy,
  output ordering deterministic.
- [ ] Implement -> PASS.

### Task 7: normalized IR + builder

**Files:** Create `src/recon/ir/types.ts`, `src/recon/ir/build.ts`, `src/recon/ir/line-map.ts`.
Test: `tests/recon/ir-build.test.ts` (compiled fixtures + direct AST unit cases).

**Interfaces:** types per design §4 (`NormalizedProject`, `ContractIR`, `FunctionIR`, `StateVarIR`,
`CallSite`, `StorageAccess`, `Span`, `EventIR`, `CustomErrorIR`, `ModifierInvocationIR`).
```ts
buildIr(parse: SolcOutputLike, files: DiscoveredFile[], fidelity): { ir: NormalizedProject; issues: ReconIssue[] }
lineMap(content: Buffer): (byteOffset: number) => number   // UTF-8 byte-accurate, 1-based
```
- AST walk: SourceUnit -> ContractDefinition (kind/abstract/linearizedBaseContracts/nodes),
  FunctionDefinition (all kinds, modifiers w/ args byte-slice, visibility, stateMutability,
  params/returns via typeDescriptions.typeString normalization), VariableDeclaration state vars
  (mutability, slot via storageLayout astId map), EventDefinition/ErrorDefinition headers,
  body walk collecting CallSite + StorageAccess with referencedDeclaration targets
  (`fqn` = `file.sol:Contract` -> IR ref), builtin skip-list (require, assert, revert, keccak256,
  sha256, ripemd160, ecrecover, blockhash, gasleft, addmod, mulmod, selfdestruct, suicide, type, abi.*).
- call kind classification: bare Identifier -> internal; MemberAccess `super` -> super; `this` ->
  self-external; address members call/delegatecall/staticcall/send/transfer -> lowlevel family;
  `new` (NewExpression) -> new (target constructor ref); indirect (function-typed var) -> UNKNOWN marker.
- `fidelity:'syntactic'` -> referencedDeclaration may be missing: keep CallSite with `resolvedRef: undefined`.

- [ ] Failing tests: byte->line mapping incl. multibyte before span; contract/function/statevar IR;
  selector from methodIdentifiers; canonical internal signature normalization (strip `contract `);
  call-kind classification matrix; storage ops (assign/compound/++/mapping root/read);
  syntactic mode leaves resolvedRef undefined.
- [ ] Implement -> PASS.

### Task 8: entity extractors (contracts, functions, state vars, inheritance, modifiers)

**Files:** Create `src/recon/extract/types.ts` (StatePatch), `extract/contracts.ts`, `extract/functions.ts`,
`extract/state-variables.ts`, `extract/inheritance.ts`, `extract/modifiers.ts`, `extract/index.ts`
(ordered registry + merge + dedupe). Test: `tests/recon/extract-entities.test.ts`.

**Interfaces:**
```ts
StatePatch = { contracts: Contract[]; functions: Function[]; state_variables: StateVariable[];
  relationships: Relationship[]; facts: Fact[]; issues: ReconIssue[] }
type Extractor = (ctx: { ir: NormalizedProject; config: ReconConfig; provenance: ProvenanceFactory }) => StatePatch
```
- contracts: kind->contract_type (interface/library/unknown), `is_abstract` (D1), `source_file`,
  `compiler_version` (ir.compiler.longVersion), `source` = `file:startLine-endLine` via span.
- functions: signature/selector from methodIdentifiers (public/external only), kind names
  constructor/fallback/receive, `modifiers[]` canonical text, `source` span string.
- state vars: type/visibility/mutability (D2)/slot from IR, `source` span.
- inheritance: linearized bases -> `IMPLEMENTS` (interface base) / `INHERITS` edges contract->contract;
  base outside source set -> UNKNOWN issue `base_outside_sources`, no edge.
- modifiers: merged into functions extractor output (invocation text only).
- every relationship gets >=1 source_code provenance (file+lines from span; repository/commit from
  git context when available).

- [ ] Failing tests per rule (incl. abstract direct-from-AST, interface->interface classification,
  internal function has no selector, constructor signature, modifier args text collapsed, diamond
  inheritance edges, interface base -> IMPLEMENTS).
- [ ] Implement -> PASS.

### Task 9: call/storage/event-error extractors (UNKNOWN discipline)

**Files:** Create `extract/calls.ts`, `extract/storage-access.ts`, `extract/event-error-facts.ts`.
Test: `tests/recon/extract-calls.test.ts`, `tests/recon/extract-unknown.test.ts`.

**Interfaces:** StatePatch as above. Outputs:
- CALLS with `metadata.call_kind` for resolved internal/external/super/self-external/new
  (new -> constructor Function entity); edge dedupe: one relationship per (type,source,target),
  merged provenance spans.
- unresolved families -> Fact markers (`predicate: CALLS` or `DELEGATES_TO` for delegatecall,
  `value: 'unresolved-lowlevel-call' | 'unresolved-staticcall' | 'unresolved-delegatecall' |
  'unresolved-indirect-call'`) + UNKNOWN issue (aggregated count per category, one issue per file+category).
- READS/WRITES merged edges with multi-span provenance.
- EMITS facts (canonical event signature from referenced EventDefinition) +
  `USES` facts `custom-error:<signature>`; require/revert strings skipped.
- syntactic mode: no semantic relationships from names -> all call sites unresolved markers.

- [ ] Failing tests: call-kind matrix via live-compiled fixture; `this`/`super`/`new` targets;
  delegatecall marker + issue; abi.encodeWithSignature call -> lowlevel marker, NO fuzzy match even
  when matching signature exists in repo; compound storage read+write; EMITS fact provenance line;
  custom-error fact; syntactic fixture produces zero CALLS edges.
- [ ] Implement -> PASS.

### Task 10: assembly + analyzeProject entry

**Files:** Create `src/recon/build.ts`, `src/recon/index.ts`. Test: `tests/recon/analyze.test.ts`.

**Interfaces:**
```ts
AnalysisResult = { state: ReconState; issues: ReconIssue[]; meta: { solcLongVersion: string;
  timestamp: string; fidelity: 'semantic'|'syntactic'; fileCount: number } }
analyzeProject(config: ReconConfig): Promise<AnalysisResult>
```
- Steps: parse config -> timestamp -> git context (commit only when toplevel==root) -> discover ->
  select+compile -> buildIr -> extractors (fixed order) -> merge (project entity with
  created_at=timestamp; deterministic sorts by id) -> `createReconState` (omit top-level provenance;
  validator derives) -> FATAL on validation failure (bug).
- issues sorted (severity, code, file, line) before return.

- [ ] Failing tests: end-to-end fixture returns validate-clean state; project created_at deterministic;
  two runs byte-identical `serializeReconState`; shuffled discovery (reversed include order) identical;
  `createReconState`-derived provenance registry exact.
- [ ] Implement -> PASS.

### Task 11: persistence idempotency + Vault E2E + security/error matrix

**Files:** Test: `tests/recon/idempotency.test.ts`, `tests/recon/vault-e2e.test.ts`,
`tests/recon/security.test.ts`, `tests/recon/error-matrix.test.ts`; fixtures under `fixtures/solidity/**`.

- idempotency: `saveState(state)` twice on fresh sqlite file -> row counts unchanged (reuse Phase-1
  repository test harness patterns).
- Vault E2E: multi-file fixture (Vault is ERC4626-like, interface + library + modifiers + events +
  custom error + delegatecall to strategy + low-level call) asserting the §25 report expectations:
  ids, selectors, IMPLEMENTS/INHERITS, call_kind matrix, READS/WRITES, EMITS facts, unresolved marker,
  provenance lines, issues summary.
- security: `../` traversal, absolute escape, symlink escape, oversized, count cap, checksum tamper
  (Task 5 units), cache-only, malformed Solidity, partial compilation failure -> RECOVERABLE.
- error matrix: >=1 test per FATAL/RECOVERABLE/UNKNOWN/UNSUPPORTED class.

- [ ] Implement tests -> PASS.

### Task 12: verification + documentation

- [ ] `npm test` (full suite incl. Phase 1) PASS.
- [ ] `npx tsc --noEmit` clean.
- [ ] Coverage: `npx vitest run --coverage` (add `@vitest/coverage-v8` dev dep if missing) —
  `src/recon/**` >= 80%.
- [ ] Determinism + idempotency results captured.
- [ ] Update `docs/recon-layer-design.md` "Known limitations" + add `docs/phase2-dod.md` evidence
  (test counts, coverage, results) mirroring Phase-1 DoD doc style.
- [ ] Fabrication review: grep for name-matching heuristics, `new Date(`, `Math.random`, unprovenanced
  relationship/fact construction; confirm NONE.
- [ ] Report 16-point summary to user.
