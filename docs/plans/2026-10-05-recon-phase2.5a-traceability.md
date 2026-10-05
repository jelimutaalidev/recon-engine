# Phase 2.5-A — Recon Traceability & Auditability Foundation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deterministic Recon pipeline auditable by adding first-class ReconRun, identity records, per-extractor Derivation lineage, output lineage, trace status, and bounded trace queries — without altering Phase 1–2 hash, ID, or provenance semantics.

**Architecture:** A dedicated `src/traceability/` layer (types → identities → build → service) hangs off an optional `traceability` section on `ReconState` (runs, derivations, outputs), persisted additively via migration `003` inside the existing `saveState`/`loadState` round trip. `analyzeProject` attaches one COMPLETED run with one Derivation per extractor that emitted material outputs; a read-only `TraceabilityService` answers Q1–Q10 over the loaded state with depth-bounded (default 5), cycle-safe traversals.

**Tech Stack:** TypeScript (strict), zod (strictObject schemas), better-sqlite3 (migration files auto-discovered, checksummed), node:crypto sha256, vitest + @vitest/coverage-v8, solc-js 0.8.37 (bundled, offline).

**Spec:** `docs/TRACEABILITY_SPEC.md` (Status: Proposed; 28 sections — §3 layers, §4–§11 model, §12 object requirements, §14–§15 traversal, §16 queries Q1–Q10, §17 invariants T1–T10, §18 stable IDs, §19 persistence, §20 determinism, §21 security, §22 error semantics, §26 DoD, §28 architectural principle). Also: `docs/recon-layer-design.md`, `docs/phase2-dod.md`.

---

## Repository Audit & Implementation Assessment (spec §3 requirement, before any code)

### Existing infrastructure (reuse, do not reinvent)

- **Source hashing (Layer 1):** authoritative formula lives in `src/recon/ir/build.ts` (`compiler.sourceHash` = sha256 over path-sorted `path:sha256` lines joined `\n`); per-file sha256/bytes on `DiscoveredFile` (`src/recon/discover.ts`). Not persisted in ReconState — exposed via `AnalysisResult`/IR only.
- **Stable IDs & canonicalization:** `src/ids/ids.ts` `contentId(prefix, payload)` = `prefix:<sha256(stableStringify(payload)).slice(0,16)>`; `src/util/canonical.ts` `stableStringify` / `sortedIds`.
- **Provenance (Layer 3):** `src/epistemic/provenance.ts` (`source_type:'source_code'`, `file`, `line_start/end`, `repository?`, `commit?`); factory in `src/recon/extract/types.ts` fed from git context (`src/recon/git.ts`, `resolveGitContext`/`resolveProjectRepository` in `src/recon/build.ts`). Authoritative — never replaced by traceability.
- **Persistence:** `migrations/001_initial.sql`, `002_phase2_extraction_fields.sql` (checksum-immutable once applied — `src/repository/migrate.ts`); flat-row + JSON-column mappers (`src/repository/mappers.ts`); `saveState(state)` / `loadState()` in `sqlite.ts` write/read inside one transaction with `setMeta` bookkeeping.
- **Pipeline hooks:** `buildState` (`src/recon/build.ts:54`) assembles the final entity lists and calls `createReconState`; `analyzeProject` (`src/recon/index.ts:23`) has `discovered.files` (manifest), `compiled.longVersion`, `resolved timestamp`, git context — everything identities need.
- **Extractor seams:** `EXTRACTORS` + `runExtractors` (`src/recon/extract/index.ts`) already map one function → one `StatePatch`; per-extractor outputs are recoverable by running the registry entry-wise.
- **Bounded traversal pattern:** `src/relationships/graph.ts` frontier BFS with `depth <= 0` cutoff — precedent for cycle-safe bounded queries.
- **Validation framework:** `src/recon-state/validate.ts` `validateReconState` pushes typed `issues[]` and throws `InvalidReconState` — insertion point for trace invariants.
- **Deterministic time/git:** `resolveTimestamp(config)` (injected `config.timestamp`, no wall-clock in state), git helpers normalized vs. toplevel (`src/recon/git.ts`).
- **Distinct error semantics:** `ReconErrorCode` union (`src/errors/errors.ts`) already carries `EntityNotFound` (→ NOT_FOUND), `InvalidReconState`, and Phase-2 UNSUPPORTED/UNKNOWN issue codes.

### Required additions (nothing else)

- `src/traceability/{types,identities,build,service,index}.ts` — model (zod), identity builders, pipeline lineage builder, query service.
- `src/version.ts` — `ANALYZER_VERSION` constant (synced to `package.json` by test).
- `src/recon/source-hash.ts` — `computeSourceHash` extracted from `ir/build.ts` (behavior-identical; reused by identities).
- `migrations/003_traceability.sql` — tables `runs`, `derivations`, `run_outputs`.
- Optional `traceability` key on `ReconStateSchema` + `serializeReconState(state, { omitTraceability })` option + `assertTraceability` in `validate.ts`.
- Repository: row types + save/load wiring in `mappers.ts` / `sqlite.ts`.
- Pipeline wiring: `runExtractorsWithLineage`, `BuildStateInput` gains `{files, solcLongVersion, fidelity}`, `buildState` attaches traceability.
- Tests: `tests/traceability/*.test.ts` (8 files, mapped to tasks below).
- Docs: `docs/traceability.md` (single canonical doc; no duplicate roadmap exists to update).

### Potential schema-migration conflicts (documented, not silent — spec §31 of the briefed scope)

1. **`ReconState` gains a key.** Prior plan constraint said "no schema change beyond D1–D3". `TRACEABILITY_SPEC` outranks it (§19 requires the round trip to survive `saveState`→`loadState`). Resolution = additive **optional** `traceability` key; `schema_version` stays `recon-state/v1`; states without it keep validating byte-identically. Migration `003` is purely additive; `001`/`002` never edited (checksum enforcement).
2. **Fact "run identity" (spec §12) vs. no-entity-schema-change.** Smallest compatible solution: run attribution lives in the traceability layer (`derivations.outputs` → `run_id`, `run_outputs` rows), not as a new column on Fact/Relationship/etc. Entity schemas untouched; `getRun(objectId)` answers §12/§16-Q3. Documented as a resolution in `docs/traceability.md`.
3. **Serialize output grows a key** when traceability is present. Default behavior of `serializeReconState` for trace-less states is unchanged (Phase-1/2 tests stay green); `omitTraceability` is required for `output_hash` recomputation (no circularity).
4. **`saveState` on a re-saved identical state:** runs/derivations use `ON CONFLICT(id) DO UPDATE` (content deterministic, timestamps metadata) so idempotent saves don't blow up PKs; test pins save-twice → one run row.

### Compatibility constraints

- `SUPPORTED_SCHEMA_VERSIONS = ['recon-state/v1']` unchanged; `saveState(state: ReconState): void` / `loadState(): ReconState | null` signatures unchanged.
- Existing 312 tests (Phase 1: 169, Phase 2: 143) must stay green; `npx tsc --noEmit` clean after every task.
- No new runtime dependencies; traceability module does **zero** filesystem/network/process execution (spec §21) — reads only the in-memory `ReconState`, same trust level as `GraphIndex`.
- Branch `feat/recon-phase2` stays **frozen for merge** (user directive): continue committing here, do not merge to `main`.
- Conventional commits, one per task; full suite + tsc before each commit.

---

## Global Constraints

- Schema identifier: `recon-state/v1` (unchanged). Traceability = dedicated audit/lineage layer referencing existing IDs; do not redesign Phase 1–2 architecture, hashing, stable IDs, or provenance.
- Canonical source hash (authoritative): sha256 over path-sorted `path:sha256(file)` lines joined `\n`.
- Deterministic identity (spec §2.3): no random values, wall-clock time, PIDs, machine-specific temp paths, or non-canonical iteration order in any canonical ID/hash. `Math.random`/`Date.now`/UUID are banned in `src/traceability/**`.
- Identity schemes: run id = `run:<digest16>` via `contentId('run', payload)`; derivation id = `derivation:<run-id>:<operation>:<canonical-input-digest16>` (spec §18); no timestamps/random values inside any id.
- `config_hash` excludes `root` (machine path); timestamps are execution metadata (spec §4.1) and are excluded from `run_id`, `derivationId`, and `input_manifest_hash`.
- Traversals bounded: default depth **5**, cycle-safe (visited set), return `truncated` flag; never unbounded recursion.
- Material outputs (derivations/outputs/status cover exactly): Contract, Function, StateVariable, Relationship, Fact. Observation/Assumption/Hypothesis/Evidence → `NOT_APPLICABLE` (never fabricated lineage, spec §12).
- Error classes stay distinct (spec §22): `UNKNOWN`/`UNSUPPORTED` → existing issue codes; `NOT_FOUND` → `ReconError('EntityNotFound')`; `INCOMPLETE_TRACE` → explicit `TraceStatus`/`findIncompleteTraces` (never silently passes validation); `FAILED` → `DerivationStatus`/`ReconRunStatus` values. No new error codes unless a task below names them.
- Migrations additive only; never modify `001`/`002`.
- Scope exclusions (spec §27): no vulnerability detection, exploit/PoC generation, severity, LLM reasoning, agents, RAG, vector DB, learning, attack simulation, evaluation datasets.
- Verification contract per task: `npx vitest run` (full suite) + `npx tsc --noEmit`, then commit.

## Review Focus

Failure modes the spec implies but no single task naturally catches — each pinned to its owning task:

1. **`output_hash` circularity** (state hash changing because traceability was attached): Task 3 test `output identity excludes traceability` — same entity set with and without a `traceability` section produces identical `output_hash`; recomputing from a loaded state matches the stored value.
2. **Machine path leakage into identities** (spec §7/§2.3): Task 3 test `config hash excludes root` — two configs differing only in `root` (different temp dirs, same basename) yield equal `config_hash`, `input_manifest_hash`, and run id.
3. **Determinism of the whole trace** (spec §20/T9): Task 5 test `traceability is deterministic` — two `analyzeProject` calls with identical config yield byte-identical `serializeReconState` (incl. traceability) and identical run/derivation IDs.
4. **Cross-run isolation T10 + historical liveness** (spec §17/§19): Task 8 tests — same entity id produced by historical run A and current run B: `getRun` resolves to the current run, backward trace resolves only current-run derivations, and run A's output refs to entities no longer in the current collections still resolve via `run_outputs` (not flagged orphaned, not rejected at load).
5. **Traversal termination** (spec §16 Q10, bounded default 5): Task 6 test `cycle and depth limit` — synthetic A↔B derivation cycle returns with `visited` deduped and no hang; 8-link chain at depth 5 returns `truncated: true`.
6. **Legacy-state behavior / T8 explicit incompleteness** (spec §19/T8): Task 2 test `state without traceability round-trips` — pre-2.5 state loads with no `traceability` key and no validation error; Task 6 test `missing lineage is explicit` — material entity with no derivations reports `MISSING`, never `COMPLETE` and never throws.

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `src/traceability/types.ts` | zod schemas + TS types for TraceabilityState, ReconRun, identities, Derivation, TraceReference, RunOutputRecord, TraceStatus/RunStatus/DerivationStatus, service-facing result types. |
| `src/traceability/identities.ts` | Pure identity builders: source, manifest, config, input-manifest, output, run/derivation IDs, entity content hash. |
| `src/traceability/build.ts` | `buildTraceability(...)` — turns pipeline artifacts into `TraceabilityState` (run + per-extractor derivations + output records). |
| `src/traceability/service.ts` | `createTraceabilityService(state)` — Q1–Q10 queries, trace status, bounded traversals. |
| `src/traceability/index.ts` | Barrel re-exports (public surface). |
| `src/version.ts` | `ANALYZER_VERSION` constant. |
| `src/recon/source-hash.ts` | `computeSourceHash` (extracted formula, single source of truth). |
| `migrations/003_traceability.sql` | Additive tables: `runs`, `derivations`, `run_outputs` (+ indexes, FKs to `runs`). |
| `tests/traceability/schema.test.ts` | Task 1 — model, serialization option, validation rules. |
| `tests/traceability/persistence.test.ts` | Task 2 — save/load round trip, legacy state, corruption rejection, idempotent re-save. |
| `tests/traceability/identities.test.ts` | Task 3 — identity builders, exclusions, determinism, version sync. |
| `tests/traceability/lineage.test.ts` | Task 4+5 — extractor registry lineage + pipeline wiring. |
| `tests/traceability/service.test.ts` | Task 6 — queries, status, bounded/cycle traversal. |
| `tests/traceability/compare.test.ts` | Task 7 — compareRuns matrix. |
| `tests/traceability/integrity.test.ts` | Task 8 — orphan/incomplete/cross-run/versioned/historical provenance. |
| `tests/traceability/e2e.test.ts` | Task 9 — vault fixture, §26 traversal DoD, save→load→query. |
| `docs/traceability.md` | Task 10 — architecture, identity formulas, status semantics, query catalog, security, limitations. |

**Modify:** `src/recon-state/schema.ts` (optional `traceability` key), `src/recon-state/state.ts` (`serializeReconState` option), `src/recon-state/validate.ts` (`assertTraceability`), `src/repository/migrations` consumers `src/repository/mappers.ts` + `src/repository/sqlite.ts` (save/load trace rows), `src/recon/extract/index.ts` (named registry + `runExtractorsWithLineage`), `src/recon/build.ts` (`BuildStateInput`/`buildState` wiring), `src/recon/index.ts` (pass files/solcLongVersion/fidelity), `src/recon/ir/build.ts` (call extracted `computeSourceHash`).

**Unchanged:** `src/epistemic/provenance.ts`, ID semantics in `src/ids/ids.ts` (only `ContentIdPrefix` gains `'run' | 'out'` if `contentId` is reused for run ids — pin in Task 3), migrations `001`/`002`, `SUPPORTED_SCHEMA_VERSIONS`.

---

## Tasks

### Task 1: Traceability model — types, ReconState integration, validation

**Files:**
- Create: `src/traceability/types.ts`
- Modify: `src/recon-state/schema.ts` (after line 35 `provenance` entry), `src/recon-state/state.ts` (`serializeReconState`), `src/recon-state/validate.ts` (new `assertTraceability` called from `validateReconState`)
- Test: `tests/traceability/schema.test.ts`

**Interfaces:**
- Consumes: existing `ReconStateSchema`, `stableStringify`, issue-push pattern in `validate.ts`.
- Produces (exact — later tasks depend on these):

```ts
// src/traceability/types.ts
export type TraceStatus = 'COMPLETE' | 'PARTIAL' | 'MISSING' | 'NOT_APPLICABLE';
export type ReconRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';
export type DerivationStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED';

export interface TraceReference { entity_type: string; entity_id: string }

export interface SourceIdentity {
  source_hash: string; manifest_hash: string;
  repository?: string; commit?: string; source_root?: string;
}
export interface CompilerIdentity { compiler: string; version: string; binary_hash?: string; backend: string }
export interface ConfigurationIdentity { config_hash: string }
export interface OutputIdentity { output_hash: string; serialization: string }

export interface ReconRun {
  id: string; project_id: string; schema_version: string; analyzer_version: string;
  started_at: string; completed_at?: string; status: ReconRunStatus;
  source_identity: SourceIdentity; compiler_identity: CompilerIdentity;
  configuration_identity: ConfigurationIdentity; input_manifest_hash: string;
  output_identity?: OutputIdentity;
}
export interface Derivation {
  id: string; run_id: string; operation: string; operation_version: string;
  inputs: TraceReference[]; outputs: TraceReference[]; provenance: string[];
  status: DerivationStatus; metadata?: Record<string, unknown>;
}
export interface RunOutputRecord { run_id: string; entity_type: string; entity_id: string; content_hash: string }
export interface TraceabilityState { runs: ReconRun[]; derivations: Derivation[]; outputs: RunOutputRecord[] }

export type MATERIAL_ENTITY_TYPE = 'contract' | 'function' | 'state_variable' | 'relationship' | 'fact';
export const MATERIAL_ENTITY_TYPES: readonly MATERIAL_ENTITY_TYPE[];
```

Also: matching zod schemas (`TraceabilitySchema` etc., all `strictObject`), and `serializeReconState(state: ReconState, options?: { omitTraceability?: boolean }): string` (option default `false`; when omitting, drop the `traceability` key from the canonical object; otherwise include it with collections sorted by id, outputs sorted by `(run_id, entity_type, entity_id)`).

Validation rules (`assertTraceability`, no-op when `state.traceability === undefined`):
- unique `runs[].id`, `derivations[].id`; every `derivation.run_id` exists in `runs` (T3).
- `outputs` unique on `(run_id, entity_type, entity_id)`; `entity_type` ∈ `MATERIAL_ENTITY_TYPES` (run_outputs records material entities only — source files are covered by derivation inputs/provenance, not output lineage).
- **Current run** = run whose `output_identity.output_hash` equals `sha256(serializeReconState(state, { omitTraceability: true }))` over the UTF-8 bytes of that exact JSON string (skip strict phase if no match — legacy state). For the current run only: (a) every derivation output ref resolves to a material entity in the state (T1), (b) every derivation input ref (`entity_type:'source_file'`) resolves to a file present in the **union of the top-level `state.provenance[].file` registry and entity-embedded provenance records** (`collectProvenance(state)` — Phase-1 pipeline states legitimately leave the registry empty and embed provenance on entities; resolving against the registry alone would reject every pipeline-built state and force a semantic change to `buildState` output), and (c) **every material entity in the state is covered by ≥1 current-run derivation output** (T2).
- Historical-run refs are structurally validated only (resolved by `run_outputs` at query time — see Task 8).
- IMPORTANT for this task's tests: `computeOutputIdentity` from Task 3 does not exist yet — compute the current-run hash in tests inline with `node:crypto` `createHash('sha256').update(serializeReconState(state, { omitTraceability: true })).digest('hex')`.

- [ ] **Step 1: Write the failing tests** — `tests/traceability/schema.test.ts`:
  - `accepts state with traceability section` — `createReconState` with one run/derivation/output fixture returns it unchanged.
  - `rejects unknown keys inside traceability` — extra key under `runs[0]` throws `ReconError('SchemaValidationFailed')`.
  - `rejects derivation whose run_id does not exist` — `InvalidReconState` with issue check `'traceability'`.
  - `allows state without traceability` — unchanged legacy fixture validates and `serializeReconState` output equals pre-change snapshot (string compare against a `JSON.stringify` of the same canonical object without the key).
  - `serialize omits traceability when requested` — `serializeReconState(state, { omitTraceability: true })` has no `'traceability'` substring; default call does.
  - `outputs are canonically sorted` — shuffled inputs serialize to one fixed string (pin literal in test).
- [ ] **Step 2: Run to verify failures** — `npx vitest run tests/traceability/schema.test.ts` → FAIL (module not found / missing key).
- [ ] **Step 3: Implement** — types + schemas in `src/traceability/types.ts`; add `traceability: TraceabilitySchema.optional()` to `ReconStateSchema`; extend `serializeReconState`; add `assertTraceability` and call it in `validateReconState` after `assertReferentialIntegrity`.
- [ ] **Step 4: Run tests to verify pass** — `npx vitest run tests/traceability/schema.test.ts` → PASS.
- [ ] **Step 5: Verify contract** — `npx vitest run` full suite green (312+4), `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `feat(traceability): add trace model, recon-state integration, and validation`

### Task 2: Migration 003 + repository persistence round trip

**Files:**
- Create: `migrations/003_traceability.sql`
- Modify: `src/repository/mappers.ts`, `src/repository/sqlite.ts` (`saveState` after the evidence loop; `loadState` before return)
- Test: `tests/traceability/persistence.test.ts`

**Interfaces:**
- Consumes: `TraceabilityState`/row-mapping conventions from Task 1; existing `migrate()` auto-discovery (sorted `.sql`, checksum-immutable).
- Produces: `saveState`/`loadState` signatures unchanged; `state.traceability` survives the round trip.

`003_traceability.sql` (exact):

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  compiler_identity TEXT NOT NULL,
  configuration_identity TEXT NOT NULL,
  input_manifest_hash TEXT NOT NULL,
  output_identity TEXT
);
CREATE TABLE IF NOT EXISTS derivations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  operation TEXT NOT NULL,
  operation_version TEXT NOT NULL,
  inputs TEXT NOT NULL,
  outputs TEXT NOT NULL,
  provenance TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_derivations_run ON derivations(run_id);
CREATE INDEX IF NOT EXISTS idx_derivations_operation ON derivations(operation, operation_version);
CREATE TABLE IF NOT EXISTS run_outputs (
  run_id TEXT NOT NULL REFERENCES runs(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_run_outputs_entity ON run_outputs(entity_id);
```

Identity/structured fields stored as JSON columns (`JSON.parse`/`JSON.stringify` in mappers). Re-save follows the repository's established pattern (same as `createContract`/`persistProvenance`): `findRow` → if exists, `assertSameContent` on all deterministic fields and skip (derivations/outputs: plain find+skip; **runs**: verify identity fields match, then `UPDATE started_at, completed_at, status` — timestamps are execution metadata, mutable under the same run id per spec §4.1); divergent content under an existing id throws. All inside the existing `saveState` transaction. `loadState` reads the three tables `ORDER BY id` and attaches `traceability` only when ≥1 run row exists.

- [ ] **Step 1: Write the failing tests** — `tests/traceability/persistence.test.ts`:
  - `save/load preserves full traceability` — fixture state (1 run + 2 derivations + 3 outputs) through `saveState` → `loadState` deep-equals (identities, derivation inputs/outputs/provenance spans, statuses).
  - `state without traceability round-trips unchanged` — legacy fixture: loaded state has `traceability === undefined`, no error (Review Focus #6).
  - `corrupted current-run reference is rejected on load` — derivation output ref → nonexistent entity, with `output_identity.output_hash` computed inline (node:crypto, same formula as Task 1 validation): `loadState` throws `InvalidReconState`.
  - `idempotent re-save stores one run` — `saveState(state)` twice → `SELECT COUNT(*) FROM runs` = 1, derivations count unchanged, no error; re-save with a different `started_at` under the same run id updates the timestamp; re-save with divergent derivation content (same id, different provenance array) throws `ReconError`.
- [ ] **Step 2: Run to verify failures** — `npx vitest run tests/traceability/persistence.test.ts` → FAIL (tables/columns missing).
- [ ] **Step 3: Implement** — `003_traceability.sql`; `RunRow`/`DerivationRow`/`RunOutputRow` + converters in `mappers.ts`; save/load wiring in `sqlite.ts`.
- [ ] **Step 4: Run tests to verify pass** — same path → PASS.
- [ ] **Step 5: Verify contract** — full `npx vitest run` + `npx tsc --noEmit` (old DBs still migrate: fresh tmp DB exercises `001→002→003`).
- [ ] **Step 6: Commit** — `feat(traceability): persist runs, derivations, and output lineage`

### Task 3: Identity builders — version constant, source-hash extraction, hashes

**Files:**
- Create: `src/version.ts`, `src/recon/source-hash.ts`, `src/traceability/identities.ts`
- Modify: `src/recon/ir/build.ts` (replace inline formula with `computeSourceHash` call), `src/ids/ids.ts` (extend `ContentIdPrefix` with `'run'`)
- Test: `tests/traceability/identities.test.ts`

**Interfaces:**
- Consumes: `stableStringify`, `contentId`, `ReconConfig`, discovered-file shape `{ path, sha256, bytes }`, `serializeReconState(state, { omitTraceability: true })`.
- Produces:

```ts
// src/version.ts
export const ANALYZER_VERSION = '0.1.0';

// src/recon/source-hash.ts
export function computeSourceHash(files: readonly { path: string; sha256: string }[]): string;

// src/traceability/identities.ts
export function computeManifestHash(files: readonly { path: string; sha256: string; bytes: number }[]): string;
export function computeConfigHash(config: ReconConfig): string;            // stableStringify(config minus root)
export function computeCompilerIdentity(longVersion: string, binarySha256?: string): CompilerIdentity;
   // { compiler: 'solc', version: longVersion, backend: 'solc-js', ...(binarySha256 && { binary_hash: `sha256:${binarySha256}` }) }
export function computeSourceIdentity(
  files: readonly { path: string; sha256: string; bytes: number }[],
  git: { repository?: string; commit?: string },
  sourceRoot: string,                       // basename(config.root)
): SourceIdentity;
export function computeInputManifestHash(p: {
  sourceIdentity: SourceIdentity; configHash: string; compilerIdentity: CompilerIdentity;
  analyzerVersion: string; schemaVersion: string;
}): string;                                 // sha256(stableStringify(p)) — NO timestamps
export function createRunId(p: { /* same payload shape as input manifest */ ... }): string; // contentId('run', p)
export function derivationId(runId: string, operation: string,
  inputs: readonly TraceReference[], provenance: readonly string[]): string;
   // `derivation:${runId}:${operation}:${sha256(stableStringify({ inputs: sorted, provenance: sorted })).slice(0,16)}`
export function entityContentHash(entity: unknown): string;               // sha256(stableStringify(entity))
export function computeOutputIdentity(state: ReconState): OutputIdentity;
   // { output_hash: sha256(serializeReconState(state, { omitTraceability: true })), serialization: 'recon-state-json/v1' }
```

- [ ] **Step 1: Write the failing tests** — `tests/traceability/identities.test.ts`:
  - `source hash formula matches pinned value` — 2-file fixture: exact sha256 literal (recomputed from the documented `path:sha256` join) AND equals `buildIr(...).compiler.sourceHash` (regression against extraction refactor).
  - `output identity excludes traceability` — same entities ± `traceability` section → identical `output_hash`; recompute from loaded state matches (Review Focus #1).
  - `config hash excludes root` — configs differing only in `root` → equal `config_hash`, `input_manifest_hash`, `createRunId` (Review Focus #2); differing `includes` → different hash.
  - `manifest hash is order independent` — shuffled file list → equal hash.
  - `derivation id deterministic and sensitive` — same args → same id; changed operation or input ref → different id; matches regex `^derivation:run:[0-9a-f]{16}:extract\.[a-z_]+:[0-9a-f]{16}$`.
  - `run id excludes timestamps` — payload identical except `started_at` → equal run id (spec §20).
  - `analyzer version matches package.json` — read `package.json` in test, assert equality with `ANALYZER_VERSION`.
  - `compiler identity binary hash formatting` — with/without sha256 → `undefined` vs `'sha256:<hex>'`.
- [ ] **Step 2: Run to verify failures** → FAIL (modules missing).
- [ ] **Step 3: Implement** — the four files; refactor `ir/build.ts` to call `computeSourceHash`; extend `ContentIdPrefix`.
- [ ] **Step 4: Run tests to verify pass** → PASS.
- [ ] **Step 5: Verify contract** — full suite (existing `sourceHash` test in `tests/recon/*` must stay green) + tsc.
- [ ] **Step 6: Commit** — `feat(traceability): deterministic identity builders and source-hash extraction`

### Task 4: Extractor operation registry + lineage-aware runner

**Files:**
- Modify: `src/recon/extract/index.ts`
- Test: `tests/traceability/lineage.test.ts` (this task's cases; Task 5 appends more)

**Interfaces:**
- Consumes: existing `Extractor` / `ExtractorContext` / `StatePatch`.
- Produces:

```ts
export interface NamedExtractor { operation: string; run: Extractor }
export const EXTRACTORS: readonly NamedExtractor[];
export function runExtractorsWithLineage(ctx: ExtractorContext):
  { patch: StatePatch; perExtractor: { operation: string; patch: StatePatch }[] };
export function runExtractors(ctx: ExtractorContext): StatePatch;   // = runExtractorsWithLineage(ctx).patch
```

Operation strings (pinned, T6-versionable via `operation_version`): `extract.contracts`, `extract.functions`, `extract.state_variables`, `extract.inheritance`, `extract.calls`, `extract.storage_access`, `extract.event_error_facts`.

- [ ] **Step 1: Write the failing tests** — `tests/traceability/lineage.test.ts`:
  - `lineage runner reports per-extractor patches` — vault IR fixture → 7 entries, each `operation` matches the pinned list, union of material entities equals `runExtractors(ctx)` result (no divergence between lineage and merged patch).
  - `existing runner behavior unchanged` — `runExtractors` returns a merged `StatePatch` identical (stableStringify) to `runExtractorsWithLineage(ctx).patch` on the vault fixture.
- [ ] **Step 2: Run to verify failures** → FAIL (`runExtractorsWithLineage` undefined).
- [ ] **Step 3: Implement** — registry + runner; `runExtractors` delegates.
- [ ] **Step 4: Run tests to verify pass** → PASS; existing 3 extractor test files still green.
- [ ] **Step 5: Verify contract** — full suite + tsc.
- [ ] **Step 6: Commit** — `feat(traceability): named extractor registry with per-extractor lineage`

### Task 5: buildTraceability + pipeline wiring

**Files:**
- Create: `src/traceability/build.ts`, re-export in `src/traceability/index.ts`
- Modify: `src/recon/build.ts` (`BuildStateInput`, `buildState`), `src/recon/index.ts` (pass `discovered.files`, `compiled.longVersion`, `compiled.fidelity`)
- Test: `tests/traceability/lineage.test.ts` (append)

**Interfaces:**
- Consumes: Task 3 builders, Task 4 `runExtractorsWithLineage`, `ANALYZER_VERSION`, `buildState`'s existing inputs (`config`, `git`, `repository`, `timestamp`, `patch`).
- Produces:

```ts
// src/traceability/build.ts
export function buildTraceability(input: {
  projectId: string; startedAt: string; schemaVersion: string;
  sourceIdentity: SourceIdentity; compilerIdentity: CompilerIdentity;
  configurationIdentity: ConfigurationIdentity; inputManifestHash: string; runId: string;
  outputIdentity: OutputIdentity;
  perExtractor: readonly { operation: string; patch: StatePatch }[];
  mergedPatch: StatePatch;                    // authoritative final entity lists
  fidelity: 'semantic' | 'syntactic';
}): TraceabilityState;
```

Behavior (pinned):
- one `ReconRun`: `status:'COMPLETED'`, `started_at = completed_at = startedAt` (resolved timestamp — deterministic), `output_identity` set.
- one `Derivation` per `perExtractor` entry **whose merged material outputs are non-empty**: `operation_version = ANALYZER_VERSION`, `status:'COMPLETED'`, `metadata: { fidelity }`, `inputs` = sorted unique `source_file` refs from that patch's entities' provenance files, `outputs` = material refs (`entity_type` ∈ MATERIAL, `entity_id` = entity id), `provenance` = sorted unique `` `${file}:${line_start}-${line_end}` `` spans, `id = derivationId(...)`.
- `outputs`: one `RunOutputRecord` per material entity in `mergedPatch` (content hash via `entityContentHash`), sorted canonically.
- `BuildStateInput` gains `files`, `solcLongVersion`, `fidelity`; `buildState` computes identities, manifest hash, run id, output identity (over the state **before** attaching traceability — Task 1 `omitTraceability` guarantees this equals the stored hash), attaches `traceability` into the `createReconState` input.

- [ ] **Step 1: Write the failing tests** — appended to `tests/traceability/lineage.test.ts`:
  - `analyze produces a completed run` — analyze vault fixture → `state.traceability.runs.length === 1`, all identity fields populated, `status === 'COMPLETED'`.
  - `derivations cover every material entity` — union of `derivations[].outputs` ⊇ ids of contracts/functions/state_variables/relationships/facts; every derivation's `provenance` spans are non-empty and file-resolvable.
  - `traceability is deterministic` — two `analyzeProject` calls, same config → `serializeReconState(a.state) === serializeReconState(b.state)`, equal run ids and derivation ids (Review Focus #3).
  - `stored output hash recomputes` — `computeOutputIdentity(loaded-or-in-memory state)` equals `runs[0].output_identity.output_hash`.
  - `run id stable across timestamp injection` — analyze twice with identical sources but different explicit `config.timestamp`: `runs[0].id` and every `derivations[].id` are equal (timestamps are execution metadata, excluded from ids), while `started_at` differs.
- [ ] **Step 2: Run to verify failures** → FAIL (`state.traceability` undefined).
- [ ] **Step 3: Implement** — `buildTraceability`, `BuildStateInput` extension, wiring in `buildState` + `analyzeProject`.
- [ ] **Step 4: Run tests to verify pass** → PASS.
- [ ] **Step 5: Verify contract** — full suite (all existing `buildState`/`analyze` tests must still pass) + tsc.
- [ ] **Step 6: Commit** — `feat(traceability): attach run and extractor derivations in the pipeline`

### Task 6: TraceabilityService — queries, status, bounded traversal

**Files:**
- Create: `src/traceability/service.ts` (re-export via `index.ts`)
- Test: `tests/traceability/service.test.ts`

**Interfaces:**
- Consumes: `TraceabilityState` + material collections from a `ReconState`; `EntityNotFound` error; BFS pattern precedent from `src/relationships/graph.ts`.
- Produces:

```ts
export const DEFAULT_TRACE_DEPTH = 5;

export interface TraceNode {
  kind: 'entity' | 'source_file' | 'provenance_span' | 'derivation' | 'source_identity' | 'run';
  id: string; depth: number;
}
export interface TraceResult {
  root: string; direction: 'backward' | 'forward' | 'both';
  status: TraceStatus; nodes: TraceNode[]; truncated: boolean;
}
export interface TraceabilityService {
  getRunById(runId: string): ReconRun | undefined;
  getRun(objectId: string): ReconRun | undefined;       // Q3 — current run first, else lexicographically greatest run_id
  getProvenance(objectId: string): string[];            // Q2 — entity's provenance spans, sorted unique
  getDerivations(objectId: string): Derivation[];       // outputs or inputs match, sorted by id
  traceBackward(objectId: string, options?: { depth?: number }): TraceResult;   // Q1
  traceForward(ref: TraceReference, options?: { depth?: number }): TraceResult;  // Q4
  trace(entityId: string, options: { direction: 'backward' | 'forward' | 'both'; depth?: number }): TraceResult; // Q10
  findByDerivation(operation: string, operationVersion: string): Derivation[];  // Q5
  findRunsBySourceIdentity(sourceHash: string): ReconRun[];                    // Q9
  findIncompleteTraces(): { entity_type: string; entity_id: string; status: TraceStatus }[];   // Q7
  findOrphanedTraceReferences(): { run_id: string; derivation_id: string; ref: TraceReference }[]; // Q8
  getTraceStatus(objectId: string): TraceStatus;
  getOutputs(runId: string): TraceReference[];          // run → output traversal (§26)
}
export function createTraceabilityService(state: ReconState): TraceabilityService;
```

Semantics (pinned):
- Traversal: iterative BFS with `visited` set (cycle-safe), frontier stops at `depth >= requested` (default `DEFAULT_TRACE_DEPTH = 5`), sets `truncated` when a frontier was discarded. Backward chain: entity → derivations containing it in `outputs` → `source_file` inputs + `provenance_span` nodes → `source_identity` → `run`. Forward: source ref → derivations with that input → their material outputs (flat extraction topology — fact→relationship chaining does not exist in Phase 2 and is documented, not faked).
- Unknown entity id on `getTraceStatus`/`trace*`/`getProvenance` → `throw new ReconError('EntityNotFound', ...)` (NOT_FOUND distinctness, §22).
- `getTraceStatus`: non-material collections → `NOT_APPLICABLE`; material → `COMPLETE` iff ≥1 derivation (any run, resolved via outputs/run_outputs) AND provenance non-empty; `PARTIAL` iff exactly one of the two; `MISSING` iff neither (T8 — never silently `COMPLETE`).
- `getRun(objectId)`: derivations whose outputs contain the object → runs; prefer the run matching the current `output_hash`, else `max(run_id)` lexicographic (deterministic tie-break, documented).
- Service reads only the in-memory state (no sqlite, no FS, no network — §21).

- [ ] **Step 1: Write the failing tests** — `tests/traceability/service.test.ts` (fixtures = a hand-built `TraceabilityState` over a small in-memory `ReconState` from Task 1 fixtures, plus a cycle/chain fixture):
  - `getProvenance returns entity spans` / `getProvenance throws EntityNotFound for unknown id`.
  - `getRun prefers current run` — historical + current derivations for same entity → current run; single-run case → that run; no derivations → `undefined`.
  - `backward trace reaches source and run` — relationship → derivation → source_file + provenance_span → source_identity → run nodes, `status:'COMPLETE'`.
  - `forward trace returns material outputs` — source_file ref → fact + relationship refs.
  - `cycle and depth limit` — A↔B derivations: returns, deduped visited, no hang; 8-link chain at depth 5 → `truncated: true` (Review Focus #5).
  - `direction both` merges backward+forward nodes.
  - `missing lineage is explicit` — material entity with no derivation & no provenance → `MISSING`; provenance-only → `PARTIAL`; both → `COMPLETE`; observation id → `NOT_APPLICABLE` (Review Focus #6).
  - `findByDerivation / findRunsBySourceIdentity` filter exactly.
  - `getOutputs lists run output records`.
  - `getDerivations matches inputs or outputs`.
- [ ] **Step 2: Run to verify failures** → FAIL (module missing).
- [ ] **Step 3: Implement** service with prebuilt indexes (derivation-by-output, derivation-by-input-file, entity→run) built once in `createTraceabilityService`.
- [ ] **Step 4: Run tests to verify pass** → PASS.
- [ ] **Step 5: Verify contract** — full suite + tsc.
- [ ] **Step 6: Commit** — `feat(traceability): query service with bounded cycle-safe traversals`

### Task 7: compareRuns (Q6)

**Files:**
- Modify: `src/traceability/service.ts` (add method), `src/traceability/types.ts` (comparison result type)
- Test: `tests/traceability/compare.test.ts`

**Interfaces:**
- Consumes: `run_outputs` records via `TraceabilityState.outputs`, identity fields on `ReconRun`.
- Produces:

```ts
export interface RunComparison {
  classification: 'same_source_same_analyzer' | 'same_source_diff_analyzer' | 'diff_source';
  added: TraceReference[];      // in B, not in A
  removed: TraceReference[];    // in A, not in B
  changed: TraceReference[];    // both, content_hash differs
  unchanged: TraceReference[];  // both, content_hash equal
}
compareRuns(runIdA: string, runIdB: string): RunComparison;   // canonicalized content_hash comparison
```

Classification: `source_identity.source_hash` equality × `compiler_identity.version === analyzer_version`? — pin: analyzer leg = `analyzer_version` equality; source leg = `source_identity.source_hash` equality; labels as in the type. Unknown run id → `EntityNotFound`. Arrays sorted by `(entity_type, entity_id)`.

- [ ] **Step 1: Write the failing tests** — `tests/traceability/compare.test.ts` (six cases): `identical runs → all unchanged`; `added entity`; `removed entity`; `changed content hash`; `same source diff analyzer version → same_source_diff_analyzer`; `diff source → diff_source`; plus `unknown run id throws EntityNotFound` and `compareRuns(a, a) → all unchanged`.
- [ ] **Step 2: Run to verify failures** → FAIL (`compareRuns` not a function).
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run tests to verify pass** → PASS.
- [ ] **Step 5: Verify contract** — full suite + tsc.
- [ ] **Step 6: Commit** — `feat(traceability): canonical compareRuns across run outputs`

### Task 8: Integrity suite — orphans, incompleteness, cross-run isolation, versioning, historical provenance

**Files:**
- Modify: possibly `src/traceability/service.ts` (only if a query gap surfaces)
- Test: `tests/traceability/integrity.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; `createReconState` validation; migration round trip.
- Produces: no new API (hardens existing).

- [ ] **Step 1: Write the failing tests** — `tests/traceability/integrity.test.ts`:
  - `cross-run isolation` (Review Focus #4) — entity `X` output by historical run A and current run B: `getRun(X)` → B; `traceBackward(X)` contains only B's derivation id; A's derivation never appears in B's traversal.
  - `historical output refs resolve via run_outputs` — run A's derivation references entity no longer in current collections but present in `run_outputs`: loads clean, `findOrphanedTraceReferences()` does NOT list it.
  - `orphan detection reports dangling refs` — hand-corrupt a **historical** derivation's output ref (absent from both collections and `run_outputs`) → service lists `{run_id, derivation_id, ref}`; current-run corruption is instead rejected at `createReconState` (Task 2 test covers the rejection half).
  - `findIncompleteTraces lists PARTIAL and MISSING` and never includes `NOT_APPLICABLE` objects.
  - `historical provenance is not overwritten` (T5) — save run A state, then state with run B: both runs' derivations and provenance spans persist after reload; A's spans intact.
  - `versioned derivation distinguishable` (T6) — same inputs, `operation_version` changed → different `derivationId`; `findByDerivation('extract.calls', v1)` excludes v2 rows.
  - `T2 no orphan material output` — state with `traceability` whose current run's `output_identity.output_hash` matches the computed hash (build entity set first, compute hash inline, attach traceability missing one entity's derivation) → `createReconState` throws `InvalidReconState`.
  - `T7 no false resolution` — entity with zero lineage reports `MISSING` even when sibling entities are `COMPLETE` (no blanket status).
- [ ] **Step 2: Run to verify failures** → FAIL for any unimplemented gap (expected green if Tasks 1–7 were honest — a red here is information; fix the product, not the test, unless the test itself is wrong).
- [ ] **Step 3: Implement** fixes if needed (log decision in ledger if a test expectation was wrong).
- [ ] **Step 4: Run tests to verify pass** → PASS.
- [ ] **Step 5: Verify contract** — full suite + tsc.
- [ ] **Step 6: Commit** — `test(traceability): cross-run isolation, orphan, and versioning invariants`

### Task 9: End-to-end vault trace (spec §26 traversal DoD)

**Files:**
- Test: `tests/traceability/e2e.test.ts` (fixture: existing `fixtures/solidity/vault/**` — no new fixture needed)

**Interfaces:**
- Consumes: `analyzeProject` (Task 5), `createTraceabilityService`, sqlite round trip (Task 2).

- [ ] **Step 1: Write the failing tests** — `tests/traceability/e2e.test.ts`:
  - `analyze → service → backward from relationship to source and run` (output → source + output → run traversal).
  - `forward from source file to facts and relationships` (source → output traversal).
  - `run → output traversal via getOutputs`, and `output → run via getRun`.
  - `traceBackward + traceForward both-directions via trace`.
  - `e2e save/load preserves queries` — save analyzed state, `loadState`, rebuild service: identical `getRun`/`traceBackward` results (§19 round trip with real pipeline output).
  - `facts retain provenance` — every vault fact has non-empty provenance (T5/§12, regression).
  - `getTraceStatus over analyzed vault` — all material entities `COMPLETE`.
- [ ] **Step 2: Run to verify failures** → FAIL (until wired; should already be green if Tasks 5–6 landed — treat red as signal).
- [ ] **Step 3: Implement** test (and any missing glue).
- [ ] **Step 4: Run tests to verify pass** → PASS.
- [ ] **Step 5: Verify contract** — full suite + tsc.
- [ ] **Step 6: Commit** — `test(traceability): end-to-end vault lineage round trip`

### Task 10: Documentation + final verification

**Files:**
- Create: `docs/traceability.md`
- Modify: none of the product code

**Interfaces:**
- Consumes: all pinned decisions in this plan.

- [ ] **Step 1: Write `docs/traceability.md`** covering exactly: the six layers (§3) mapped to real modules; identity formulas verbatim (source hash formula + `config_hash` root exclusion + `input_manifest_hash` payload + `run:<digest16>` + `derivation:<run>:<op>:<digest16>` + `recon-state-json/v1` output serialization); TraceStatus semantics incl. `NOT_APPLICABLE` rules; query catalog Q1–Q10 → service methods; invariants T1–T10 with the two documented resolutions (run attribution via linkage instead of Fact columns; historical-vs-current T1 scope); error-class mapping table (§22 → existing codes/statuses); security boundaries (no IO in trace module, bounded depth 5); limitations (no AST/IR node ids — provenance spans are the source-position references; flat extraction topology so forward does not chain fact→relationship; `getRun` tie-break; `binary_hash` absent for bundled solc).
- [ ] **Step 2: Final verification** — `npx vitest run` (full, expect ≥ 312 + all new traceability tests green), `npx tsc --noEmit`, `npx vitest run --coverage` (confirm `src/recon/**` still ≥ 80% statements and note `src/traceability/**` numbers).
- [ ] **Step 3: Self-check spec §26 DoD** — tick every checkbox (Model/Integration/Traversal/Integrity/Determinism/Testing/Documentation) in this plan's final ledger note; file gaps as issues if any cannot be closed in-plan.
- [ ] **Step 4: Commit** — `docs(traceability): document architecture, identities, queries, and boundaries`

---

## Spec Coverage Map (self-review)

| Spec section | Task |
|---|---|
| §3 layers 1–6 | 3 (L1/L2), 5 (L3/L4), 5+7 (L5), 6 (L6) |
| §4–§8 models (ReconRun, identities) | 1 (types), 3 (builders), 5 (population) |
| §9–§10 Derivation + example | 1, 4, 5 |
| §11 TraceStatus | 1 (type), 6 (semantics) |
| §12 requirements by object | 5 (material outputs), 6 (`NOT_APPLICABLE`), 9 (fact provenance), 8 (T2) |
| §14–§15 traversal | 6, 9 |
| §16 Q1–Q10 | 6 (Q1–Q5, Q7–Q10), 7 (Q6) |
| §17 T1–T10 | 1 (T1/T3), 6 (T8), 8 (T2/T4/T5/T6/T7/T10), 5 (T4 via run outputs), 3+5 (T9) |
| §18 stable IDs | 3 (`derivationId`), 5 (population) |
| §19 persistence | 2, 9 |
| §20 determinism | 3 (id exclusions), 5 (byte-identical runs), 2 (idempotent save) |
| §21 security | 6 (service IO-free), 10 (docs) — no new FS/net/process code anywhere |
| §22 error semantics | 6 (`EntityNotFound`, status separation), 10 (mapping table) |
| §26 DoD checklist | every task + final tick in 10 |
| §27 non-goals | Global Constraints (excluded verbatim) |
| §28 black-box prohibition | 9 (e2e lineage), 10 |

## Execution Handoff

Plan complete and saved to `docs/plans/2026-10-05-recon-phase2.5a-traceability.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-plan review at the end. Most thorough; costs a fresh context per task.
- **Native** — I implement every task myself in this session (executing-plans), then one fresh reviewer checks the whole branch. Cheapest and fastest; no independent review until the end.

**For this plan I recommend Subagent-driven**, because tasks 5–9 stack tightly on the exact interfaces pinned in tasks 1–3 (a drifted type or identity formula silently corrupts every later test) and a shipped mistake in the identity builders would be costly to detect late. Does the plan capture what you want, and which approach should we use?
