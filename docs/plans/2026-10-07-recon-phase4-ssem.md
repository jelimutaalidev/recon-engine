# Phase 4 SSEM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `semantic-model/v1` derived artifact (state transitions, custody, accounting, authority, trust, epistemic ladder) as read-only deterministic derivation over the frozen Phase 1–3 `AnalysisResult`, with SINV-1..14 validation, `semantic_hash`, and a 9-corpus golden/adversarial test suite — no ReconState mutation, no second parser, no findings.

**Architecture:** Phase 1–3 frozen `AnalysisResult` → read-only SSEM intake (`src/semantic/evidence.ts`, indexed views over state + issues) → deterministic layer derivations (B–G) → `SemanticModel` envelope → `validateSemanticModel` (SINV-1..14) → `semantic_hash` (excludes binding fields per OD-3) → serialize. ReconState v1 is never written; the artifact is a separate versioned output returned in-process by `analyzeProjectSemantic`.

**Tech Stack:** TypeScript, zod (strict objects), node:crypto (sha256), vitest. Mirrors `src/scope/**` structure, import-gate, and golden conventions from Phase 3.

**Spec:** `docs/phase-4-ssem-spec.md` — APPROVED 2026-10-07 (amendments F-01..F-14 in `3847bf8`, status in `0137fcd`). The spec is normative; this plan argues from it and must not redesign it. Tracking issue: #5.

**Baseline:** 530 tests green (`npx vitest run` — run UNPIPED), `npx tsc --noEmit` clean (allow ≥600s).

## Global Constraints

- Phase 1–3 frozen. Foundation touch budget = **T-1 only**: append `| 'InvalidSemanticModel'` to `ReconErrorCode` (`src/errors/errors.ts`). Nothing else outside `src/semantic/**`, `tests/semantic/**`, `fixtures/**` (new), `docs/**` may change.
- No writes to `src/recon-state/**`, `src/traceability/**`, `src/scope/**`, `src/recon/**`, `src/epistemic/**`, `src/domain/**`, `migrations/**`. Intake is read-only; `deriveSemanticDraft` must not mutate `state` (test pins byte-identity).
- No second parser, no IR import: `src/semantic/**` must not import `src/recon/ir` (OD-1 state-only; enforced by import-gate forbidden token `recon/ir`).
- Evidence-first: no name-based semantic classification. Forbidden evidence (spec §2.3): identifier names, modifier invocation names, string literals, event-name lookalikes, out-of-scope selector heuristics. Unpinned classification ⇒ `'unknown'` (OD-8).
- Evidence classes: `E1` compiler-verified, `E2` structural over in-scope compiled E1, `E3` unresolved. Classes never upgrade (SINV-6).
- Epistemic ladder: `FACT → OBSERVATION → ASSUMPTION → CANDIDATE INVARIANT → HYPOTHESIS`. Confidence forced: `OBSERVATION→DERIVED`, `ASSUMPTION→INFERRED`, `HYPOTHESIS→SPECULATIVE`. Statuses: `OPEN|SUPPORTED|WEAKENED|REJECTED`. No `CONFIRMED` anywhere. Candidate invariants are not findings.
- `schema_version: 'semantic-model/v1'` (z.literal). Statuses: `COMPLETE|PARTIAL|FAILED`.
- Record id prefixes (spec §5.2), `semanticContentId(prefix, payload) = prefix + ':' + sha256(stableStringify(payload)).hex.slice(0, 16)`, prefixes declared locally — **no** `src/ids` edit: `semc, semt, sema, semk, semcl, semacc, semau, semdep, semtc, semobs, semasm, semhyp, seminv`.
- Artifact epistemic schemas are **local mirrors of Phase 1 shapes** with exactly the §5.3 divergences: semantic id prefixes, semantic `based_on` ref patterns (state `fact:` refs still valid where cited), **`created_at` omitted**. Read-only imports from `src/epistemic/**` are allowed only for constraint-free pieces (`confidenceSchema`, status enums, `ProvenanceSchema`/`Provenance`).
- Forbidden vocabulary in output records (spec §2.1): `vulnerable`, `exploit`, `severity`, `critical`, `finding`, `attack`, `PoC`, `confirmed` (as status). Failure envelopes carry `{ code, stage }` only — no messages, no paths.
- Determinism: no `Date.now`, `Math.random`, absolute paths, ISO timestamps, backslashes, or `root` strings in artifact content. Every array sorted with `compareCodeUnits` by id before finalize; serialization = `stableStringify`.
- `semantic_hash = sha256(stableStringify(payload))` where payload = model with `semantic_hash` removed **and** `binding.{run_id, input_manifest_hash, scope_hash}` removed (OD-3); binding fields re-derived at validation (SINV-11).
- OD-8 is a plan-time prerequisite: C3 (Task 5), E6 (Task 7), F1 (Task 8) pin lists are derived from actual corpus ABI evidence (Task 15 fixture sources analyzed) **before** those classification steps execute. Unpinned ⇒ `'unknown'`.
- Every task: RED test first, then minimal implementation, then full gate `npx vitest run && npx tsc --noEmit`, then commit. Existing 530 tests must never be modified (diff gate: `git diff --name-only` ⊆ allowed set for that task).

## Review Focus

Spec-implied inputs/failures no single extraction rule tests; each line is pinned in the owning task:

1. **Fixture states with no `traceability.runs`** (in-process corpus states): `binding.run_id`/`input_manifest_hash` must be *absent*, and SINV-11 must skip re-derivation "when provided" — most likely first break: validator demands a run that does not exist. → Task 10, test `validate.test.ts > binding absent when state has no current run`.
2. **Composed scope report excluding a file whose provenance record the artifact copied**: SINV-12 must fail without a degradation note, pass with one. → Task 12, test `analyze.test.ts > scope conflict requires degradation note`.
3. **Phase 1-shaped records smuggled into the artifact** (`created_at` key, `obs:` id, `asm:` basis ref): strict schemas must reject them and the leakage scan must flag ISO content. → Task 2 (`model.test.ts > epistemic mirrors reject Phase 1 ids and created_at`) and Task 10 (`validate.test.ts > leakage scan flags ISO timestamp`).
4. **Name-based classification bait**: `uint256 public collateral;` (untyped), `onlyOwner` modifier without in-scope ownership interface, `oracle`-named state var, `setAdmin` setter: zero classification beyond E1/E2, unknown index populated. → Task 5 + Task 7 unit tests, and Task 13 `ambiguous` golden word-count assertion.
5. **FAILED envelope leakage**: derivation/validator failure must yield `{code, stage}` with empty layer arrays, containing no message/path — most likely first break: copying `error.message` into the envelope. → Task 12, test `analyze.test.ts > semantic failure yields deterministic envelope without messages`.

## File Structure

```
src/errors/errors.ts                     MODIFY: | 'InvalidSemanticModel'  (T-1, Task 1)
src/semantic/
  index.ts          barrel (required by import gate)
  ids.ts            semanticContentId + prefix table            (Task 1)
  pins.ts           frozen OD-8 pin lists (ERC20 now; C3/E6/F1 in Tasks 5/7/8)
  model.ts          strict zod: envelope, all record types, enums, SemanticDraft (Task 2)
  evidence.ts       read-only intake: EvidenceIndex over state/issues + provenance resolution (Task 3)
  transitions.ts    Layer B rules B1–B7                          (Task 4)
  custody.ts        Layer C rules C1–C7                          (Task 5)
  accounting.ts     Layer D relations                            (Task 6)
  authority.ts      Layer E rules E1–E6                          (Task 7)
  trust.ts          Layer F rules F1–F5                          (Task 8)
  ladder.ts         Layer G observations→assumptions→invariants→hypotheses (Task 9)
  validate.ts       SINV-1..14, fixed order, InvalidSemanticModel (Task 10)
  report.ts         finalizeSemanticModel / computeSemanticHash / serialize (Task 11)
  analyze.ts        analyzeProjectSemantic + failure envelope     (Task 12)
tests/semantic/
  import-gate.test.ts  ids.test.ts  model.test.ts  evidence.test.ts
  transitions.test.ts  custody.test.ts  accounting.test.ts  authority.test.ts
  trust.test.ts  ladder.test.ts  validate.test.ts  report.test.ts  analyze.test.ts
  pins.test.ts  golden.test.ts  docs-phrases.test.ts
  golden/{vault,lending,staking,amm,oracle-dependent,upgradeable-proxy,
          role-based,callback-token,ambiguous}.json
fixtures/semantic.ts       in-process corpus state builders (no fs walk)
fixtures/solidity/semantics/{lending,staking,amm,oracle,proxy,roles,callback,ambiguous}/*.sol
docs/phase-4-ssem.md       user-facing record (Task 14)
```

## Coverage Map (spec §20 waves → plan tasks)

| Wave | Spec tasks | Plan task(s) | Deliverable |
|---|---|---|---|
| W0 | spec approval → issue → plan | **done in this session** (`3847bf8`, `0137fcd`, issue #5, this plan) | approved spec + plan |
| W1 | T1, T2 | Task 1, Task 2 | errors budget, skeleton, ids, `model.ts` schemas |
| W2 | T3 | Task 3 + **Task 15** (plan-level: corpus Solidity sources, §16.1 substrate + OD-8 evidence) | intake index, corpus sources |
| W3 | T4, T5 | Task 4, Task 5 | transitions B, custody C (+ C3 pins) |
| W4 | T6 | Task 6 | accounting D |
| W5 | T7, T8 | Task 7, Task 8 | authority E (+ E6 pins), trust F (+ F1 pins) |
| W6 | T9 | Task 9 | epistemic ladder G |
| W7 | T10, T11 | Task 10, Task 11 | validator, hash/serialize |
| W8 | T12 | Task 12 | wrapper + scope composition |
| W9 | T13 | Task 13 | 9 goldens + all gates |
| W10 | T14 | Task 14 | docs record, phrase gate, OD rulings, final gates |

Task 15 is plan-level (spec waves presuppose corpus fixtures exist; §4.2 lists their paths, §16.1 their contents). It is ordered in W2 so OD-8 pin-dependent Tasks 5/7/8 can execute; no spec task is redefined.

## Open Decisions: handling (spec §21 — no resolution by assumption)

| OD | Plan handling |
|---|---|
| OD-1 IR access | CONVERSED TO CONSTRAINT: state-only intake. No `recon/ir` import (import gate). T-2 never executed. |
| OD-2 state projection | SAFE TO DEFER: zero ReconState writes; byte-identity test in Task 3. |
| OD-3 hash binding fields | CONSTRAINT: §13.3 exclusion implemented + tested in Task 11. |
| OD-4 persistence | SAFE TO DEFER: no fs writes in `src/semantic/**` (import gate forbids `writeFile`). |
| OD-5 invariant home | SAFE TO DEFER: invariants live in artifact envelope only. |
| OD-6 evidence threshold | CONSTRAINT: in-scope compiled evidence only; out-of-scope recognition ⇒ `unknown` (Task 8 test). |
| OD-7 failure envelope | CONSTRAINT: non-fatal FAILED envelope (Task 12 test). |
| OD-8 pin lists | PLAN-TIME PREREQUISITE: Task 15 before Tasks 5/7/8 classification steps; `pins.ts` records derived lists with corpus citations; `pins.test.ts` asserts pins ⊆ corpus ABI evidence and goldens never classify unpinned. |

---

### Task 1: Foundation budget + module skeleton + ids + import gate (spec W1-T1)

**Files:**
- Modify: `src/errors/errors.ts:25` (union, append after `'InvalidScopeReport'`)
- Create: `src/semantic/ids.ts`, `src/semantic/pins.ts`, `src/semantic/index.ts` + one-line barrel re-exports for every §4.2 module (stubs)
- Test: `tests/semantic/ids.test.ts`, `tests/semantic/import-gate.test.ts`

**Interfaces:**
- Consumes: `stableStringify`, `compareCodeUnits` (`src/util/canonical.ts`), `ReconErrorCode` union pattern.
- Produces: `export const SEMANTIC_ID_PREFIXES = ['semc','semt','sema','semk','semcl','semacc','semau','semdep','semtc','semobs','semasm','semhyp','seminv'] as const;` `export type SemanticIdPrefix = (typeof SEMANTIC_ID_PREFIXES)[number];` `export function semanticContentId(prefix: SemanticIdPrefix, payload: unknown): string;` `export const ERC20_PINS: readonly string[]` (spec §7 C2 frozen set: `transfer(address,uint256)`, `approve(address,uint256)`, `balanceOf(address)`, `transferFrom(address,address,uint256)`) in `pins.ts`. Error code `'InvalidSemanticModel'` available everywhere.

- [ ] **Step 1: Write failing tests**

`tests/semantic/ids.test.ts`:
- `semanticContentId('semc', { a: 1 })` matches `/^semc:[0-9a-f]{16}$/`.
- Key-order independence: `semanticContentId('semt', { a: 1, b: 2 })` === `semanticContentId('semt', { b: 2, a: 1 })`.
- Distinct prefixes ⇒ distinct ids for same payload.
- Byte-identity with `contentId('fact', payload)` algorithm: for any payload, `semanticContentId('semc', payload)` === `contentId('semc' as never, payload)`-style digest — assert by recomputing `sha256(stableStringify(payload)).slice(0,16)` inline.
- Every prefix in `SEMANTIC_ID_PREFIXES` is unique and matches `/^sem[a-z]+$/`.

`tests/semantic/import-gate.test.ts`: clone the structure of `tests/scope/import-gate.test.ts` (same `listSourceFiles`, `importSpecifiers`, `FORBIDDEN_SUBSTRINGS`, dynamic-import check, barrel-required check) with `SRC_SCOPE` → `src/semantic`, `ALLOWED_SPECIFIERS = new Set(['zod', 'node:crypto'])` (relative specifiers allowed), plus forbidden tokens `'recon/ir'`, `'writeFile'`, `'http'`, `'fetch('`, `'eval('`, `'child_process'`, `'node:net'`, `'import('`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/semantic/ids.test.ts tests/semantic/import-gate.test.ts`
Expected: FAIL — `semanticContentId` not exported; import-gate fails on missing `src/semantic` barrel/files.

- [ ] **Step 3: Add `'InvalidSemanticModel'` to the union and create `ids.ts`, `pins.ts`, stub modules + `index.ts` barrel**

One line in `src/errors/errors.ts`. `ids.ts`: `semanticContentId` = `` `${prefix}:${createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0,16)}` `` (exact `contentId` algorithm, `src/ids/ids.ts:61-64`). Every other `src/semantic/*.ts` stub: `export {};` placeholder plus the one import the barrel needs — keep stubs empty of behavior (Tasks 2–12 fill them). Also extend the existing foundation-exports pattern: add one assertion to `tests/scope/foundation-exports.test.ts`? **No** — Phase 3 tests are frozen. Instead assert the union membership in `tests/semantic/ids.test.ts`: `expect(new ReconError('InvalidSemanticModel', 'x', { reason: 'schema' }).code).toBe('InvalidSemanticModel')`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/semantic/ && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/errors/errors.ts src/semantic tests/semantic
git commit -m "feat(semantic): T-1 error code, module skeleton, semanticContentId, import gate"
```

---

### Task 2: Artifact schemas — `model.ts` (spec W1-T2, §5)

**Files:**
- Create: `src/semantic/model.ts`
- Test: `tests/semantic/model.test.ts`

**Interfaces:**
- Consumes: `semanticContentId` (Task 1), `confidenceSchema` + status enums + `ProvenanceSchema` (read-only from `src/epistemic/*`), enum sources for `ASSET_TYPES`/`ROLE_TYPES`/`DEPENDENCY_TYPES` (read-only imports from `src/domain/enums.js`).
- Produces (exact names later tasks use):
  - `SemanticModelSchema` / `SemanticModel` — envelope per spec §5.1: `{ schema_version: 'semantic-model/v1', status: 'COMPLETE'|'PARTIAL'|'FAILED', failure?: { code: string; stage: string }, input: { fidelity, state_output_hash, file_count, degradation?: string[] }, binding: { run_id?, input_manifest_hash?, scope_hash? }, contracts: ContractSemantics[], transitions: StateTransition[], assets: AssetRecord[], custody: CustodyRecord[], claims: ClaimRecord[], accounting: AccountingRelation[], authority: AuthorityChain[], trust: { dependencies: ExternalDependency[]; capabilities: TrustCapability[] }, epistemic: { observations: SemanticObservation[]; assumptions: SemanticAssumption[]; hypotheses: SemanticHypothesis[]; invariants: CandidateInvariant[] }, unknowns: UnknownIndexEntry[], counts: { …13 numeric fields per §5.1 }, semantic_hash: string }` — strictObject everywhere.
  - `SemanticDraft` = same shape minus `semantic_hash` and `counts` (finalize computes them).
  - Record schemas with field sets verbatim from spec: `ContractSemanticsSchema` (§5.3), `StateTransitionSchema` (§6 table), `AssetRecordSchema` (§5.3; `name` required), `CustodyRecordSchema`, `ClaimRecordSchema`, `AccountingRelationSchema` (§8 fields), `AuthorityChainSchema` (§9), `ExternalDependencySchema`, `TrustCapabilitySchema` (§10), `SemanticObservationSchema`, `SemanticAssumptionSchema`, `SemanticHypothesisSchema`, `CandidateInvariantSchema` (`based_on` regex `/^(?:semasm|semhyp|semobs):.+/`), `UnknownIndexEntrySchema` (§5.3 reason enum: `unresolved_call|unsupported_assembly|out_of_scope_target|no_evidence|syntactic_fidelity|dropped_file`).
  - Enums: `EVIDENCE_CLASSES = ['E1','E2','E3']`, `SEMANTIC_STATUSES`, `INVARIANT_STATUSES`, `SEMANTIC_STAGES = ['intake','transitions','custody','accounting','authority','trust','ladder','finalize','validate'] as const`.
  - Ref patterns: `SEM_OBS_REF = /^semobs:.+/`, `SEM_ASM_REF = /^semasm:.+/`, `SEM_EPISTEMIC_REF = /^(?:semobs|semasm|semhyp):.+/`, state refs reuse read-only `FACT_REF_PATTERN` / `ENTITY_REF_PATTERN` from `src/epistemic/refs.js`.

- [ ] **Step 1: Write failing tests** (`tests/semantic/model.test.ts`)
  - `SemanticModelSchema.parse` accepts a minimal valid envelope fixture (all arrays empty, `schema_version: 'semantic-model/v1'`, `status: 'COMPLETE'`, `input.state_output_hash` 64-hex, `semantic_hash` 64-hex, `counts` all 0).
  - Strict rejection: passing `{ …fixture, unexpected: 1 }` throws; passing envelope with `created_at` anywhere in an epistemic record throws (strictObject).
  - `SemanticObservationSchema` rejects id `obs:abc` and accepts `semobs:abc123`; rejects `created_at` key.
  - `SemanticAssumptionSchema.based_on` accepts `semobs:…`, rejects `obs:…`; confidence must be `{ level: 'INFERRED' }` (wrong level throws).
  - `CandidateInvariantSchema.based_on` accepts `semasm:…`, rejects `asm:…`; `status` ∈ 4 values, `CONFIRMED` throws.
  - `SemanticModelSchema` rejects `status: 'CONFIRMED'`, rejects forbidden status `vulnerable`-style enum values via `failure` exclusivity: `status: 'FAILED'` requires `failure`, `status: 'COMPLETE'` rejects `failure`.
  - Round-trip: `SemanticModelSchema.parse(fixture)` returns equal object (no coercions/default mutations — no `.default()` on required lists).

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/semantic/model.test.ts` (module missing).

- [ ] **Step 3: Implement `model.ts` schemas** per Interfaces block; bodies are pure zod declarations copying field sets from spec §5–§10 (no derivation logic — that is Tasks 4–9).

- [ ] **Step 4: Run to verify PASS** — `npx vitest run tests/semantic/model.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(semantic): semantic-model/v1 zod schemas (envelope + records + enums)`.

---

### Task 3: Read-only intake — `evidence.ts` (spec W2-T3, §4.1, §12, OD-2)

**Files:**
- Create: `src/semantic/evidence.ts`
- Test: `tests/semantic/evidence.test.ts`

**Interfaces:**
- Consumes: `ReconState`, `ReconIssue`, `AnalysisResult.meta` types; `buildGraphIndex` (`src/relationships/graph.ts:16`); `computeOutputIdentity` (`src/traceability/identities.ts:103`); state collections (`facts`, `relationships`, `contracts`, `functions`, `state_variables`, `assets`, `roles`, `dependencies`, `provenance`, `traceability`).
- Produces:
  ```ts
  export interface SemanticInput {
    state: ReconState;
    issues: ReconIssue[];
    meta: { fidelity: 'semantic' | 'syntactic'; fileCount: number };
    scopeReport?: ScopeReport;
  }
  export interface EvidenceIndex {
    factsById: Map<string, Fact>;
    relationshipsById: Map<string, Relationship>;
    functionsById: Map<string, SolidityFunction>;
    contractsById: Map<string, Contract>;
    stateVariablesById: Map<string, StateVariable>;
    issuesByFile: Map<string, ReconIssue[]>;
    graph: GraphIndex;
    provenanceById: Map<string, Provenance>;
    stateHash: string;            // computeOutputIdentity(state).output_hash
    currentRun?: { run_id: string; input_manifest_hash?: string };
    input: SemanticInput;
  }
  export function buildEvidenceIndex(input: SemanticInput): EvidenceIndex;
  export function resolveProvenanceCopy(index: EvidenceIndex, prov: Provenance): boolean; // byte-equality vs state registry/fact/relationship copies (§12.3)
  ```
  `currentRun` lookup = `state.traceability?.runs.find(r => r.output_identity?.output_hash === index.stateHash)` (mirror `src/scope/validate.ts:360-371`).

- [ ] **Step 1: Write failing tests** (`tests/semantic/evidence.test.ts`)
  - Fixture: `buildVaultState()` from `fixtures/vault.ts` + synthetic `issues: []`, `meta: { fidelity: 'semantic', fileCount: 1 }`.
  - `buildEvidenceIndex` indexes every fact/relationship/function/contract/state_variable by id (spot-assert ≥1 and total counts equal array lengths).
  - `stateHash` equals `computeOutputIdentity(state).output_hash`.
  - **Read-only:** `JSON.stringify(state)` before === after `buildEvidenceIndex` + a sample derive call (byte-identity, OD-2).
  - `currentRun` is `undefined` for the vault fixture (no `traceability`) — pins Review Focus #1 at intake.
  - `resolveProvenanceCopy` returns true for a provenance record cloned from a state fact's embedded provenance, false for a mutated line number (SINV-4 substrate).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `buildEvidenceIndex`** (Map construction + graph + run lookup + hash); `resolveProvenanceCopy` compares `stableStringify` equality against registry and embedded fact/relationship provenance.

- [ ] **Step 4: Run to verify PASS + full gate** — `npx vitest run && npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(semantic): read-only evidence intake index with run lookup and provenance resolution`.

---

### Task 4: Layer B — transitions (spec W3-T4, §6)

**Files:**
- Create: `src/semantic/transitions.ts`
- Test: `tests/semantic/transitions.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex` (Task 3), `StateTransitionSchema` (Task 2).
- Produces: `export function deriveTransitions(index: EvidenceIndex): { transitions: StateTransition[]; unknowns: UnknownIndexEntry[]; flags: Set<string> /* function ids touched by fidelity flags */ };`

- [ ] **Step 1: Write failing tests** (`tests/semantic/transitions.test.ts`, in-process mini-states per Phase 3 fixture isolation)
  - B1: function with `READS`/`WRITES` relationships ⇒ `pre_state_reads`/`writes` populated, sorted by state-var id; function with none ⇒ empty sets (proved by extraction).
  - B2: resolved in-scope `CALLS` ⇒ `target_ref` present, `target_evidence: 'E1'`; unresolved low-level call ⇒ no `target_ref`, `target_evidence: 'E3'`, unknown entry `unresolved_call`; `metadata.call_kind` flows into `call_kind`.
  - B3: `mutability: 'payable'` ⇒ `value_handling: 'payable'`; `'nonpayable'` ⇒ `'nonpayable'`. (Field name `mutability` — never `stateMutability`.)
  - B4: no Layer C evidence ⇒ no `asset_movements` records (never verb-named guessing).
  - B5: `EMITS` facts ⇒ `post_state_observations` fact ids; none ⇒ empty.
  - B6: issue `unsupported_assembly` touching function's file ⇒ `fidelity_flags` contains `assembly_skipped`; dropped file ⇒ no transition record + unknown entry `dropped_file`.
  - B7: two effects with spans on files `a.sol`/`b.sol` inserted reversed ⇒ output order by `(span.file, span.byteStart)`.
  - Honesty: transition object has no keys named `executes`, `path`, `order`, `value` (branch-insensitive declaration).

- [ ] **Step 2: Run to verify FAIL.** [ ] **Step 3: Implement B1–B7** exactly per §6 rule table (failure column decides unknown-vs-empty). [ ] **Step 4: PASS + full gate.** [ ] **Step 5: Commit** — `feat(semantic): state transition derivation B1-B7`.

---

### Task 5: Layer C — assets/custody/claims (spec W3-T5, §7) — **OD-8 prerequisite: C3 pins**

**Files:**
- Create: `src/semantic/custody.ts`, extend `src/semantic/pins.ts`
- Test: `tests/semantic/custody.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, `AssetRecordSchema`/`CustodyRecordSchema`/`ClaimRecordSchema`, `ERC20_PINS` (Task 1), corpus Solidity sources (Task 15).
- Produces: `export function deriveAssets(index: EvidenceIndex): { assets: AssetRecord[]; custody: CustodyRecord[]; claims: ClaimRecord[]; unknowns: UnknownIndexEntry[] };` and `pins.ts` additions: `export const SHARE_PINS`, `DEBT_PINS`, `COLLATERAL_PINS`, `REWARD_PINS`, `LP_PINS: readonly string[]` — each entry citing its corpus source (`// OD-8: derived from fixtures/solidity/semantics/<x> ABI, <standard> surface`).

- [ ] **Step 1 (OD-8 PREREQUISITE): Derive C3 pin lists from corpus ABI evidence.** Analyze each Task 15 fixture (`npx vitest run tests/semantic/pins.test.ts --reporter=verbose` once its scaffold lands, or a one-off `analyzeProject` in a scratch vitest) and record the exact signature subsets actually exercised (share/debt/collateral/reward/LP) into `pins.ts`. If a class has no corpus evidence, **omit its pins** (classification stays `'unknown'` — do not invent lists).
- [ ] **Step 2: Write failing tests** (`tests/semantic/custody.test.ts`)
  - C1: state var typed with in-scope contract ⇒ candidate `AssetRecord` with `asset_type: 'unknown'`, `evidence_class: 'E2'`, `basis` ≥1; plain `address` var ⇒ no record + unknown `no_evidence`.
  - C2: contract whose in-scope ABI declares all four `ERC20_PINS` ⇒ `asset_type: 'erc20'`; three of four ⇒ remains `'unknown'`.
  - C3: each pinned class present in fixture ABI ⇒ its `asset_type` + `represents_asset_id` pairing when co-occurring; **unpinned** class ⇒ `'unknown'` (pins-missing path).
  - C4: asset-typed var in contract X ⇒ `CustodyRecord{location_kind: 'contract'}`; no holder ⇒ absent (EOA never guessed).
  - C5: holder-side function reads representation balance + entitlement surface ⇒ `ClaimRecord` with `epistemic: 'observation'`; else absent.
  - C6: payable contract ⇒ contract-level unknown `no_evidence`, **zero** native `AssetRecord`s.
  - C7: movement without C-recognized asset ⇒ `asset_ref` absent + unknown.
  - **Name-bait (Review Focus #4):** `uint256 public collateral;` ⇒ zero classified assets, unknown populated.

- [ ] **Step 3: Run to verify FAIL.** [ ] **Step 4: Implement C1–C7.** [ ] **Step 5: PASS + full gate.** [ ] **Step 6: Commit** — `feat(semantic): asset/custody/claim derivation C1-C7 with OD-8 C3 pins`.

---

### Task 6: Layer D — accounting (spec W4-T6, §8)

**Files:** Create `src/semantic/accounting.ts`; Test `tests/semantic/accounting.test.ts`

**Interfaces:**
- Consumes: `deriveAssets` outputs (Task 5), `EvidenceIndex`, corpus fee surfaces (Task 15).
- Produces: `export function deriveAccounting(index: EvidenceIndex, assets: { assets: AssetRecord[] }): { accounting: AccountingRelation[]; unknowns: UnknownIndexEntry[] };` — `AccountingRelation` fields `{ id, relation_kind, endpoints[], derivation, evidence_class: 'E2', basis[], epistemic: 'observation', unknowns[] }`. OD-8: `pins.ts` may add `export const FEE_PINS: readonly string[]` only if corpus evidence proves a fee-split surface; empty/absent ⇒ `fees_protocol_user` emits no relation.

- [ ] **Step 1: Write failing tests**
  - `assets_shares`: C-classified asset + share co-held AND ≥1 function whose READS/WRITE set intersects both ⇒ relation with `derivation: 'paired-storage'`; co-occurrence **without** paired access ⇒ **no relation** (mandatory clause).
  - `debt_collateral`, `rewards_eligible_stake`: same shape with their classifications.
  - `reserves_liquidity`: C-classified asset + LP only (native never modeled — assert no relation from `.balance` evidence).
  - `fees_protocol_user`: only via pinned in-scope fee-interface evidence (OD-8; if no pins recorded ⇒ no relation — assert name-bait `uint256 fee;` yields nothing).
  - Zero relations is valid output (§11.2.5 analog): empty state ⇒ empty array, no unknown required.
- [ ] **Step 2: FAIL** [ ] **Step 3: Implement D rules.** [ ] **Step 4: PASS + gate.** [ ] **Step 5: Commit** — `feat(semantic): accounting relation derivation (evidence-gated)`.

---

### Task 7: Layer E — authority (spec W5-T7, §9) — **OD-8 prerequisite: E6 pins**

**Files:** Create `src/semantic/authority.ts`; extend `pins.ts`; Test `tests/semantic/authority.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, transition outputs (Task 4) for `transition_id`/impact links, `ROLE_TYPES` (read-only enum).
- Produces: `deriveAuthority(index: EvidenceIndex, transitions: StateTransition[]): { authority: AuthorityChain[]; unknowns: UnknownIndexEntry[] };` and `pins.ts`: `export const OWNER_PINS`, `ADMIN_PINS`, `DEFAULT_ADMIN_PINS`, `GOVERNANCE_PINS`, `MULTISIG_PINS`, `TIMELOCK_PINS`, `UPGRADER_PINS`, `PAUSER_PINS`, `GUARDIAN_PINS`, `KEEPER_PINS`, `RELAYER_PINS: readonly string[]` (interface/inheritance surfaces only; empty ⇒ unpinned ⇒ `'unknown'`).

- [ ] **Step 1 (OD-8 PREREQUISITE): Derive E6 pins** from `fixtures/solidity/semantics/roles` + `proxy` ABI evidence (in-scope role interfaces actually declared/inherited). Record with corpus citations; omit what corpus does not prove.
- [ ] **Step 2: Write failing tests**
  - E1: resolved in-scope `CALLS` into gated function ⇒ actor link E2; unknown caller ⇒ link kept with `evidence: 'E3'`, chain `status: 'partial'` (never dropped, never completed). Written address var typed by in-scope ownership interface ⇒ *stored-authority-subject* observation; plain address write ⇒ **no** actor link (Review Focus #4 variant).
  - E2: in-scope inherited role interface with role-typed storage ⇒ `authority_kind` ∈ pinned kinds; modifier invocation text alone ⇒ `authority_kind: 'unknown'` + structural observation `"modifier M gates f"`.
  - E3: gate descriptor carries `modifiers`, `visibility`, `mutability` (assert key exists — never `stateMutability`).
  - E4: transition present ⇒ `transition_id` linked; dropped transition ⇒ function-only link + unknown.
  - E5: transition with movements/effects ⇒ typed impact; none ⇒ `impact: 'unknown'`.
  - E6: pinned governance surface ⇒ `authority_kind: 'governance'`; unpinned/`onlyOwner`-named modifier w/o in-scope backing ⇒ `'unknown'` (Review Focus #4).
  - Un-gated public function ⇒ observation `"no gate observed on f"`; assert no record asserts "callable by anyone".
- [ ] **Step 3: FAIL** [ ] **Step 4: Implement E1–E6.** [ ] **Step 5: PASS + gate.** [ ] **Step 6: Commit** — `feat(semantic): authority chain derivation E1-E6 with OD-8 role pins`.

---

### Task 8: Layer F — trust (spec W5-T8, §10) — **OD-8 prerequisite: F1 pins**

**Files:** Create `src/semantic/trust.ts`; extend `pins.ts`; Test `tests/semantic/trust.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, transition outputs, `DEPENDENCY_TYPES` (read-only).
- Produces: `deriveTrust(index: EvidenceIndex, transitions: StateTransition[]): { dependencies: ExternalDependency[]; capabilities: TrustCapability[]; assumptions: SemanticAssumption[]; unknowns: UnknownIndexEntry[] };` and `pins.ts`: `export const ORACLE_PINS`, `DEX_PINS`, `BRIDGE_PINS`, `MESSENGER_PINS` … (only kinds with corpus evidence; cite `fixtures/solidity/semantics/{oracle,amm}`).

- [ ] **Step 1 (OD-8 PREREQUISITE): Derive F1 pins** from corpus ABI evidence; omit unproven kinds.
- [ ] **Step 2: Write failing tests**
  - F1: named out-of-scope call target ⇒ `ExternalDependency` with `dependency_type: 'unknown'` (+ pinned kind only when pinned mapping hits); unresolved target with no named ref ⇒ **no** dependency record + unknown `out_of_scope_target`. Out-of-scope selector-only recognition ⇒ `unknown` (OD-6).
  - F2: outbound `CALLS` with `call_kind` ⇒ `TrustCapability{direction:'observed'}`.
  - F3: public/external functions accepting addresses/calldata callbacks + in-scope hook interface ⇒ `direction:'consumed'`; not provable ⇒ field `unknown` + unknown `no_evidence` (record kept when F1 held).
  - F4: every capability carries `trust_assumption_ref` pointing at a `SemanticAssumption` with `confidence.level: 'INFERRED'`, `status: 'OPEN'`; capability without assumption ⇒ validator will fail (assert derivation always emits it).
  - F5: `failure_semantics: 'unknown'` with unknown `no_evidence` (no data-flow claims).
  - Trust posture: record fields contain no `severity`/`unsafe`/`status: vulnerable` keys (forbidden vocab scan input).
- [ ] **Step 3: FAIL** [ ] **Step 4: Implement F1–F5.** [ ] **Step 5: PASS + gate.** [ ] **Step 6: Commit** — `feat(semantic): external dependency/trust derivation F1-F5 with OD-8 dependency pins`.

---

### Task 9: Layer G — epistemic ladder (spec W6-T9, §11–§12)

**Files:** Create `src/semantic/ladder.ts`; Test `tests/semantic/ladder.test.ts`

**Interfaces:**
- Consumes: B–F outputs (Tasks 4–8), `EvidenceIndex`, local epistemic schemas (Task 2).
- Produces: `export function deriveLadder(index: EvidenceIndex, layers: { transitions; assets; accounting; authority; trust }): { observations: SemanticObservation[]; assumptions: SemanticAssumption[]; invariants: CandidateInvariant[]; hypotheses: SemanticHypothesis[]; unknowns: UnknownIndexEntry[] };`

- [ ] **Step 1: Write failing tests**
  - Observation from state facts ⇒ `based_on` = state `fact:` ids ≥1, `confidence: { level: 'DERIVED' }`, id `semobs:`.
  - Observation fallback path: entity-only basis ⇒ `provenance` copies byte-equal state registry records (§12.3) — mutated copy ⇒ derivation refuses (no record).
  - Assumption: `based_on` = `semobs:` refs ≥1, `INFERRED`, `status: 'OPEN'`.
  - Candidate invariant: statement phrasing — accepts `"totalShares never exceeds accounted underlying"`, rejects via later SINV-7 any `"X is safe"`/`"X is broken"` shape (test the derivation produces only property-phrasing given template: assert generated statements never contain `safe|broken|vulnerable|confirmed`).
  - Ladder citation order: invariant `based_on` references only already-emitted assumptions/observations (acyclic — SINV-5 substrate).
  - Density: empty layers ⇒ empty arrays, valid.
  - F4 trust assumptions appear here (Task 8 hand-off), each `OPEN`.
- [ ] **Step 2: FAIL** [ ] **Step 3: Implement ladder.** [ ] **Step 4: PASS + gate.** [ ] **Step 5: Commit** — `feat(semantic): epistemic ladder derivation with forced confidence and acyclic based_on`.

---

### Task 10: Validator — SINV-1..14 (spec W7-T10, §15)

**Files:** Create `src/semantic/validate.ts`; Test `tests/semantic/validate.test.ts`

**Interfaces:**
- Consumes: `SemanticModelSchema`, all records, `computeOutputIdentity`, `validateScopeReportWithState`-style read-only scope inspection (own file/status lookups — **do not** call/fork Phase 3 validator logic; mirror only the pattern), `ReconError`.
- Produces:
  ```ts
  export type SinvReason = 'schema'|'ids_unsorted'|'basis_missing'|'basis_unresolvable'|'provenance_incomplete'
    |'epistemic_upgrade'|'epistemic_leak'|'unattributed'|'unknown_flattened'|'hash_mismatch'|'leakage'
    |'binding_mismatch'|'scope_conflict'|'fidelity_mismatch'|'envelope_invalid';
  export function validateSemanticModel(model: unknown, ctx: { state: ReconState; scopeReport?: ScopeReport }): SemanticModel;
  ```
  Throws `new ReconError('InvalidSemanticModel', message, { reason })`. Fixed check order SINV-1→14 (spec table).

- [ ] **Step 1: Write failing tests** — one accepted + one rejected path per reason (§16.2.2), minimum set:
  - SINV-1 `schema`: wrong `schema_version`, `FAILED` without `failure`.
  - SINV-2 `ids_unsorted`: swapped array order; duplicate id; `counts` mismatch.
  - SINV-3 `basis_missing`: record with `basis: []`.
  - SINV-4 `basis_unresolvable`: basis id not in state/artifact; provenance copy with altered line (byte-equality).
  - SINV-5 `provenance_incomplete`: `based_on` cycle; root without provenance.
  - SINV-6 `epistemic_upgrade`: observation with `INFERRED`; E3 record whose class was bumped (re-derive comparator path); hosting violation (state-mutating record shape if detectable — assert forced-confidence + class-recompute checks fire).
  - SINV-7 `epistemic_leak`: statement containing `"is vulnerable"`; invariant `status: 'CONFIRMED'`.
  - SINV-8 `unattributed`: record whose basis traces to no state entity.
  - SINV-9 `unknown_flattened`: unknown field without ledger entry; no-record branch without entry (proved-empty exemption: B1 empty set passes).
  - SINV-10 `hash_mismatch` + `leakage`: tampered `semantic_hash`; ISO-timestamp-shaped value; absolute path; backslash. (**Review Focus #3.**)
  - SINV-11 `binding_mismatch`: `state_output_hash` ≠ `computeOutputIdentity`; provided `run_id` ≠ current run; **accepted path: fixture state without runs + absent binding fields** (**Review Focus #1**).
  - SINV-12 `scope_conflict`: reference into `EXCLUDED` file ⇒ fail; into `UNRESOLVED` file without degradation note ⇒ fail; with note ⇒ pass. (**Review Focus #2.**)
  - SINV-13 `fidelity_mismatch`: `input.fidelity: 'syntactic'` + `status: 'COMPLETE'` ⇒ fail; with `PARTIAL` + degradation ⇒ pass.
  - SINV-14 `envelope_invalid`: `FAILED` with non-empty arrays; `COMPLETE` with degradation.
- [ ] **Step 2: FAIL** [ ] **Step 3: Implement validator** in fixed order with `reason` mapping (spec §15 table). [ ] **Step 4: PASS + gate.** [ ] **Step 5: Commit** — `feat(semantic): SINV-1..14 validator`.

---

### Task 11: Finalize / hash / serialize (spec W7-T11, §13)

**Files:** Create `src/semantic/report.ts`; Test `tests/semantic/report.test.ts`

**Interfaces:**
- Consumes: `SemanticDraft` (Task 2), `stableStringify`, `compareCodeUnits`.
- Produces:
  ```ts
  export function finalizeSemanticModel(draft: SemanticDraft): SemanticModel;   // sort every array by id (compareCodeUnits), compute counts, attach semantic_hash
  export function computeSemanticHash(model: SemanticModel): string;            // §13.3 payload: strip semantic_hash + binding.{run_id,input_manifest_hash,scope_hash}
  export function serializeSemanticModel(model: SemanticModel): string;         // stableStringify
  ```

- [ ] **Step 1: Write failing tests**
  - Finalize sorts unsorted arrays (input deliberately reversed ⇒ code-unit order output) and `counts` equal array lengths.
  - Hash exclusion (**OD-3**): two models identical except `binding.run_id`/`input_manifest_hash`/`scope_hash` ⇒ **equal** `semantic_hash`; differing `input.state_output_hash` ⇒ different hash.
  - `computeSemanticHash(finalize(draft))` === `model.semantic_hash`.
  - Double-run: finalize twice from equal drafts ⇒ byte-identical `serializeSemanticModel` output (§13.4).
  - Leakage: serialized bytes match none of `/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/`, `/\/(home|root|Users|tmp)\//`, `\\`.
- [ ] **Step 2: FAIL** [ ] **Step 3: Implement.** [ ] **Step 4: PASS + gate.** [ ] **Step 5: Commit** — `feat(semantic): finalize, semantic_hash (OD-3), deterministic serialize`.

---

### Task 12: Wrapper — `analyzeProjectSemantic` (spec W8-T12, §4.3)

**Files:** Create `src/semantic/analyze.ts`; Test `tests/semantic/analyze.test.ts`

**Interfaces:**
- Consumes: `analyzeProject` (`src/recon/index.ts`), `analyzeProjectScoped` + `AnalyzeScopedDeps` (`src/scope/analyze.ts:44`), `buildEvidenceIndex` → layer derivations → `finalizeSemanticModel` → `validateSemanticModel`.
- Produces:
  ```ts
  export interface AnalyzeSemanticDeps { analyze?: (c: ReconConfig) => Promise<AnalysisResult>; }  // tests only; mirrors AnalyzeScopedDeps
  export async function analyzeProjectSemantic(
    config: ReconConfig,
    opts?: { withScope?: boolean },
    deps?: AnalyzeSemanticDeps,
  ): Promise<{ analysis: AnalysisResult; scopeReport?: ScopeReport; semantic: SemanticModel }>;
  ```
  Flow: analysis = withScope ? analyzeProjectScoped : analyzeProject → `SemanticInput` (+report) → derive (stages per `SEMANTIC_STAGES`) → finalize → validate(ctx {state, scopeReport}) → return. Any non-analysis error in the semantic pass ⇒ `semantic = toFailedEnvelope(code, stage)` (all layer arrays empty, `failure: {code, stage}` only) — **analysis errors rethrow unchanged** (OD-7).

- [ ] **Step 1: Write failing tests** (`deps.analyze` injected — no solc in unit tests)
  - Happy path: fake `analyze` returning vault fixture state ⇒ `semantic.schema_version === 'semantic-model/v1'`, `analysis.state` byte-identical to input state (returned object same bytes).
  - `withScope: true` ⇒ `scopeReport` present, `semantic.binding.scope_hash === report.scope_hash`, `binding.run_id` present iff state has current run.
  - Analysis throws `ReconError` ⇒ error rethrown unchanged, no envelope.
  - Derivation/validator throws ⇒ FAILED envelope: `status: 'FAILED'`, `failure.code` matches, `failure` has **no** `message`/`path` keys, all arrays empty (**Review Focus #5**), and `validateSemanticModel(envelope, ctx)` passes SINV-1/14.
  - `PARTIAL` mapping: injected `meta.fidelity: 'syntactic'` ⇒ `status: 'PARTIAL'` + `input.degradation` ≥1 sorted note (SINV-13/14).
  - Scope conflict integration: report marking a referenced file `EXCLUDED` ⇒ semantic-pass fails ⇒ envelope `stage: 'validate'` (Review Focus #2 end-to-end).
- [ ] **Step 2: FAIL** [ ] **Step 3: Implement wrapper + `toFailedEnvelope`.** [ ] **Step 4: PASS + gate.** [ ] **Step 5: Commit** — `feat(semantic): analyzeProjectSemantic wrapper with non-fatal failure envelope (OD-7)`.

---

### Task 13: Golden + adversarial corpus (spec W9-T13, §16)

**Files:**
- Create: `fixtures/semantic.ts` (9 in-process builders `buildSemanticCorpus(name: CorpusName): SemanticInput`), `tests/semantic/golden.test.ts`, `tests/semantic/golden/*.json` (9 files)
- Uses: all Tasks 1–12

**Interfaces:**
- Consumes: `buildVaultState` pattern (`fixtures/vault.ts`), `finalizeSemanticModel`/`serializeSemanticModel`, `UPDATE_GOLDEN=1` regen convention (`tests/scope/golden.test.ts:22`).
- Produces: `type CorpusName = 'vault'|'lending'|'staking'|'amm'|'oracle-dependent'|'upgradeable-proxy'|'role-based'|'callback-token'|'ambiguous'` (spec §16.1).

- [ ] **Step 1: Write pre-freeze partition assertions BEFORE freezing goldens** (§16.2.3) — per corpus, assert the semantics the corpus exists to prove, e.g.:
  - `vault`: ≥1 asset with `asset_type: 'erc20'` or pinned representation class; assets↔shares relation present iff paired access; custody record for vault contract; no out-of-scope classification.
  - `lending`: debt+collateral relation requires paired access (a control fixture without paired access ⇒ 0 relations); naming traps fail closed.
  - `staking`: reward classification only when `REWARD_PINS` hit; else `unknown`.
  - `amm`: named out-of-scope router ⇒ dependency record `type: 'unknown'` + unknown entry; unresolved target ⇒ no record (both F1 outcomes, spec §16.1).
  - `oracle-dependent`: capability has `trust_assumption_ref` with `OPEN` assumption; `failure_semantics: 'unknown'`.
  - `upgradeable-proxy`: `semantic_kind: 'proxy'` requires in-scope `DELEGATES_TO`-class/interface evidence; name-only ⇒ `unknown`.
  - `role-based`: pinned role interfaces classify; `onlyOwner` modifier without in-scope backing ⇒ `authority_kind: 'unknown'`.
  - `callback-token`: no `asset_movements` without resolved+classified asset; consumed capabilities present.
  - `ambiguous`: **zero** classified assets/authorities beyond E1/E2; unknown index populated; word-count assertion: count of records with non-`unknown` classifications equals the E1/E2-only expectation computed from the fixture; collateral/treasury/oracle/setAdmin/Transfer/mint name-bait all yield unknown/no records.
- [ ] **Step 2: Run assertions (FAIL without goldens/builders).** [ ] **Step 3: Implement `fixtures/semantic.ts` builders** (hand-built states; no filesystem walk — §16.2.3) and wire `golden.test.ts` per Phase 3 pattern: double-run byte-identity, leakage scan (`ISO_DATE`, `TIMESTAMP_KEY`, absolute path, backslash regexes copied from `tests/scope/golden.test.ts:23-24`), `UPDATE_GOLDEN=1` regen. **Fidelity-degradation states** (syntactic fallback, dropped file, assembly-bearing) as additional in-process inputs feeding SINV-13/B6 golden assertions (spec §16.2.3).
- [ ] **Step 4: Freeze goldens:** `UPDATE_GOLDEN=1 npx vitest run tests/semantic/golden.test.ts`, re-run green; commit goldens with partition assertions. [ ] **Step 5: Full gate.** [ ] **Step 6: Commit** — `test(semantic): freeze 9-corpus golden + adversarial suite`.

---

### Task 14: User-facing record + phrase gate + final gates (spec W10-T14)

**Files:** Create `docs/phase-4-ssem.md`, `tests/semantic/docs-phrases.test.ts`; Modify `docs/phase-4-ssem-spec.md` §21 OD table (rulings only)

**Interfaces:**
- Consumes: spec §2.1 forbidden vocabulary, §6 honesty statement text, §2.2 four-way terms.
- Produces: user-facing record; phrase-gate test; OD table updated with final rulings + derived pin lists referenced.

- [ ] **Step 1: Write failing phrase tests** (`tests/semantic/docs-phrases.test.ts` over `docs/phase-4-ssem.md`)
  - Required honesty sentence present (substring: `not symbolic execution` + `structural function summaries`).
  - Four-way terms present: `Asset`, `Custody`, `accounting representation`, `Claim`.
  - Forbidden vocabulary absent outside the explicitly allowed non-goal section: parse file, assert `vulnerable|exploit|severity|critical|finding|attack|PoC` occurrences ⊆ lines within a `## Non-goals` section.
  - `candidate` co-occurs with `not a finding` phrasing.
- [ ] **Step 2: FAIL** [ ] **Step 3: Write `docs/phase-4-ssem.md`** (architecture diagram from spec §4.1, honesty statement verbatim, four-way distinction, ladder, candidate ≠ confirmed, determinism/binding notes, link to spec + issue #5) **and update spec §21** OD rows: OD-1/3/6/7 marked decided-as-constrained, OD-2/4/5 marked deferred, OD-8 marked pinned-with-corpus-citations (append pin file reference `src/semantic/pins.ts`).
- [ ] **Step 4: PASS + full gate:** `npx vitest run && npx tsc --noEmit`. [ ] **Step 5: Commit** — `docs(semantic): user-facing SSEM record, phrase gate, OD rulings`.

---

### Task 15 (plan-level, W2): Corpus Solidity sources (spec §4.2/§16.1 — OD-8 substrate)

**Files:** Create `fixtures/solidity/semantics/{lending,staking,amm,oracle,proxy,roles,callback,ambiguous}/*.sol` (+ tests referencing them)

**Interfaces:**
- Consumes: `analyzeProject` + `parseReconConfig` (test-time only).
- Produces: compilable corpus sources whose ABIs are the **only** permitted OD-8 evidence; `tests/semantic/pins.test.ts` asserting each non-empty pin list in `pins.ts` matches signatures observed in ≥1 corpus analysis.

- [ ] **Step 1: Write failing `tests/semantic/pins.test.ts`**
  - For each corpus dir: `analyzeProject(parseReconConfig({ root, projectName: 'pins', timestamp: '2026-01-01T00:00:00Z' }))` (per-corpus test, 120s timeout, Phase 3 golden timeout precedent) ⇒ collect `state.functions[].signature` + interface/base signatures.
  - Assert `ERC20_PINS` ⊆ observed signatures across corpora.
  - Assert every entry of each pin list in `pins.ts` is observed in ≥1 corpus (pins can never exceed corpus evidence).
  - Assert analysis results are root-independent for `state_output_hash` **not** asserted here (covered by Task 11/13); this test only feeds pin evidence.
- [ ] **Step 2: FAIL** (missing corpora) [ ] **Step 3: Author the 8 corpus source sets** — minimal, compilable, each exercising its §16.1 row (lending: debt+collateral+fee surfaces with paired-access functions; staking: reward/stake/receipt; amm: LP + out-of-scope-named router call; oracle: oracle-typed in-scope interface + push hook; proxy: `DELEGATES_TO`-style + upgrader surface; roles: owner/admin/governance interfaces + `onlyOwner`-named modifier without backing + `setAdmin` setter; callback: ERC721Receiver-style hooks; ambiguous: `collateral`/`treasury` vars, `oracle`-named var, `Transfer` event w/o token surface, `mint` w/o supply). Vault reuses `fixtures/solidity/vault`.
- [ ] **Step 4: PASS + gate.** [ ] **Step 5: Commit** — `test(semantic): corpus Solidity sources + OD-8 pin evidence gate`.

**Ordering rule:** Task 15 completes before Tasks 5/7/8 Step 1 (OD-8 prerequisite); Tasks 5 and 7 may proceed in either order; Task 6 after 5; Task 9 after 4–8; 10/11 after 9; 12 after 10–11; 13 after 12; 14 last.

---

## Definition of Done (spec §18) — final gate after Task 14

- `npx vitest run` green (530 baseline unmodified + new semantic suites), `npx tsc --noEmit` clean.
- Import gate + docs phrase gate + diff gates (per-task `git diff --name-only` ⊆ allowed set) green.
- 9 goldens frozen with pre-freeze assertions, double-run byte-identity, leakage scan.
- Two-checkout determinism spot-check (pinned projectName/timestamp) — spec §18.7.
- Fresh-context review of the branch; OD table in spec updated; all rulings ledgered.
