# ESM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Execution Semantic Model as a separate, read-only, deterministic artifact (`esem-model/v1`) from Phase 1–3 evidence, without touching any frozen file, schema, rule, or behavior.

**Architecture:** New `src/semantic/esm/**` subtree (auto-covered by the existing import gate) with one focused module per primitive family; producers consume `EvidenceIndex` read-only and emit content-addressed records; composition is an explicit algebra with bound 8, visited-sets, and widening-to-UNKNOWN; envelope finalize mirrors the OD-3 hash idiom; no SSEM code is consumed as evidence and no SSEM code is modified.

**Tech Stack:** TypeScript strict + zod `strictObject` (colocated per-module schemas — `src/semantic/model.ts` is frozen and cannot host them), vitest TDD, `stableStringify`/`compareCodeUnits`, sha256 content ids.

**Spec:** `docs/esm-spec.md` (FROZEN at `3fb10c9` — the plan argues from it; executors read both; any conflict between plan and spec resolves in favor of the spec, and the worker must STOP and report instead of improvising).

## Global Constraints

Every task's requirements implicitly include this section. Exact values copied verbatim from the spec/repo.
- Frozen: zero edits outside `src/semantic/esm/**` and `tests/semantic/esm/**`. In particular NEVER touch: `src/semantic/model.ts`, `ids.ts`, `pins.ts`, `evidence.ts`, `transitions.ts`, `custody.ts`, `accounting.ts`, `authority.ts`, `trust.ts`, `ladder.ts`, `validate.ts`, `report.ts`, `analyze.ts`, `index.ts`, `src/errors/errors.ts`, `src/recon/**`, `src/recon-state/**`, `src/epistemic/**`, `src/domain/**`, `src/scope/**`, `src/traceability/**`, `src/relationships/**` (read-only consumption only), `src/util/**`, `fixtures/**`, `tests/semantic/*.test.ts` (existing), `tests/semantic/golden/**`, `docs/phase-4-ssem-spec.md`, `docs/plans/**`.
- Import gate (`tests/semantic/import-gate.test.ts`, auto-recurses into `esm/`): specifiers allowed are ONLY `'zod'`, `'node:crypto'`, and relative specifiers resolving inside `src/`; forbidden substrings: `http`, `fetch(`, `eval(`, `require(`, `Function(`, `child_process`, `node:net`, `writeFile`, `appendFile`, `import(`, `recon/ir`; no dynamic `import()`.
- All record schemas `z.strictObject`; all record arrays id-sorted via `compareCodeUnits`; duplicate ids rejected globally; `basis ≥1` real intake ids on every record; content ids `seme:`-prefixed over canonical payloads.
- No `Date.now`, `Math.random`, locale ordering, absolute paths, env values in `src/`; no severity/vulnerability/exploit/PoC/finding language in records, messages, or tests (outside explicitly-marked negative assertions).
- OD-1 state-only: no IR imports, no byte offsets, no source-text reading for any purpose (including builtin names and predicate text).
- TDD for every task (RED then GREEN, captured); commit style `feat(semantic): ...` / `test(semantic): ...`; full `npx vitest run` + `npx tsc --noEmit` green before every commit; working tree clean except intended files.
- Frozen numbers (do NOT re-decide): composition bound **8**, path cap **128** routes/query-anchor, `seme:` id family, §13.2 reason tokens as written, envelope §14 as written.
- Explicit STOPs (not tasks): new SINV family, ladder `based_on` integration, unknown roll-up finalization, temporal-scope expansion, source-reader exception, W6/IC-2/hygiene/mirror changes.

## Review Focus

Spec-implied failure modes most likely to bite; each names the input, the expected behavior, and the owning task+test that pins it.
1. Bare-signature matching sneaking into `call-supported` edges (e.g. IERC721 `transferFrom` satisfying an ERC20-shaped check) — expect: E1 target-identity only, decoy contract stays unlinked. Pinned by Task E5 test `call-supported requires E1 target identity (transferFrom-collision decoy)`.
2. Manufactured UNKNOWNs for unproven constructs (bare `if/require` with no evidencing record yielding an `unresolved-branch`) — expect: NO record at all. Pinned by Task E3 test `plain branch without evidencing record yields no record`.
3. Reentry union without both evidences (outward call but no exposed entry) — expect: UNKNOWN, no union. Pinned by Task E7 test `reentry without exposed entry yields UNKNOWN, no union`.
4. Caller/callee context collapse in `call-inline` (owner tags dropped, single merged context) — expect: separable A/B partitions + two linked contexts. Pinned by Task E7 test `call-inline preserves separable owner partitions`.
5. Class-label-as-kind in temporal records (e.g. kind `"block.*"` from the issue message) — expect: kind `UNKNOWN-kind`, label only in basis text. Pinned by Task E2b test `class-only occurrence yields UNKNOWN-kind, label in basis only`.

## File Structure

New subtree only; each file one responsibility; barrel does NOT touch frozen `src/semantic/index.ts` (a separate `esm/index.ts` keeps the freeze absolute).

- Create: `src/semantic/esm/ids.ts` — `EsmIdPrefix` (`'seme:'`), `esmContentId(prefix, payload)` (same sha256-hex16 algorithm as `semanticContentId`, ESM-local prefix type because the frozen prefix union cannot be extended), known-answer hash vectors in test.
- Create: `src/semantic/esm/unknown.ts` — frozen §13.2 reason-token constants, `UnknownScope` vocabulary, `makeEsmUnknown(scope, reason, basis, provenance?)` builder (basis≥1 enforced, sorted, content-id).
- Create: `src/semantic/esm/access.ts` — `deriveAccesses(index)` → variable-granularity accesses + sub-path-UNKNOWN.
- Create: `src/semantic/esm/external.ts` — `deriveBoundaries(index)` → boundary records (return/result always UNKNOWN).
- Create: `src/semantic/esm/temporal.ts` — `deriveTemporals(index)` → occurrence-only markers (kind UNKNOWN-kind unless a record names the builtin).
- Create: `src/semantic/esm/conditions.ts` — `deriveConditions(index)` → gate descriptors + gate-inventory per function + construct-UNKNOWNs only with existence evidence.
- Create: `src/semantic/esm/context.ts` — `deriveContexts(index)` → static frames with mandatory UNKNOWN runtime fields.
- Create: `src/semantic/esm/influence.ts` — `deriveInfluence(index, {accesses, conditions, boundaries})` → three-kind capability edges (gate endpoints from-only).
- Create: `src/semantic/esm/path.ts` — `derivePaths(index, {influence, conditions})` → ordered routes with per-step conditions + non-claim header (cap 128).
- Create: `src/semantic/esm/compose.ts` — five operators + `composeFunction` with ownership partitions, visited-sets, bound 8, widening, lineage.
- Create: `src/semantic/esm/envelope.ts` — `EsmDraft`/`EsmArtifact` types + `finalizeEsm` (sort all arrays, recompute counts, attach `esem_hash`) + `computeEsmHash` (strip `esem_hash` + host-coupled binding equivalents) + `serializeEsm` (`stableStringify`).
- Create: `src/semantic/esm/index.ts` — barrel re-exporting the above (only).
- Create: `tests/semantic/esm/*.test.ts` — one suite per module above (in-process mini-states following `tests/semantic/*` Cx-builder precedent; no new fixture files).
- Modify: NOTHING outside the two create-sets above (explicitly: no `src/semantic/index.ts` change).

## Evidence Mapping (from the architecture-validation audit; producers read left column only)

- StateAccess ← StorageAccess edges + StateVarIR (op/resolvedRef/type/span; slot when present). PROVABLE: exact variable access. MUST stay UNKNOWN: sub-paths, memory/calldata locations, aliasing across vars (never assume disjoint).
- ExternalResult ← CallSite kind/resolvedRef/span + unresolved markers + call issues. PROVABLE: crossing + kind + resolved target. MUST stay UNKNOWN: return linkage, result values.
- TemporalSource ← builtin-class issues WITH file+line + span-containment attribution (E2). PROVABLE: occurrence + consumers. MUST stay UNKNOWN: fine kind (names dropped at `build.ts:301`) → UNKNOWN-kind; value; ordering.
- Condition ← function modifiers/visibility/mutability (always present) + flagged-construct issues + custom-error USES facts. PROVABLE: gate descriptors + gate-inventory. Construct-UNKNOWN ONLY with existence evidence; plain branches → NO record.
- ExecutionContext ← CALLS graph + visibility + modifiers. PROVABLE: static frame. Runtime fields ALWAYS UNKNOWN.
- Influence ← above four + boundaries. PROVABLE: three edge kinds under strict thresholds. NEVER: transitivity-by-default, arg/return mapping, temporal/boundary-UNKNOWN sourcing, value content.
- Path ← graph + conditions. PROVABLE: ordered structural routes. NEVER: feasibility, ordering, intra-function detail.
- Composition ← all of the above + lineage. Produces partitioned summaries/paths with bound/cycle/widening markers.
- Unknown ← every failure above. First-class record (scope/reason/basis), counted + hashed.

## Composition Implementation (explicit per mandate)

- `call-inline`: ownership-partitioned union (owner tags `(function id, contract id)` on every entry; partitions separable; conditions conjoin owner-tagged; value triples as scaffolding only); caller + callee contexts recorded SEPARATELY linked by edge id — collapsing into one undifferentiated context is forbidden and fails validation.
- `inherit-merge`: along E1 bases; unknown base → marker, derived side preserved.
- `modifier-wrap`: prepends gate conditions for ALL modifiers (no first-only shortcut); never interprets.
- `delegate-shift`: context-shift marker + storage-subject UNKNOWN; no opcode semantics stated.
- `callback-reentry`: requires BOTH outward call AND exposed entry (else UNKNOWN, no union); output carries `reentry-capable` lineage status; order UNKNOWN; no promotion downstream; no synthesized second invocation.
- `visited-set` over `(function id, context-hash)` where context-hash is the context record's own content id; revisit → `cyclic` marker + branch termination.
- Bound **8** traversal depth; bound-hit → explicit UNKNOWN scoped to cut branch. Path cap **128**/anchor; overflow → explicit truncated-routes UNKNOWN.
- Deterministic ordering: canonical id-sorted traversal; lineage = ordered operator sequence + flags + markers + input ids.

## Testing Strategy Matrix

Every module suite covers: positive evidence (threshold met → record with exact basis/provenance); insufficient evidence (below threshold → NO record, asserted absent — not UNKNOWN); UNKNOWN paths (each reason with examined basis); determinism (double-run + reversed-insertion byte-identity + hash stability); provenance (byte-equal copies, mutated-copy refusal); hashing/ordering (sorted output, dup-id rejection, counts match); bound overflow (bound-hit UNKNOWN with lineage); cycles (cyclic marker, termination); inheritance (merge + unknown-base); modifiers (all recorded, multi-modifier); delegatecall (shift marker, subject UNKNOWN); callbacks (both-evidences rule, no-entry UNKNOWN); unresolved externals (UNKNOWN target + entry); temporal (occurrence + UNKNOWN-kind + no-source-reading); forbidden claims (each module asserts its §-list: no causation/taint/value/role/trust/ordering/feasibility language in outputs).

## Adversarial Coverage (architecture-review cases → owning task; unobservable ⇒ UNKNOWN/no-record per spec)

overload→E5 (id+selector keying, decoy test); inheritance/override→E7 (resolved-or-UNKNOWN, ambiguity UNKNOWN); multiple modifiers→E3 (all recorded); libraries→E7 (delegate-shift rule); mappings/nested-structs/dynamic-arrays→E1 (var-level + sub-path UNKNOWN); aliasing→E1 (never-disjoint rule test); return values→E5 (no-return-linkage, no edge); revert branches→E3 (USES-evidence only, else no record); loops/recursion→E7 (bound/cyclic markers); try/catch→E3 (flagged-issue existence only); assembly→E1/E3 (skipped-region UNKNOWN with span); delegatecall→E4+E7 (shift marker); proxy/upgrade→E6+E4 (impl UNKNOWN); callbacks/reentrancy→E7 (capability-or-UNKNOWN); dynamic dispatch→E6 (marker, UNKNOWN target); fallback/receive→E4 (entry, UNKNOWN calldata); constructor/init→E4+E3 (once-ness UNKNOWN); storage packing→E1 (slot opaque, no offsets); oracle→E6+E2b (marker + assumption stays assumption — ESM emits NO assumptions, records occurrence only); fee/derived-value→E5 (no computation semantics); timestamp/block→E2b (occurrence + UNKNOWN effect); unknown external return→E6 (permanent UNKNOWN).

## SSEM Integration (read-only contract; integration itself is deferred STOP)

- Consumed by SSEM (future, spec-approved code only): influence edges → transition basis; conditions → Layer E gate-evidence; accesses → Layer C basis; boundaries → Layer F dependency evidence; temporals → temporal-invariant basis; unknowns → SSEM unknown basis refs; paths → future impact attribution (no consumer today).
- Provenance/references: content ids (`seme:`) cited as basis strings; byte-equal provenance copies; lineage auditable.
- SSEM MAY consume: anything above, read-only. SSEM MUST NOT: re-derive influence, re-traverse composition, resolve ESM UNKNOWNs, admit ESM refs into frozen ladder `based_on` patterns, extend SINV, or cite ESM unknowns as resolvable.
- Deferred STOPs stay STOP: SINV family, `based_on` integration (frozen `model.ts`), roll-up finalization, temporal-scope expansion, source-reader exception.

---
### Task E0: Substrate — ids + unknown records

**Files:**
- Create: `src/semantic/esm/ids.ts`
- Create: `src/semantic/esm/unknown.ts`
- Test: `tests/semantic/esm/ids.test.ts`, `tests/semantic/esm/unknown.test.ts`

**Interfaces:**
- Consumes: `stableStringify`, `compareCodeUnits` (`src/util/canonical.js`); nothing else.
- Produces: `export type EsmIdPrefix = 'seme:'`; `export function esmContentId(prefix: EsmIdPrefix, payload: unknown): string` (sha256 hex, first 16, `` `${prefix}:${digest}` `` — same algorithm as `semanticContentId`, local prefix type because the frozen union cannot be extended); `export const ESM_UNKNOWN_REASONS` (exact §13.2 strings, frozen); `export function makeEsmUnknown(scope: string, reason: UnknownReason, basis: string[], provenance?: Provenance[]): UnknownRecord` (basis≥1 enforced, sorted code-unit, content id over `(scope, reason, sorted basis)`) where `UnknownRecord = { id: string; scope: string; reason: string /* closed §13.2 taxonomy only */; basis: string[]; provenance?: Provenance[] }` (+ exported schemas for both record shapes).

- [ ] **Step 1: Write failing tests** (`ids.test.ts`: known-answer vectors — `esmContentId('seme:', {})` equals independently computed `sha256(stableStringify({}))` first-16 hex with `seme:` prefix; distinct payloads differ; `unknown.test.ts`: empty basis throws; unsorted basis stored sorted; id stable across runs).
- [ ] **Step 2: Run to verify FAIL** (`npx vitest run tests/semantic/esm/ids.test.ts tests/semantic/esm/unknown.test.ts`, expect fail: module missing).
- [ ] **Step 3: Implement** `esmContentId` + `makeEsmUnknown` + reason constants (exact §13.2 strings) in the two files.
- [ ] **Step 4: Run to verify PASS** (same command; expect all green) + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(semantic): ESM substrate ids and unknown records`.

---
### Task E1: StateAccess derivation

**Files:**
- Create: `src/semantic/esm/access.ts`
- Test: `tests/semantic/esm/access.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex` (`../evidence.js`), `EsmIdPrefix`/`esmContentId` (Task E0), `UnknownRecord` builder (Task E0).
- Produces: `export function deriveAccesses(index: EvidenceIndex): { accesses: StateAccess[]; unknowns: UnknownRecord[] }` where `StateAccess = { id, location: string /* stateVar id or 'unknown' */, op: 'read'|'write'|'readwrite', span: {file, line_start, line_end}, slot?: string, subPath: 'unknown', scope: string /* contract id */, basis: string[] }` (zod `strictObject`, schema colocated and exported as `StateAccessSchema`).

- [ ] **Step 1: Write failing tests** (resolved READS ⇒ access with exact var id + edge basis; unresolved access ⇒ location `'unknown'` + unknown entry; mapping-typed var ⇒ `subPath 'unknown'` asserted; two different vars ⇒ NO disjointness claim — assert absence of any alias relation in output; `readwrite` ⇒ both read and write recorded).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveAccesses` (variable-granularity only; sub-path always `'unknown'`; alias rule: same var = same location, different vars = no claim either way).
- [ ] **Step 4: Run to verify PASS** + full `npx vitest run` + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(semantic): ESM state access derivation`.

---
### Task E2a: ExternalResult derivation

**Files:**
- Create: `src/semantic/esm/external.ts`
- Test: `tests/semantic/esm/external.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, Task E0 builders.
- Produces: `export function deriveBoundaries(index: EvidenceIndex): { boundaries: ExternalResult[]; unknowns: UnknownRecord[] }` where `ExternalResult = { id, site: string, kind: string /* CallKind + unresolved markers */, target: string /* fqn | marker-id | 'unknown' */, returnLink: 'unknown', result: 'unknown', basis: string[] }` (+ exported `ExternalResultSchema`).

- [ ] **Step 1: Write failing tests** (resolved external CALLS ⇒ target fqn + E1 basis; lowlevel marker ⇒ target marker-id + unknown entry; unknown target ⇒ `'unknown'` + entry; return/result fields asserted `'unknown'` in ALL cases; selector-only decoy ⇒ NOT resolved).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveBoundaries` (no signature matching — identity only via resolved edges; OD-6: selector-only stays E3/UNKNOWN).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM external boundary derivation`.

---
### Task E2b: TemporalSource derivation

**Files:**
- Create: `src/semantic/esm/temporal.ts`
- Test: `tests/semantic/esm/temporal.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex` (issues with file/line), Task E0 builders.
- Produces: `export function deriveTemporals(index: EvidenceIndex): { temporals: TemporalSource[]; unknowns: UnknownRecord[] }` where `TemporalSource = { id, kind: 'UNKNOWN-kind', consumers: string[], basis: string[] }` (+ exported `TemporalSourceSchema`; kind is ALWAYS `'UNKNOWN-kind'` — builtin names are dropped at `build.ts:301`, so no finer kind exists; class label lives in basis text only).

- [ ] **Step 1: Write failing tests** (builtin-class issue with file+line + attributable function ⇒ marker with consumers + kind `'UNKNOWN-kind'` + label in basis text only; ambiguous attribution ⇒ UNKNOWN-kind record; no occurrence record ⇒ NO record asserted absent; value/ordering fields asserted absent from the record shape).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveTemporals` (span-containment attribution as E2 derivation; NEVER read source text; NEVER set kind finer than UNKNOWN-kind).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM temporal occurrence derivation`.

---
### Task E3: Condition derivation

**Files:**
- Create: `src/semantic/esm/conditions.ts`
- Test: `tests/semantic/esm/conditions.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex` (`functionsById` fields + issues + USES facts), Task E0 builders.
- Produces: `export function deriveConditions(index: EvidenceIndex): { conditions: Condition[]; unknowns: UnknownRecord[] }` where `Condition = { id, kind: 'modifier-gate'|'visibility-gate'|'mutability-gate'|'unresolved-branch', function: string, descriptor: string, basis: string[] }` (+ exported `ConditionSchema`; `argsText` recorded verbatim opaque, never parsed).

- [ ] **Step 1: Write failing tests** (modifier list ⇒ one gate record per modifier with exact name; visibility/mutability ⇒ gate records; gate-inventory statement per function asserting examined fields; flagged assembly issue with file+line ⇒ scoped `unresolved-branch` with existence-evidence basis; custom-error USES ⇒ scoped `unresolved-branch`; `onlyOwner`-without-backing ⇒ gate recorded AND no classification fields present anywhere; PLAIN bare `if` with no evidencing record ⇒ NO `unresolved-branch` asserted absent — Review Focus #2).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveConditions` (gate-inventory always; construct-UNKNOWN only with existence evidence from the closed list; argsText opaque).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM condition derivation`.

---
### Task E4: ExecutionContext derivation

**Files:**
- Create: `src/semantic/esm/context.ts`
- Test: `tests/semantic/esm/context.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex` (CALLS graph + visibility + modifiers), Task E0 builders.
- Produces: `export function deriveContexts(index: EvidenceIndex): { contexts: ExecutionContext[]; unknowns: UnknownRecord[] }` where `ExecutionContext = { id, entry: string, chain: string[], callKinds: string[], gates: string[], unknown: { actor: 'unknown', origin: 'unknown', value: 'unknown', block: 'unknown', order: 'unknown' } }` (+ exported schema; runtime fields MANDATORY-present and MANDATORY-UNKNOWN).

- [ ] **Step 1: Write failing tests** (public entry ⇒ context with chain `[entry]`; resolved A→B ⇒ B context chains `[A,B]` with kinds; delegatecall hop ⇒ shift marker + storage-subject UNKNOWN; runtime fields asserted `'unknown'` in ALL records; NO role/owner/admin strings anywhere in output).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveContexts` (BFS from public/external entries; chains truncated at identity loss with UNKNOWN-hop; functions unreached by any entry get trivial self-chain contexts).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM execution context derivation`.

---
### Task E5: Influence derivation

**Files:**
- Create: `src/semantic/esm/influence.ts`
- Test: `tests/semantic/esm/influence.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, `{ accesses }` (Task E1), `{ conditions }` (Task E3), `{ boundaries }` (Task E2a).
- Produces: `export function deriveInfluence(index: EvidenceIndex, parts: { accesses: StateAccess[]; conditions: Condition[]; boundaries: ExternalResult[] }): { influence: InfluenceEdge[]; unknowns: UnknownRecord[] }` where `InfluenceEdge = { id, kind: 'data-supported'|'control-supported'|'call-supported', from: string, to: string, evidence: string[], eclass: 'E1'|'E2'|'E3', basis: string[] }` (+ exported schema; every edge carries the over-approximation declaration string verbatim: `'capable under stated evidence; materialization UNKNOWN'`).

- [ ] **Step 1: Write failing tests** (write→read same location via call chain ⇒ `data-supported` with exact evidence; gate on effect-owning function ⇒ `control-supported` gate→effect with shared function id; resolved CALLS ⇒ `call-supported`; gate as `to` endpoint REJECTED by schema/builder test; gate→gate REJECTED; `transferFrom`-collision decoy (same signature, different interface) ⇒ NO edge across identities — Review Focus #1; arg→param request ⇒ NO edge + unknown entry; temporal/boundary-UNKNOWN sourcing ⇒ NO edge).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveInfluence` (three strict rules only; endpoint shapes closed: state-version, call-site, external-boundary, ambient-source, gate-from-only; NO transitive closure).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM influence derivation (capability-level)`.

---
### Task E6: Path derivation

**Files:**
- Create: `src/semantic/esm/path.ts`
- Test: `tests/semantic/esm/path.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, `{ influence }` (Task E5), `{ conditions }` (Task E3).
- Produces: `export function derivePaths(index: EvidenceIndex, parts: { influence: InfluenceEdge[]; conditions: Condition[] }): { paths: SemPath[]; unknowns: UnknownRecord[] }` where `SemPath = { id, steps: { node: string; via: string; condition: string }[], basis: string[] }` (+ exported schema; every route carries the non-claim header string verbatim: `'structural route only; not executable, feasible, minimal, or complete'`, enforced by test).

- [ ] **Step 1: Write failing tests** (resolved A→B→C ⇒ route with per-step conditions; unresolved hop ⇒ terminated route + marker + entry; intra-function detail asserted absent (single node per function); diamond with UNKNOWN step ⇒ both routes recorded, no ranking; route count exceeding 128 ⇒ explicit truncated-routes UNKNOWN, never silent).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `derivePaths` (call/inheritance/delegate routes; cap 128/query-anchor AFTER canonical sort; intra-function collapse).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM path derivation (structural routes)`.

---
### Task E7: Composition algebra

**Files:**
- Create: `src/semantic/esm/compose.ts`
- Test: `tests/semantic/esm/compose.test.ts`

**Interfaces:**
- Consumes: `EvidenceIndex`, all Task E1–E6 outputs (typed inputs).
- Produces: `export function composeFunction(index: EvidenceIndex, functionId: string, parts: { accesses: StateAccess[]; conditions: Condition[]; boundaries: ExternalResult[]; temporals: TemporalSource[]; contexts: ExecutionContext[]; influence: InfluenceEdge[]; paths: SemPath[] }): { summary: ComposedSummary; unknowns: UnknownRecord[] }` where `ComposedSummary = { owner: { function: string; contract: string }; entries: { kind: string; ref: string }[]; contexts: ExecutionContext[] /* caller + callee kept SEPARATE, linked by edge id */; lineage: { operator: string; edge?: string; status: 'direct'|'reentry-capable'; flags: string[] }[] }` (+ exported schemas); operators: `callInline | inheritMerge | modifierWrap | delegateShift | callbackReentry` as pure functions with `(operator, edge id, ...)` lineage; bound **8**; visited-set over `(function id, context content-id)`; widening → scoped UNKNOWN; `reentry-capable` vs `direct` lineage status.

- [ ] **Step 1: Write failing tests** (A→B composes with separable A/B partitions + two linked contexts — Review Focus #4; all modifiers prepend (multi-modifier, no first-only); unknown base ⇒ marker, derived preserved; delegatecall ⇒ shift marker + subject UNKNOWN; callback WITH outward call + exposed entry ⇒ `reentry-capable` union + UNKNOWN order; callback WITHOUT exposed entry ⇒ UNKNOWN, no union — Review Focus #3; recursion ⇒ `cyclic` marker + termination; depth beyond 8 ⇒ bound-hit UNKNOWN with lineage; reentry-capable output asserted NOT promotable — no downstream concrete claim).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** the five operators + bound/visited/widening (no fixpoint-to-concrete, no unrolling, no order inference, no cross-branch value merging).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM composition algebra with ownership preservation`.

---
### Task E8: Envelope — finalize, hash, serialize

**Files:**
- Create: `src/semantic/esm/envelope.ts`
- Test: `tests/semantic/esm/envelope.test.ts`

**Interfaces:**
- Consumes: all Task E0–E7 outputs, `stableStringify`/`compareCodeUnits`.
- Produces: `export function finalizeEsm(draft: EsmDraft): EsmArtifact` (sort all id-bearing arrays, recompute `counts` from lengths, attach `esem_hash`); `export function computeEsmHash(model: EsmArtifact): string` (strip `esem_hash` + host-coupled binding equivalents ONLY — mirror OD-3); `export function serializeEsm(model: EsmArtifact): string` (`stableStringify`); `EsmDraft` = envelope shape minus `esem_hash` and `counts` (export the type, mirroring the `SemanticDraft` pattern); envelope `esem-model/v1` with EXACT §14 fields `{schema_version, inputs:{state_output_hash, fidelity, scope_hash?, file_count}, influences[], conditions[], paths[], contexts[], accesses[], boundaries[], temporals[], unknowns[], counts{}, esem_hash}` and NO status field.

- [ ] **Step 1: Write failing tests** (reversed-insertion input ⇒ code-unit sorted output + counts match; binding-only difference ⇒ EQUAL hash; `state_output_hash` difference ⇒ different hash; `computeEsmHash(finalize(draft)) === esem_hash`; double-run byte-identity incl. strip-and-refinalize; leakage regexes (timestamp, absolute path, backslash); tampered model detected on recompute; draft input byte-identical before/after; invalid input rejected, never filled).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** finalize/hash/serialize (nested ref-lists preserve authored order per nested-order ruling; NO status field; NO hash-formula duplication with `report.ts` — independent function, same idiom, covered by OD-3-style tests).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM envelope finalize, hash, serialize`.

---
### Task E9: Pipeline assembly, barrel, end-to-end

**Files:**
- Create: `src/semantic/esm/pipeline.ts`, `src/semantic/esm/index.ts`
- Test: `tests/semantic/esm/pipeline.test.ts`

**Interfaces:**
- Consumes: `buildEvidenceIndex` + Tasks E0–E8 (exact signatures above).
- Produces: `export function deriveEsm(index: EvidenceIndex): EsmArtifact` (fixed internal order: accesses → boundaries → temporals → conditions → contexts → influence → paths → compose → finalize; NO validation call — validator is deferred STOP, conformance is structural); `esm/index.ts` barrel re-exporting `esm/**` ONLY (frozen `src/semantic/index.ts` untouched).

- [ ] **Step 1: Write failing tests** (vault-fixture-shaped mini-state end-to-end: artifact schema-valid, all arrays sorted, counts match, hash stable across double-run; UNKNOWN-heavy input ⇒ UNKNOWN-rich artifact, never forced concrete; every emitted record basis-resolves to intake ids; forbidden-vocab scan over serialized bytes; import-gate still green).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `deriveEsm` + barrel (no SSEM imports as evidence; no SSEM calls at all).
- [ ] **Step 4: Run to verify PASS** + full suite + tsc.
- [ ] **Step 5: Commit** — `feat(semantic): ESM pipeline assembly and barrel`.

---

## Review Gates (after the listed tasks; each gate runs full `npx vitest run` + `npx tsc --noEmit` + focused spec-conformance re-read + fresh subagent review before continuing)

- **G1** after E0: substrate + id/unknown discipline.
- **G2** after E2b: evidence primitives (access/boundary/temporal) + UNKNOWN-first discipline.
- **G3** after E4: gates + context + gate-inventory vs construct rule.
- **G4** after E6: influence + paths + anti-taint/non-claim headers.
- **G5** after E7: composition (ownership, bound, cycles, reentry) — the highest-risk gate.
- **G6** after E9: envelope + pipeline + whole-ESM scoped review (freeze/drift/leakage/fabrication/provenance/nondeterminism/scope) + STOP, report, no SSEM integration.

## Self-Review (run against `docs/esm-spec.md` before handing this plan over)

1. **Spec coverage:** §§5–13 each map to exactly one task (P1→E5, P2→E3, P3→E6, P4→E4, P5→E1, P6→E2a, P7→E2b, P8→E7, P9→E0+E7-widening); §§4/15–17 map to E0+E8; §19 STOPs appear as prohibitions, never tasks; §20 R-rows map to the testing matrix rows. No spec section lacks an owner.
2. **Step scan:** each test step names assertions with spec-exact values; each implement step gives exact signature + file; no step decides nothing; no bodies transcribed (only the lineage/operator semantics the signatures don't determine are described, not coded).
3. **Type consistency:** names `deriveAccesses/deriveBoundaries/deriveTemporals/deriveConditions/deriveContexts/deriveInfluence/derivePaths/composeFunction/finalizeEsm/computeEsmHash/serializeEsm/deriveEsm`, types `StateAccess/ExternalResult/TemporalSource/Condition/ExecutionContext/InfluenceEdge/SemPath/ComposedSummary/EsmDraft/EsmArtifact/UnknownRecord`, and `seme:`/`bound 8`/`cap 128` are used identically everywhere in this plan.
4. **Review Focus:** five lines above, each with its owning task+test. No empty section.
5. **Proportion:** this plan states interfaces, thresholds, and tests — not implementations. Bodies live with the implementer.

## SPEC DECISION REQUIRED

NONE. All plan concretizations (TypeScript signatures, file layout, test names, internal derivation order) are plan-level choices faithful to frozen spec semantics, subject to YOUR approval of this plan. Frozen values (bound 8, cap 128, `seme:`, tokens, envelope, thresholds, STOPs) are copied, never re-decided. If execution exposes a genuine spec gap, the implementer must STOP and report rather than improvise.

## Amendment E10 (owner-approved 2026-10-09; waives the STOP rule for this item only)

- **E10 — transient composition projection:** `deriveCompositions(index): { summaries, unknowns }` as a thin projection of the single shared derivation pass with `deriveEsm` (no second traversal, §§14/15/16/18 UNCHANGED, envelope/counts/hash/id rules untouched, no cache/memoization/shared mutable state). Spec §12.8 (`docs/esm-spec.md`, commit `7b0c8d1`) is accepted under this waiver; without it the frozen-spec rule above would have required STOP. Exact function name confirmed by owner (resolves the deferred name item in spec §12.8).
- **Hygiene (no spec change):** shared `createUnknownCollector` in `src/semantic/esm/unknown.ts` replaces the six local `seenUnknowns`/`pushUnknown` duplicates; the `Function(` lookbehind fix in `tests/semantic/import-gate.test.ts` is kept (no `composeFunction` rename — renaming 30+ sites buys zero safety).
- **Out of scope, moved to `feat/issue-intake-identity`:** stable issue intake identity (`src/ids/ids.ts`, `src/semantic/evidence.ts`, traceability docs + tests). Revert of `a84e15e` on `esm-implementation` pending owner confirmation.
