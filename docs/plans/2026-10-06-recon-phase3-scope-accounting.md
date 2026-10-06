# Phase 3 — Scope Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `analyzeProjectScoped` returning a deterministic, evidence-backed `ScopeReport` that gives every expected source target exactly one of the six statuses (ANALYZED / EXCLUDED / NOT_FOUND / UNRESOLVED / UNSUPPORTED / FAILED), with two-branch failure accounting, without editing the frozen foundation beyond the OD-6 budget.

**Architecture:** A new `src/scope/**` layer: an independent read-only inventory walk reusing exported discovery primitives → per-target evidence attribution → pure status derivation → counts/metrics → structural validation → serialize/hash → a wrapper around the single `analyzeProject` call that binds the report to the state's current traceability run and, on failure, rethrows the original error with a complete S-partition attached (iff inventory completed). Dependency direction `src/scope → {recon, recon-state, traceability, util}`; nothing under `src/` outside `src/scope` imports it.

**Tech Stack:** TypeScript (strict), zod (strictObject, z.infer types), node:fs / node:path / node:crypto, sha256 + `stableStringify` + `compareCodeUnits` (existing `src/util/canonical.ts`), vitest, existing solc-js 0.8.37 pipeline (called once, never re-implemented).

**Spec:** `docs/scope-accounting-spec.md` (Status: APPROVED 2026-10-06; §1–§15; INV-1…INV-14; OD-1…OD-10 approved; the three internal inconsistencies A1–A3 were amended before this plan — documented below; the plan argues from the spec, so executors read both).

---

## Global Constraints (every task inherits these)

- **Statuses:** exactly the six; never emit `UNKNOWN` as a status; no new status; `target_type = 'source_file'` only (OD-2).
- **ReconState v1 frozen:** no `scope` key in `ReconStateSchema` (OD-1); `serializeReconState` output byte-identical before/after any scope operation (INV-8).
- **Foundation touch budget (OD-6, exhaustive):** `src/recon/discover.ts` — add `export` to exactly `globToRegExp`, `ALWAYS_EXCLUDED_DIRS`, `assertInsideRoot`, `sortPaths` (no logic change); `src/errors/errors.ts` — add `| 'InvalidScopeReport'` to `ReconErrorCode`. **Zero edits:** `src/recon-state/**`, `src/traceability/**`, `src/util/canonical.ts`, `src/ids/**`, `src/relationships/graph.ts`, `src/recon/issues.ts`, `src/recon/build.ts`, `src/recon/index.ts`, `src/repository/**`.
- **Metric name `clean_coverage`** — forbidden as labels in code/docs/tests/commits: `coverage` (bare), "recon completeness", "semantic completeness" (except inside the required negation sentence, §10), "security coverage", "audit coverage", "understanding percentage", "risk reduction" (same exception).
- **Orthogonality (spec §5.1):** `run_status` = run outcome; `ScopeEntry.status` = target accounting; neither inferred from the other — `FAILED` + `failed = 0` (all attributed `UNSUPPORTED`) and `COMPLETED` + `UNSUPPORTED`/`UNRESOLVED` entries are both legitimate; tests pin both dimensions independently (T5, T7, T9, T11).
- **Attribution:** classification reads structured artifacts only (`dropped[]`, `issue.file`, error class) — never human-readable error-message text (INV-7, INV-13).
- **Report hygiene:** root-relative posix paths only; no timestamps/randomness/absolute paths (only exception: verbatim `run_error.message`); all ordering via `compareCodeUnits`; `scope_hash = sha256(stableStringify(report without scope_hash))`.
- **Import gate:** `src/scope/**` may import only `node:fs`, `node:path`, `node:crypto`, `zod`, `src/**` (A2).
- **Wrapper:** calls `analyzeProject` as ONE call — no pipeline re-implementation (parity, RF-5).
- **Gate per task:** `npx vitest run` green (399 baseline + new) and `npx tsc --noEmit` clean **before** each commit; conventional commits, one per task; final gate adds `git diff --name-only` ⊆ `src/scope/**`, `tests/scope/**`, `src/recon/discover.ts`, `src/errors/errors.ts`, `docs/**`.
- **Approval set:** OD-1…OD-10 + INV-1…INV-14 as amended below.

## Review Focus (spec §13 — inputs most likely to break a user of this report)

1. glob-matching-nothing falsely yielding `NOT_FOUND` — pinned in Task 3 (`inventory.test.ts`).
2. overclaim family: zero-findings read as not-analyzed, fallback read as unresolved, `clean_coverage` read as recon/semantic completeness — pinned in Tasks 3, 5, 6, 12.
3. `UNSUPPORTED` vs `FAILED` attribution boundary (structured vs unattributed, message-text parsing) — pinned in Tasks 5, 9.
4. absolute-path / timestamp leakage into reports — pinned in Tasks 8, 11.
5. wrapper parity drift vs `analyzeProject` — pinned in Task 10.

---

## Spec amendments applied before planning (the 3 inconsistencies)

### A1 — Stage vocabulary gains `'analysis'`

- **Chosen resolution:** §3 `Stage` becomes `'discover' | 'compile' | 'analysis' | 'ir' | 'extract' | 'build'` (added `analysis` + comment). The v1 mapper `mapErrorToStage` emits only `discover | compile | analysis`; `ir`/`extract`/`build` remain pipeline vocabulary, never produced in v1.
- **Why semantically correct:** §8.2 requires the catch-all value `analysis` for post-compile failures; no existing value represents that boundary — `ir`, `extract`, `build` are three distinct phases, and a class-based mapper (INV-7: no message parsing) cannot honestly discriminate among them for arbitrary error codes. Claiming ir/extract/build precision the error-class space does not carry would be exactly the overclaim this spec forbids. The three-phase discover/compile/analysis vocabulary is precisely what the mapper can determine.
- **Affected spec sections:** §3 (`Stage` type + comment). §8.2 unchanged (already said `analysis`).
- **Affected tests/fixtures:** Task 9 `mapErrorToStage` unit tests (`InvalidReconState`/unknown codes ⇒ `'analysis'`; non-ReconError ⇒ `'analysis'`). Goldens unaffected (only `discover`/`compile` appear).
- **Changes an existing invariant?** No. INV-7 unchanged (class-based, stable); stage values only populate `failed_stage` / `run_error.stage` evidence.

### A2 — Import gate includes `zod`

- **Chosen resolution:** §13 Layer F allowlist = `node:fs`, `node:path`, `node:crypto`, `zod`, `src/**`.
- **Why semantically correct:** §12 mandates `model.ts` be a zod strict schema; repo convention is zod-first with `z.infer` types (`ReconIssue` at `src/recon/issues.ts:17`, `ReconConfigSchema`, `ReconStateSchema`); zod is already a direct project dependency (no new dependencies). The gate's security intent (§11: no code execution, no eval, no network, no LLM) is untouched — zod is a pure validator.
- **Affected spec sections:** §13 Layer F (allowlist + rationale).
- **Affected tests/fixtures:** Task 11 static import gate test scans `src/scope/**` imports against exactly this set.
- **Changes an existing invariant?** No — enumeration correction only; §11 intent identical.

### A3 — `counts.failed = 0` vs the `all-dropped` golden

- **Orthogonality wording lock (normative, spec §5.1/§8.2/INV-9/INV-12):**
  *«`run_status` describes the pipeline/run outcome; `ScopeEntry.status`
  describes target-level accounting. Neither may be inferred from the other. A
  `FAILED` run may legitimately have `counts.failed = 0` when every expected
  on-disk target has independently attributable `UNSUPPORTED` status. A
  `COMPLETED` run may legitimately contain `UNSUPPORTED`, `UNRESOLVED`, or other
  target statuses when those statuses are independently supported by
  target-level evidence and the run itself completed.»*
- **Chosen resolution:** replaced "failed = 0 only when E has no on-disk target" with the accounting rule: on a `FAILED` report every on-disk expected target is `UNSUPPORTED` (content-attributed) or `FAILED` (unattributed); `failed = 0` is valid iff all on-disk expected targets are `UNSUPPORTED` or there are none; **added `counts.unresolved = 0` to INV-9** for FAILED reports. Reworded INV-12 from "never silently zero" to explicit non-collapsing accounting; §8.2 gained an "accounting under failure" bullet; Layer E test wording updated. The orthogonality rule above is the framing principle for all of it.
- **Why semantically correct (not a weakening):** the old rule conflated three distinct signals — `run_status: FAILED` (the run died), entry `FAILED` (unattributed failure hit this target), entry `UNSUPPORTED` (structured per-target content refusal). On `all-dropped` the run genuinely failed (foundation throws `CompilationFailed: no source survived compilation`, `compile.ts:521-526`) while every target is *accounted* — as `UNSUPPORTED`, with `compilation_failed` evidence — so `counts.failed = 0` correctly reports "zero targets failed for unattributed reasons"; forcing `failed > 0` would fabricate target failures that never happened and collapse UNSUPPORTED into FAILED (violating no-collapse, §9/§22). INV-1 (partition) + INV-9 (`analyzed = 0`, `unresolved = 0`) now imply `unsupported + failed = expected − not_found`, so no on-disk target can be left unaccounted — the completeness the old wording reached for, without the category error. The four distinctions stay separately expressible: run failure = report-level (`run_status`/`failed_stage`); target failure = entry `FAILED` + `run_error`; content refusal = entry `UNSUPPORTED` + attribution; and a COMPLETED run with every on-disk target `UNSUPPORTED` remains a **legal partition** (no invariant forbids it) even though the current pipeline cannot produce it (foundation throws when nothing survives).
- **Affected spec sections:** §8.2 (accounting-under-failure bullet), INV-9, INV-12, §13 Layer E.
- **Affected tests/fixtures:** Task 7 (new accept/reject cases below), Task 9 (branch fixtures), Task 11 `all-dropped` golden — now a logically valid partition under the final rules.
- **Changes an existing invariant?** INV-9 strengthened (`unresolved = 0` added; failed=0 clause corrected), INV-12 reworded (no invariant dropped); INV-1 unchanged.

---

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `src/scope/model.ts` | zod strict schemas + inferred types (spec §3) |
| `src/scope/inventory.ts` | `buildInventory` — canonical S/E walk (§4) |
| `src/scope/evidence.ts` | per-target issue attribution (INV-13 input side) |
| `src/scope/derive.ts` | pure status derivation + precedence (§5) |
| `src/scope/metrics.ts` | `computeCounts` / `computeMetrics` (§6, §10) |
| `src/scope/validate.ts` | structural invariants (T7); state cross-checks (T10) |
| `src/scope/report.ts` | `computeScopeHash` / `finalizeScopeReport` / `serializeScopeReport` (§7) |
| `src/scope/analyze.ts` | `mapErrorToStage` + `analyzeProjectScoped` (§8) |
| `src/scope/index.ts` | barrel (T10) |
| `tests/scope/*.test.ts` | one suite per task (12 files) |
| `tests/scope/golden/*.json` | 7 frozen golden reports (T11) |
| `docs/scope-accounting.md` | user-facing system-of-record (T12) |

**Modify:** `src/recon/discover.ts` (4 export keywords), `src/errors/errors.ts` (1 union member), `docs/scope-accounting-spec.md` (A1–A3 — already applied).

**Fixture convention:** `mkdtempSync(join(tmpdir(), …))` + `writeFileSync` + `parseReconConfig({ root, recordGit: false, timestamp: '2026-01-01T00:00:00Z', projectName: … })` (existing pattern, `tests/recon/analyze.test.ts`); `rmSync(..., { recursive: true, force: true })` in `afterEach`.

## Task order and dependencies

| Task | Depends on | Deliverable |
|---|---|---|
| 1 foundation exports | — | discover exports + `InvalidScopeReport` code |
| 2 model | — | `src/scope/model.ts` schemas/types |
| 3 inventory | 1 | `buildInventory` + walk security |
| 4 evidence | 2 | attribution helpers |
| 5 derive | 2, 3, 4 | status derivation |
| 6 metrics | 2 | counts + metrics |
| 7 validate (structural) | 2, 6 | `validateScopeReport` |
| 8 report | 2, 7 | hash/serialize/leakage |
| 9 wrapper | 3, 5, 6, 7, 8 | `analyzeProjectScoped` both branches |
| 10 cross-checks + parity + barrel | 9 | `validateScopeReportWithState`, parity suite |
| 11 goldens + import gate | 10 | 7 goldens, security gate |
| 12 docs | 6, 2 | `docs/scope-accounting.md` + phrase test |

---

### Task 1: Foundation exports + `InvalidScopeReport`

**Files:**
- Modify: `src/recon/discover.ts` (module-private `ALWAYS_EXCLUDED_DIRS:15`, `globToRegExp:17`, `assertInsideRoot:57`, `sortPaths:64` — add `export` keyword only)
- Modify: `src/errors/errors.ts:1-25` (union member)
- Test: `tests/scope/foundation-exports.test.ts`

**Interfaces:**
- Produces: `globToRegExp(pattern: string): RegExp`, `ALWAYS_EXCLUDED_DIRS: Set<string>`, `assertInsideRoot(realRoot: string, absolutePath: string, relativePath: string): void`, `sortPaths<T>(records: readonly T[], pick: (record: T) => string): T[]`; `ReconErrorCode | 'InvalidScopeReport'`.

- [ ] **Step 1: Write the failing test**

```ts
import { globToRegExp, ALWAYS_EXCLUDED_DIRS, assertInsideRoot, sortPaths }
  from '../../src/recon/discover.js';
import { ReconError } from '../../src/errors/errors.js';

it('globToRegExp matches discovery semantics', () => {
  expect(globToRegExp('**/*.sol').test('src/A.sol')).toBe(true);
  expect(globToRegExp('**/*.sol').test('src/A.txt')).toBe(false);
});
it('ALWAYS_EXCLUDED_DIRS contains the canonical set', () => {
  expect([...ALWAYS_EXCLUDED_DIRS].sort()).toEqual(['.git', '.recon-cache', 'node_modules']);
});
it('sortPaths sorts by the picked key in code-unit order', () => {
  expect(sortPaths([{ p: 'b' }, { p: 'a' }], (r) => r.p).map((r) => r.p)).toEqual(['a', 'b']);
});
it('assertInsideRoot throws RootEscape outside the root', () => {
  const realRoot = '/tmp/root';
  expect(() => assertInsideRoot(realRoot, '/tmp/other/x', '../x')).toThrowError(ReconError);
  try { assertInsideRoot(realRoot, '/tmp/other/x', '../x'); } catch (e) {
    expect((e as ReconError).code).toBe('RootEscape');
  }
});
it('InvalidScopeReport is a ReconErrorCode', () => {
  expect(new ReconError('InvalidScopeReport', 'x').code).toBe('InvalidScopeReport');
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run tests/scope/foundation-exports.test.ts`
  Expected: FAIL — module has no exported member / invalid error code.

- [ ] **Step 3: Implement — add `export` to the four symbols; add `| 'InvalidScopeReport'` to `ReconErrorCode`**
  No logic changes anywhere (OD-6).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run tests/scope/foundation-exports.test.ts` → PASS.

- [ ] **Step 5: Full gate** — `npx vitest run` (399 + new, green), `npx tsc --noEmit` (clean).

- [ ] **Step 6: Commit**
  `git add src/recon/discover.ts src/errors/errors.ts tests/scope/foundation-exports.test.ts && git commit -m "feat(scope): export discovery primitives and add InvalidScopeReport code"`

---

### Task 2: `model.ts` — zod schemas and inferred types

**Files:**
- Create: `src/scope/model.ts`
- Test: `tests/scope/model.test.ts`

**Interfaces:**
- Consumes: `issueSeveritySchema` from `../recon/issues.js`; `zod`.
- Produces (exact names — later tasks import these):
  - Schemas: `stageSchema` (6 values per A1), `scopeStatusSchema`, `targetTypeSchema` (`'source_file'`), `embeddedIssueSchema` (strict: `code`, `severity` (`issueSeveritySchema`), `message`, `file` **required**, `line_start?`, `line_end?`, `count` int ≥ 1), `scopeEvidenceSchema` (discriminated union on `kind`: `analysis{sha256}` | `exclude_rule{rule}` | `size_limit{limit_bytes}` | `walk_miss{include}` | `issue{issue}` | `run_error{stage, error_class, message}`), `scopeEntrySchema` (strict: `target_type`, `path` min 1, `status`, `evidence` array min 1), `ratioSchema` (`{ n ≥ 0 int, d ≥ 1 int }`), `scopeMetricsSchema` (strict, 7 fields: `clean_coverage`, `resolution_completeness`, `unsupported_rate`, `failed_rate`, `not_found_rate`, `excluded_by_rule`, `fallback_count`), `scopeRunSchema` (`{ run_id, input_manifest_hash, output_hash }` min 1), `countsSchema` (strict, 7 ints ≥ 0), `scopeReportSchema` (strict: `schema_version` literal `'scope-report/v1'`, `run` union[scopeRunSchema, null], `run_status` enum, `run_fidelity?`, `failed_stage?`, `counts`, `entries`, `metrics`, `scope_hash` regex `^[0-9a-f]{64}$`).
  - Types (all `z.infer`): `Stage`, `ScopeStatus`, `EmbeddedIssue`, `ScopeEvidence`, `ScopeEntry`, `Ratio`, `ScopeMetrics`, `ScopeCounts`, `RunBinding`, `ScopeReport`.
  - Documented boundary: cross-field rules (INV-9 conditionals) live in `validate.ts` (T7), not in the schema.

- [ ] **Step 1: Write the failing test** — `tests/scope/model.test.ts`:
  - `valid minimal report parses` (one ANALYZED entry, full counts/metrics, 64-hex hash).
  - `unknown keys rejected` (`{ ...report, generated_at: 'x' }` throws).
  - `missing clean_coverage rejected`.
  - `invalid scope_hash rejected` (`'zz'`).
  - `status and stage vocabularies are pinned` — `scopeStatusSchema.options` has exactly the six (no `UNKNOWN`); `stageSchema.options` includes `'analysis'` and the five pipeline values.

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/scope/model.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/scope/model.ts`** — zod-first, types via `z.infer` (repo pattern); strictObject everywhere; exact field shapes above.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): scope report zod model`

---

### Task 3: `inventory.ts` — canonical S/E walk

**Files:**
- Create: `src/scope/inventory.ts`
- Test: `tests/scope/inventory.test.ts`

**Interfaces:**
- Consumes: Task 1 exports, `ReconConfig` / `parseReconConfig` (`../recon/config.js`), `ReconError`, `compareCodeUnits` (`../util/canonical.js`).
- Produces:

```ts
export interface FileRecord {
  path: string; sha256: string; bytes: number;
  excluded_rule: string | null;   // null ⇒ in E
  limit_bytes?: number;           // set iff rule is limit:maxFileBytes
}
export interface NotFoundRecord { path: string; include: string }
export interface ScopeInventory { files: FileRecord[]; not_found: NotFoundRecord[] }
export async function buildInventory(config: ReconConfig): Promise<ScopeInventory>
```

- Pinned walk rules (§4 + plan decisions):
  - `files` = full S (matched files + dir markers + excluded), sorted `compareCodeUnits(path)`; never throw `NoSourcesFound` (accounting walk ≠ discovery).
  - Exclusion precedence (at most one rule): always-excluded dirs → one marker each (`path` = full relative dir path, e.g. `vendor/node_modules`; `excluded_rule` = `always:<basename>`; contents never enumerated) → first matching user exclude **in `config.excludes` array order** (`config:excludes:<pattern>`) → non-regular file matching an include (`type:non-file`; directories still traversed) → `limit:maxFileBytes` (checked after pattern exclusion, file read first; at-limit eligible) → else `null`.
  - realpath + `assertInsideRoot` on every matched path (escape ⇒ throw `RootEscape`); matched count > `maxFiles` ⇒ throw `SourceLimitExceeded`.
  - Literal includes = patterns containing neither `*` nor `?` (the globToRegExp magic chars): normalize (strip `./`, posix), dedupe, escape after normalization ⇒ throw `RootEscape`; `stat` missing ⇒ `not_found` record (exists ⇒ never `not_found` — covered by walk/decline).
  - sha256 over file bytes via `node:crypto` (same formula as discovery).

- [ ] **Step 1: Write the failing test** — `tests/scope/inventory.test.ts` (fixture per convention):

  - `glob matching nothing yields no entry and no NOT_FOUND` [RF1] — includes `['nonexistent/**/*.sol']`, no literals ⇒ `files` empty, `not_found` empty.
  - `literal miss yields walk_miss with normalized path` — `not_found` equals `[{ path: 'contracts/Ghost.sol', include: 'contracts/Ghost.sol' }]`; duplicate + `./`-prefixed literals collapse to one; literal `../x.sol` rejects `RootEscape`.
  - `always-excluded dirs yield one marker and never enumerate contents` — marker `path: 'node_modules'`, rule `always:node_modules`; nested `vendor/node_modules` ⇒ marker `path: 'vendor/node_modules'`, same basename rule; no file beneath in `files`.
  - `exclude pattern wins over size limit` — excludes `['big/**']` + oversized file under `big/` ⇒ rule `config:excludes:big/**`, no `limit_bytes`.
  - `size boundary at-limit eligible limit+1 excluded` — bytes === max ⇒ `excluded_rule: null`; max+1 ⇒ `limit:maxFileBytes` + `limit_bytes` set.
  - `directory matching an include records type:non-file and is still traversed`.
  - `parity with discoverSources` — E paths sorted equal `(await discoverSources(config)).files.map(f => f.path).sort()` on a mixed fixture.
  - `maxFiles exceeded rejects with SourceLimitExceeded`; `symlink escaping root rejects with RootEscape`; `symlink cycle terminates` (visited-set; test completes).

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement `buildInventory`** per the pinned rules (BFS walk mirroring `discoverSources` structure, but recording declines instead of skipping; no `NoSourcesFound`).

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): canonical scope inventory walk`

---

### Task 4: `evidence.ts` — per-target attribution

**Files:**
- Create: `src/scope/evidence.ts`
- Test: `tests/scope/evidence.test.ts`

**Interfaces:**
- Consumes: `ReconIssue` (`../recon/issues.js`), `EmbeddedIssue` (`./model.js`), `compareCodeUnits`.
- Produces:

```ts
export const FALLBACK_CODE = 'syntactic_fallback';
export const COMPILATION_FAILED_CODE = 'compilation_failed';
export function attributableIssues(issues: readonly ReconIssue[], path: string): EmbeddedIssue[];
export function hasUnknown(issues: readonly EmbeddedIssue[]): boolean;
export function hasFallback(issues: readonly EmbeddedIssue[]): boolean;
export function hasCompilationFailed(issues: readonly EmbeddedIssue[]): boolean;
```

- Pins: filter `issue.file === path` (file-less and other-file issues never match — INV-13 basis); map `count: issue.count ?? 1`, `file: path`, passthrough line fields; sort `compareCodeUnits(code)` → `compareCodeUnits(file)` → `line_start ?? 0` (§7); flags: `severity === 'UNKNOWN'` / `code === FALLBACK_CODE` / `code === COMPILATION_FAILED_CODE`.

- [ ] **Step 1: Write the failing test** — assertions:
  - `only issues whose file equals the path are embedded` (other-file + file-less excluded).
  - `embedded count defaults to 1`; explicit count preserved.
  - `evidence sorted by code then line_start`.
  - flag helpers: UNKNOWN severity ⇒ `hasUnknown` true (RECOVERABLE false); fallback/compilation_failed by code.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement** `attributableIssues` + three helpers.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): per-target issue attribution`

---

### Task 5: `derive.ts` — pure status derivation

**Files:**
- Create: `src/scope/derive.ts`
- Test: `tests/scope/derive.test.ts`

**Interfaces:**
- Consumes: `ScopeInventory` (T3), evidence helpers (T4), model types (T2).
- Produces:

```ts
export type DeriveOutcome =
  | { kind: 'completed'; issues: readonly ReconIssue[]; fidelity: 'semantic' | 'syntactic' }
  | { kind: 'failed'; stage: Stage; error_class: string; message: string;
      issues?: readonly ReconIssue[]; dropped?: readonly string[] };
export function deriveEntries(inventory: ScopeInventory, outcome: DeriveOutcome): ScopeEntry[];
```

- Pinned decision tree (the only non-obvious body — rules, no code here):
  1. excluded record → `EXCLUDED` + `exclude_rule` evidence (or `size_limit {limit_bytes}` when rule is `limit:maxFileBytes`); dir markers / `type:non-file` → `exclude_rule`.
  2. `not_found` → `NOT_FOUND` + `walk_miss {include}`.
  3. **completed**, on-disk E: attributable `compilation_failed` ⇒ `UNSUPPORTED` + issue evidence (no `analysis`); else attributable UNKNOWN ⇒ `UNRESOLVED` + **all** attributable issues + `analysis`; else `ANALYZED` + `analysis` (+ fallback issue if attributable — fidelity marker only, never a trigger).
  4. **failed**, on-disk E: `dropped.includes(path)` OR attributable `compilation_failed` ⇒ `UNSUPPORTED` + issue evidence; else `FAILED` + `run_error {stage, error_class, message: <verbatim>}`. Branch (1)(2) statuses preserved.
  5. `analysis.sha256` = inventory sha256; `UNSUPPORTED` never carries `analysis`; failed outcome never yields `ANALYZED` or `UNRESOLVED`; output sorted `compareCodeUnits(path)`.

- [ ] **Step 1: Write the failing test** — one `it` per status (truth table, exact evidence assertions) plus:
  - `zero-findings file derives ANALYZED` [RF2].
  - `syntactic_fallback without attributable UNKNOWN derives ANALYZED with fidelity marker` [RF2] — the OD-4 pin.
  - `syntactic_fallback with attributable UNKNOWN derives UNRESOLVED`.
  - `run-level (file-less) UNKNOWN does not flip any entry` [INV-13] ⇒ ANALYZED.
  - `other-file UNKNOWN does not flip this entry`.
  - `unattributable CompilationFailed derives FAILED for every on-disk target, never UNSUPPORTED` — failed outcome, `dropped: []`, issues from another file [RF3].
  - `partially attributed CompilationFailed: dropped path UNSUPPORTED, rest FAILED` — `dropped: ['B.sol']`.
  - precedence: `dropped + UNKNOWN issue ⇒ UNSUPPORTED`; `failed + attributable UNKNOWN (not dropped) ⇒ FAILED`; `completed + compilation_failed issue ⇒ UNSUPPORTED`.
  - `unsupported_* findings in a completed run leave the entry ANALYZED`.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement `deriveEntries`** per the decision tree (pure — no clock/env/message reads).

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): pure status derivation`

---

### Task 6: `metrics.ts` — counts and metrics

**Files:**
- Create: `src/scope/metrics.ts`
- Test: `tests/scope/metrics.test.ts`

**Interfaces:**
- Consumes: model types (T2).
- Produces:

```ts
export function computeCounts(entries: readonly ScopeEntry[]): ScopeCounts;
export function computeMetrics(entries: readonly ScopeEntry[]): ScopeMetrics;
```

- Pins (§10): `expected = entries.length − excluded`; E-entries = statuses ≠ `EXCLUDED`; `clean_coverage = analyzed/|E|`; `resolution_completeness = analyzed/(analyzed+unresolved)`; three rates over `|E|`; **zero-denominator policy (plan decision; spec silent; goldens pin it)**: rates with `d = 0` ⇒ `{ n: 0, d: 1 }`; completeness ratios with `d = 0` ⇒ `{ n: 1, d: 1 }` (§10's vacuous rule generalized); `excluded_by_rule` aggregated from EXCLUDED evidence (`exclude_rule.rule`, or literal `limit:maxFileBytes` for `size_limit`), sorted `compareCodeUnits(rule)`; `fallback_count` = entries carrying `syntactic_fallback` (any status).

- [ ] **Step 1: Write the failing test**:
  - `clean_coverage = analyzed over expected with vacuous 1/1 at |E| = 0` [RF2] (+ rates `{0,1}` there).
  - `counts sum to |S| and expected excludes only EXCLUDED`.
  - `resolution_completeness uses analyzed over analyzed+unresolved`.
  - `excluded_by_rule aggregates exact rule strings sorted code-unit`.
  - `fallback_count counts entries regardless of status`.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement** the two functions.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): scope counts and metrics`

---

### Task 7: `validate.ts` — structural invariants

**Files:**
- Create: `src/scope/validate.ts`
- Test: `tests/scope/validate.test.ts`

**Interfaces:**
- Consumes: `scopeReportSchema` (T2), `computeCounts`/`computeMetrics` (T6), `ReconError`.
- Produces:

```ts
export function validateScopeReport(report: unknown): ScopeReport;
// throws new ReconError('InvalidScopeReport', message, { reason })
```

- Checks (spec → list):
  - schema parse (strict; `scope_hash` syntax via schema — **full hash recomputation is Task 8**'s boundary, documented here);
  - INV-1: counts sum = `entries.length`; `expected = entries − excluded`; unique `(target_type, path)`;
  - INV-3/INV-13: every embedded `issue.file === entry.path`; required evidence kinds per §5.1; `ANALYZED` ⇒ no UNKNOWN and no `compilation_failed` evidence (fallback marker allowed); `UNRESOLVED` ⇒ ≥1 severity `UNKNOWN`; `UNSUPPORTED` ⇒ ≥1 code `compilation_failed`; `FAILED` ⇒ `run_error`; `EXCLUDED` ⇒ `exclude_rule` (shape `config:excludes:*` | `always:*` | `type:*`) or `size_limit`; `NOT_FOUND` ⇒ `walk_miss`;
  - INV-9 structural: COMPLETED ⇒ `run` object with 3 non-empty strings + `run_fidelity` present + `counts.failed = 0`; FAILED ⇒ `run: null` + `failed_stage` + `counts.analyzed = 0` + `counts.unresolved = 0` [A3];
  - INV-10: no path starts `/`, no `..` segment, no `\`;
  - INV-14: full metrics object (schema) + counts present;
  - rollups: stored counts/metrics deep-equal recomputed from entries (T6).

- [ ] **Step 1: Write the failing test** — `it` names:
  - `valid report with all six statuses round-trips`.
  - rejected: `unknown keys`, `counts not summing`, `duplicate entry`, `ANALYZED with UNKNOWN evidence`, `ANALYZED with compilation_failed evidence`, `UNRESOLVED without attributable UNKNOWN` (fallback-only), `UNRESOLVED with other-file UNKNOWN evidence` [INV-13], `UNSUPPORTED without compilation_failed`, `FAILED without run_error`, `non-relative path`, `absolute path`, `ANALYZED on FAILED report`, `UNRESOLVED on FAILED report` [A3], `missing run_fidelity on COMPLETED`, `stale metric rollup`, `missing clean_coverage`.
  - accepted: `all-unsupported FAILED report with failed = 0` [A3]; `NoSourcesFound-shaped FAILED report with failed = 0` [A3].

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement `validateScopeReport`** (state cross-checks explicitly out of scope — Task 10).

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): structural scope report invariants`

---

### Task 8: `report.ts` — serialize, hash, leakage guards

**Files:**
- Create: `src/scope/report.ts`
- Test: `tests/scope/report.test.ts`

**Interfaces:**
- Consumes: `stableStringify` (`../util/canonical.js`), model, validate.
- Produces:

```ts
export function computeScopeHash(report: Omit<ScopeReport, 'scope_hash'>): string;
export function finalizeScopeReport(report: Omit<ScopeReport, 'scope_hash'>): ScopeReport;
export function serializeScopeReport(report: ScopeReport): string;
```

- Pins: hash = sha256 hex of `stableStringify(report without scope_hash)`; serialize = `stableStringify(full report)` (no re-sorting — entries arrive sorted from derive).

- [ ] **Step 1: Write the failing test** [RF4] — assertions:
  - `finalize sets a 64-hex hash recomputable from the report without hash`.
  - `hash changes when a status changes` / `identical inputs give identical hashes`.
  - `serialized report contains no absolute path` — `expect(serialized).not.toContain(root)` and `.not.toContain(tmpdir())`.
  - `serialized report contains no timestamp-shaped key or ISO date` — keys reject `/timestamp|generated_at|date/i`; string rejects `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/`.
  - `validate round trip passes` — `validateScopeReport(finalizeScopeReport(...))`.
  - `double serialize is byte-identical`.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement** the three functions.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): report serialization and scope hash`

---

### Task 9: `analyze.ts` — wrapper (stage map + two-branch failure + run binding)

**Files:**
- Create: `src/scope/analyze.ts`
- Test: `tests/scope/analyze.test.ts`

**Interfaces:**
- Consumes: `buildInventory` (T3), `deriveEntries` (T5), `computeCounts`/`computeMetrics` (T6), `validateScopeReport` (T7), `finalizeScopeReport` (T8), `analyzeProject` + `AnalysisResult` (`../recon/index.js`), `computeOutputIdentity` (`../traceability/identities.js`), `ReconError`/`isReconError`, `ReconConfig`, `ReconIssue`.
- Produces:

```ts
export function mapErrorToStage(error: unknown): Stage;
export interface AnalyzeScopedDeps {
  analyze?: (config: ReconConfig) => Promise<AnalysisResult>; // tests only; default analyzeProject
}
export interface AnalyzeScopedResult { result: AnalysisResult; report: ScopeReport }
export async function analyzeProjectScoped(
  config: ReconConfig, deps?: AnalyzeScopedDeps,
): Promise<AnalyzeScopedResult>;
```

- Pinned flow:
  1. `inventory = await buildInventory(config)` **outside** the catch — any inventory throw (RootEscape / SourceLimitExceeded / …) propagates with **no** `scope_report` (branch 2, INV-12).
  2. `try { result = await (deps?.analyze ?? analyzeProject)(config) }` — non-`ReconError` propagates unchanged (no report); `ReconError` → branch 1.
  3. **Branch 1:** `stage = mapErrorToStage(error)`; `dropped = string[] from error.details.dropped ?? []`; `issues = ReconIssue[] from error.details.issues ?? []` (structured reads only — **no message parsing**); entries = `deriveEntries(inventory, { kind: 'failed', stage, error_class: error.code, message, issues, dropped })`; counts+metrics; report `{ schema_version, run: null, run_status: 'FAILED', failed_stage: stage, counts, entries, metrics }`; `validateScopeReport`; `finalizeScopeReport`; **rethrow** `new ReconError(error.code, <original message without the `[code] ` prefix>, { ...error.details, scope_report: report })` so the reconstructed error's `.message` is byte-identical to the original.
  4. **Success:** `deriveEntries(inventory, { kind: 'completed', issues: result.issues, fidelity: result.meta.fidelity })`; counts+metrics; current run = `state.traceability?.runs?.find(r => r.output_identity?.output_hash === computeOutputIdentity(state).output_hash)`; `run = { run_id: run.id, input_manifest_hash: run.input_manifest_hash, output_hash: run.output_identity.output_hash }`; if no current run on COMPLETED ⇒ structural validation throws `InvalidScopeReport` (loud — never silently unbound); report `{ run_status: 'COMPLETED', run_fidelity: result.meta.fidelity, run, … }`; structural validate + finalize; return `{ result, report }`. (State cross-checks land in Task 10.)
  5. `mapErrorToStage` pins [A1]: `NoSourcesFound | SourceLimitExceeded | RootEscape → 'discover'`; `CompilationFailed | CompilerUnavailable → 'compile'`; every other code (incl. `InvalidReconState`, `MigrationError`) → `'analysis'`; non-ReconError → `'analysis'` (defensive; the wrapper never invokes it for non-ReconError).

- [ ] **Step 1: Write the failing test** — `it` names:
  - `mapErrorToStage maps discover codes` / `maps compile codes` / `maps all other codes to analysis` [A1] / `non-ReconError maps to analysis`.
  - [RF3] `unattributable CompilationFailed marks on-disk entries FAILED, not UNSUPPORTED` — injected analyze throws `ReconError('CompilationFailed', msg, { issues: [{ …, file: 'other.sol' }], dropped: [] })`; assert rethrown error: `code === 'CompilationFailed'`, `message` byte-identical to original, `details.scope_report` present; entries A/B `FAILED`, EXCLUDED/NOT_FOUND preserved; **message text containing a file name creates no UNSUPPORTED** (anti-message-parsing pin).
  - `dropped path derives UNSUPPORTED under structured attribution` — `dropped: ['B.sol']` + matching `compilation_failed` issue.
  - `CompilerUnavailable yields failed_stage compile with all on-disk entries FAILED`.
  - `NoSourcesFound real fixture yields valid failed=0 report` — glob matches nothing + one literal miss (real, no injection): inventory ok (E = literal only) → real `analyzeProject` throws → report validates, `counts.failed === 0`, `not_found === expected` [A3].
  - `inventory failure rethrows without a fabricated scope_report` [RF3] — two real fixtures: `maxFiles: 1` with 2 files (SourceLimitExceeded); symlink escape (RootEscape) ⇒ `error.details.scope_report` undefined.
  - `non-ReconError propagates without a report` — injected analyze throws `TypeError('boom')`.
  - `success smoke: structurally valid report with run bound` — small real fixture; `run_status === 'COMPLETED'`; `run` matches the current-run find rule; `validateScopeReport(report)` passes; `scope_hash` 64-hex.
  - Interface note: injected failure fixtures must include a `compilation_failed` issue for every dropped path (matches `compile.ts:510-517` ordering); a missing one makes structural validation throw `InvalidScopeReport` — loud, never fabricated.

- [ ] **Step 2: Run test to verify it fails** → FAIL.

- [ ] **Step 3: Implement `mapErrorToStage` + `analyzeProjectScoped`** per the pinned flow.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): scoped analyzer wrapper with two-branch failure accounting`

---

### Task 10: state cross-checks + parity suite + barrel

**Files:**
- Modify: `src/scope/validate.ts`, `src/scope/analyze.ts`
- Create: `src/scope/index.ts`
- Test: `tests/scope/analyze-parity.test.ts`

**Interfaces:**
- Produces:

```ts
// validate.ts (added)
export function validateScopeReportWithState(
  report: ScopeReport, state: ReconState, meta: { fileCount: number },
): void; // throws InvalidScopeReport; read-only (INV-8)
// analyze.ts (modified): success path additionally calls
// validateScopeReportWithState(report, result.state, result.meta)
// index.ts: re-export * from model/inventory/evidence/derive/metrics/validate/report/analyze
```

- Pins: checks = INV-11/INV-9-with-state: (a) `meta.fileCount === analyzed + unresolved + unsupported + failed`; (b) provenance span files ⊆ {`ANALYZED`, `UNRESOLVED`} paths — **own read-only traversal in `src/scope/**`** (foundation collectors are module-private; zero foundation edits); (c) `report.run` equals current run by the `computeOutputIdentity` rule; (d) `run_fidelity === meta.fidelity`. Non-mutation test (INV-8, Layer C) lands here — this is where state is first read.

- [ ] **Step 1: Write the failing test** — `it` names:
  - `wrapper state is byte-identical to plain analyzeProject` [RF5] — same fixture/config: `serializeReconState(scoped.result.state)` === `serializeReconState(plain.state)`; issues deep-equal; meta deep-equal.
  - `report.run equals the current run by output_identity rule`.
  - `meta.fileCount equation holds`.
  - `provenance cross-check passes on a real fixture` + `fails when an entry is demoted to NOT_FOUND` (crafted mutation ⇒ throws).
  - `fileCount mismatch rejected`; `run identity mismatch rejected`.
  - `double run produces byte-identical serializeScopeReport` (fixed timestamp fixture).
  - `validation does not mutate state` — `serializeReconState(state)` before === after `validateScopeReportWithState` [INV-8].
  - `barrel exports the full module surface`.

- [ ] **Step 2: Run test to verify it fails** — `validateScopeReportWithState` undefined; parity pins unverified → FAIL.

- [ ] **Step 3: Implement** `validateScopeReportWithState`, wire it into the success path, create the barrel.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `feat(scope): state cross-checks and wrapper parity`

---

### Task 11: golden corpus + static import gate

**Files:**
- Create: `tests/scope/golden.test.ts`, `tests/scope/golden/<corpus>.json` (7 goldens)
- Fixtures: built inline (`mkdtempSync` + `writeFileSync`), shared config `{ recordGit: false, timestamp: '2026-01-01T00:00:00Z', projectName: 'scope-golden' }`.

**Corpora (spec §13 Layer G):**

| # | Corpus | Fixture | Expected partition (asserted explicitly + frozen bytes) |
|---|---|---|---|
| 1 | `clean-vault` | 2 valid contracts | COMPLETED semantic; both ANALYZED; `clean_coverage {2,2}` |
| 2 | `mixed-excludes` | valid + `lib/**` excluded + oversized (`limits.maxFileBytes` small) + `node_modules/` | COMPLETED; ANALYZED + EXCLUDED(config) + EXCLUDED(limit) + EXCLUDED(always dir marker) |
| 3 | `literal-missing` | 1 valid + literal `contracts/Ghost.sol` | COMPLETED; NOT_FOUND ⊆ E; `clean_coverage {1,2}` |
| 4 | `all-dropped` | `contract {{{` (irrecoverable parse) | foundation throws `CompilationFailed('no source survived')` ⇒ FAILED; entry UNSUPPORTED; `{expected:1, unsupported:1, failed:0}`; `failed_stage: 'compile'`; `run: null` — **valid under A3; orthogonality pin: `run_status: 'FAILED'` with `counts.failed === 0`** |
| 5 | `syntactic-fallback` | contract with undeclared call | COMPLETED; `run_fidelity: 'syntactic'`; `fallback_count: 1`; statuses per golden (attributable UNKNOWN ⇒ UNRESOLVED) |
| 6 | `run-abort` | real inventory (A.sol, B.sol, excluded C.sol, literal Ghost) + **injected `deps.analyze`** throwing CompilationFailed `{issues:[compilation_failed file:'B.sol'], dropped:['B.sol']}` | FAILED; B UNSUPPORTED, A FAILED, C EXCLUDED, Ghost NOT_FOUND; `failed_stage: 'compile'`; `run: null` — **orthogonality pin: one `FAILED` run carries both target-failed (`A`) and content-refused (`B`) entries; `failed = 1 ≠ 0` while run and target dimensions stay independently asserted.** (Only seam-using corpus: no environment-independent real abort exists — documented reason.) |
| 7 | `only-excluded` | single file excluded by pattern | real `NoSourcesFound` ⇒ FAILED; all EXCLUDED; `expected: 0`; `clean_coverage {1,1}`; rates `{0,1}`; `failed_stage: 'discover'` |

**Interfaces:**
- Consumes: `analyzeProjectScoped` (T9/T10), `serializeScopeReport` (T8).
- Produces: golden JSON files; test harness convention: test **writes** the golden when `UPDATE_GOLDEN=1`, otherwise compares.

- [ ] **Step 1: Write the failing test** — `it` names:
  - `each corpus matches its frozen golden byte-for-byte`.
  - `each corpus serializes byte-identically on a second run` (determinism).
  - `no golden contains an absolute path or ISO timestamp` [RF4].
  - `explicit partition assertions` per the table (statuses, counts, `run_status`, `failed_stage`, `run_fidelity`, metrics values — exact numbers, not just golden equality).
  - `run_status and entry status are orthogonal` [wording lock] — on `all-dropped`: `run_status === 'FAILED'` AND `counts.failed === 0` AND `counts.unsupported === 1` (run outcome and target failure asserted independently); on `run-abort`: `run_status === 'FAILED'` with `counts.failed === 1` AND `counts.unsupported === 1` (one run, two distinct target-accounting outcomes).
  - `static import gate: src/scope imports only the allowlist` [A2] — scan `src/scope/**/*.ts` for `from '…'`/`import '…'`: allow `node:fs|node:path|node:crypto|zod` and relative specifiers resolving inside `src/`; reject `eval(`, `require(`, `node:child_process`, `node:net`, `http`.

- [ ] **Step 2: Run test to verify it fails** — goldens absent → FAIL.

- [ ] **Step 3: Generate goldens** — `UPDATE_GOLDEN=1 npx vitest run tests/scope/golden.test.ts`, then **eyeball each JSON** (statuses/counts match the table; no absolute paths).

- [ ] **Step 4: Run test to verify it passes** — plain run → PASS; second run byte-identical.

- [ ] **Step 5: Full gate** — vitest + tsc.

- [ ] **Step 6: Commit** — `test(scope): freeze golden scope reports and import gate`

---

### Task 12: `docs/scope-accounting.md` + phrase-pinned test

**Files:**
- Create: `docs/scope-accounting.md`
- Test: `tests/scope/docs.test.ts`

**Interfaces:**
- Consumes: nothing (reads the docs file).
- Produces: user-facing system-of-record.

**Doc outline (mirrors spec user-facing parts):** purpose question; six-status table (§5.1 meanings + never-triggered column); precedence; inventory & denominator (E, literals, always-dirs, size/type declines, rule strings); evidence & target-attribution (INV-13 in prose); `syntactic_fallback` = fidelity evidence, never a status (OD-4); UNSUPPORTED vs FAILED attribution rule (OD-3, no message parsing); two-branch failure attachment; metrics table with the **verbatim §10 sentence**; companion-set (INV-14) note; one example report; forbidden-aliases section; v1 limits (in-process, no CLI/sqlite, `source_file` only); link to `docs/scope-accounting-spec.md`.

- [ ] **Step 1: Write the failing test** — `it` names:
  - `docs state clean_coverage is not semantic completeness` — file contains the exact sentence: `` `clean_coverage` measures pipeline reach without known target-level gaps. It is not a measure of semantic completeness, security coverage, recon soundness, audit coverage, or risk reduction. `` (verbatim `toContain`) [RF2].
  - `docs never use coverage as a bare metric name` — content matches `/\bcov\b/` only inside `clean_coverage` (i.e. no standalone "coverage"; `_` counts as a word char, so `\bcov` cannot match inside `clean_coverage`); no `recon completeness`, `understanding percentage`.
  - `docs document all six statuses and the fallback fidelity rule` — `toContain` each status token + `fidelity evidence`.

- [ ] **Step 2: Run test to verify it fails** → FAIL (file missing).

- [ ] **Step 3: Implement `docs/scope-accounting.md`** per the outline (exact §10 sentence copied from the spec).

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Full gate** — vitest + tsc + `git diff --name-only` ⊆ allowed set (final gate, spec §13).

- [ ] **Step 6: Commit** — `docs(scope): user-facing scope accounting system-of-record`

---

## Final verification (after Task 12)

- [ ] `npx vitest run` — green (399 baseline + all new suites).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `git diff --name-only` ⊆ `src/scope/**`, `tests/scope/**`, `src/recon/discover.ts`, `src/errors/errors.ts`, `docs/**`.
- [ ] Foundation untouched beyond OD-6: `git diff src/recon/discover.ts` shows only added `export` keywords; `git diff src/errors/errors.ts` shows only the union member.
- [ ] `serializeReconState` byte-identity spot check (INV-8) — Task 10 suite covers it.
