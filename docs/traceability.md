# Traceability (Phase 2.5-A)

Implementation of `docs/TRACEABILITY_SPEC.md` (Status: Proposed, 28 sections).
This document is the system of record for what the code actually does: the
six layers mapped to real modules, the identity formulas verbatim, trace-status
semantics, the Q1–Q10 query catalog, the T1–T10 invariants with their
documented resolutions, the error-class mapping, security boundaries, and the
known limitations. Read it next to the spec — the spec is the intent, this
file is the contract of the code.

## Scope

In scope: `ReconRun` and identity records, per-extractor `Derivation` lineage,
run output lineage, `TraceStatus`, structural validation, persistence
(migration `003`), and the bounded read-only query service.

Out of scope (spec §27): vulnerability detection, exploit/PoC generation,
severity scoring, LLM reasoning, agents, RAG, vector stores, learning,
investigation execution, attack simulation, evaluation datasets.
Traceability is deterministic infrastructure — no LLM is required to create
or read it (spec §23).

## Architecture: six layers → modules (spec §3)

| Layer | Question it answers | Where it lives |
|---|---|---|
| 1 — Source Identity | Which sources, at which content hash? | `src/recon/source-hash.ts` (`computeSourceHash`), `src/traceability/identities.ts` (`computeSourceIdentity`, `computeManifestHash`), git context from `resolveGitContext` (`src/recon/build.ts`) |
| 2 — Run Identity | Under which execution context? | `src/traceability/identities.ts` (`computeConfigHash`, `computeCompilerIdentity`, `computeInputManifestHash`, `createRunId`, `computeOutputIdentity`), `src/version.ts` (`ANALYZER_VERSION`), populated by `src/traceability/build.ts` |
| 3 — Evidence / Provenance | Where did the evidence come from? | `src/epistemic/provenance.ts` (unchanged, authoritative), derivation `provenance` spans assembled in `src/traceability/build.ts` (`patchLineage`) |
| 4 — Derivation | Which deterministic operation derived it? | `src/recon/extract/index.ts` (`EXTRACTORS`, `runExtractorsWithLineage`), `src/traceability/build.ts` (`buildTraceability`) |
| 5 — Output Lineage | Which run produced this object, with what content? | `RunOutputRecord` (`src/traceability/types.ts`), `run_outputs` table (`migrations/003_traceability.sql`), `src/repository/{mappers,sqlite}.ts` |
| 6 — Trace Completeness | Is the lineage complete? | `assertTraceability` (`src/recon-state/validate.ts`), `getTraceStatus`/`findIncompleteTraces` (`src/traceability/service.ts`) |

```
src/traceability/
  types.ts       zod schemas + TS types (TraceabilityState, ReconRun, Derivation, …)
  identities.ts  pure identity builders (hashes, run/derivation ids)
  build.ts       pipeline artifacts → TraceabilityState (run + derivations + outputs)
  service.ts     createTraceabilityService(state) — Q1–Q10, status, traversals
  index.ts       barrel re-export (public surface)
migrations/003_traceability.sql   runs, derivations, run_outputs (+ indexes)
```

Pipeline wiring: `analyzeProject` (`src/recon/index.ts`) →
`runExtractorsWithLineage` (per-extractor patches) → `buildState`
(`src/recon/build.ts`) computes the identities, `input_manifest_hash`,
`run_id` and `output_identity` over the state **before** traceability is
attached, then `buildTraceability` emits `{ runs: [run], derivations, outputs }`
and `createReconState` validates the result. The `traceability` key on
`ReconState` is optional; `schema_version` stays `recon-state/v1`.

Material outputs (the only entity types `run_outputs` may cover, and the only
entity types current-run derivations may cover via rule (a)): `contract`,
`function`, `state_variable`, `relationship`, `fact`
(`MATERIAL_ENTITY_TYPES`). Type membership is enforced structurally for
`outputs[].entity_type` on every run and for current-run derivation output
refs; historical derivation refs are not type-checked (see Documented
resolution 2 below). Observation / Assumption / Hypothesis / Evidence /
assets / roles / dependencies are never given fabricated lineage (spec §12).

## Identity formulas

All digests are `sha256` hex over UTF-8 bytes; canonical JSON is
`stableStringify` (`src/util/canonical.ts` — `JSON.stringify` with object keys
sorted and `undefined` values dropped). No identity contains a timestamp,
random value, PID, or machine-specific path (spec §2.3, §20).

**Source hash** (`computeSourceHash`, `src/recon/source-hash.ts`) — the
Phase-2 formula, unchanged and authoritative:

```
sha256( [files sorted by path].map(f => `${f.path}:${f.sha256}`).join('\n') )
```

**Manifest hash** (`computeManifestHash`) — order-independent over the
discovered-file manifest:

```
sha256( stableStringify( files.sort(byPath) ) )     // payload: {path, sha256, bytes}
```

**Config hash** (`computeConfigHash`) — ruling R5: canonicalization lives
*inside* the builder, so every caller gets it:

```
stableStringify({ ...configWithoutRootOrTimestamp,
                  includes: [...includes].sort(),
                  excludes: [...excludes].sort() })
```

- `root` is stripped (machine path) and `timestamp` is stripped (execution
  metadata, spec §4.1) — `config_hash` is therefore equal for two configs that
  differ only in `root` or `timestamp`.
- `input_manifest_hash` and `run_id` hash that `config_hash` inside a payload
  that also carries `sourceIdentity`, which includes
  `source_root = basename(config.root)` (`src/recon/build.ts:94`,
  `identities.ts:60-72`, `lineage.test.ts:95` pins `source_root === 'vault'`).
  They are therefore unaffected by the **directory** portion of `root` and by
  `timestamp`, but they **do** change when the basename does: `/tmp/vault` vs
  `/tmp/vault-copy` yield equal `config_hash` and different
  `input_manifest_hash`/`run_id`.
- The value is canonical JSON, not a hex digest. `remappings` and other
  fields are hashed as configured (array order is part of their meaning).

**Input manifest hash** (`computeInputManifestHash`) — payload, no timestamps:

```
sha256( stableStringify({ sourceIdentity, configHash, compilerIdentity,
                          analyzerVersion, schemaVersion }) )
```

**Run id** (`createRunId`, same payload as the input manifest hash) via
`contentId('run', payload)` (`src/ids/ids.ts`):

```
run:<first 16 hex of sha256(stableStringify(payload))>
```

**Derivation id** (`derivationId`) — spec §18 recommended scheme, implemented
verbatim:

```
derivation:<run-id>:<operation>:<first 16 hex of
  sha256(stableStringify({ inputs: [...inputs].sort(canonical),
                           provenance: [...provenance].sort() }))>
```

The digest deliberately **omits `operation_version`** (spec §18's recommended
formula does too). T6 distinguishability is therefore carried by two other
channels, both exercised in tests: the analyzer version is embedded in the run
id (so a version change yields a new run id and hence a new derivation id), and
`operation_version` is a queryable field via
`findByDerivation(operation, operationVersion)`. A same-run
`operation_version` change alone would not change the id — unreachable through
`buildTraceability`, which always sets `operation_version = ANALYZER_VERSION`
and derives `run_id` from the same analyzer version.

**Output identity** (`computeOutputIdentity`) — the current-run hash (ruling
R2), identical wherever it is computed (validation, builder, service):

```
output_hash   = sha256( serializeReconState(state, { omitTraceability: true }) )
serialization = 'recon-state-json/v1'
```

The hash is taken over the UTF-8 bytes of that exact JSON string, with the
`traceability` key omitted, so attaching lineage never changes the output
identity (no circularity). `serializeReconState` (`src/recon-state/state.ts`)
canonicalizes: collections sorted by id, `traceability.outputs` sorted by
`(run_id, entity_type, entity_id)`. A run whose `output_identity.output_hash`
equals this value is the **current run**; runs that do not match are
historical. A state with no matching run (legacy state) skips the strict
traceability checks.

**Entity content hash** (`entityContentHash`) — per-output content, stored in
`run_outputs.content_hash` and used by `compareRuns`:

```
sha256( stableStringify(entity) )
```

**Compiler identity** (`computeCompilerIdentity`) — `{compiler:'solc', version:
longVersion, backend:'solc-js'}` plus `binary_hash: 'sha256:<hex>'` only when a
binary digest is supplied; the pipeline passes none, so **`binary_hash` is
absent for the bundled solc-js backend**.

## TraceStatus semantics (spec §11)

`getTraceStatus(objectId)` (throws `EntityNotFound` for unknown ids):

| Status | Meaning |
|---|---|
| `COMPLETE` | ≥1 derivation lists the entity in `outputs` (any run) **and** the entity has ≥1 provenance span (`source` span or `file:start-end` from its provenance records) |
| `PARTIAL` | exactly one of the two signals exists |
| `MISSING` | neither exists — required lineage is absent |
| `NOT_APPLICABLE` | the entity type is not a material type (project, assets, roles, dependencies, observations, assumptions, hypotheses, evidence) — lineage genuinely does not apply and must not be fabricated |

- A lineage-free material entity is `MISSING`, never an error and never
  silently `COMPLETE` (T8, T7). `traceBackward` on it returns
  `{status:'MISSING', nodes:[root], truncated:false}`.
- `MISSING` beside `COMPLETE` siblings is only reachable with no current run:
  rule (c) rejects any material entity uncovered by the current run's
  derivations, so producing that state requires demoting the run to historical
  (dropping/mutating `output_identity`) — see Invariants T2. E2e-proven both
  ways (`tests/traceability/e2e.test.ts:426`, `integrity.test.ts:498`).
- `findIncompleteTraces()` (Q7) returns `PARTIAL` and `MISSING` entries only —
  `NOT_APPLICABLE` and `COMPLETE` objects are never listed.
- `NOT_APPLICABLE` must not be used to hide missing data (spec §11). One
  documented exception is a forward-status quirk: `traceForward` on a ref that
  is known to derivations but absent from every state collection reports
  `NOT_APPLICABLE` (see Query catalog watch items).

## Validation: structural guarantee of lineage

`assertTraceability` (`src/recon-state/validate.ts`, called from
`validateReconState`, no-op when `traceability` is undefined):

- **Structural, always:** unique `runs[].id`, unique `derivations[].id`, every
  `derivation.run_id` exists in `runs` (T3); `outputs` unique on
  `(run_id, entity_type, entity_id)`; every `outputs[].run_id` exists in
  `runs` and `outputs[].entity_type` ∈ `MATERIAL_ENTITY_TYPES` (T4).
- **Current run only** (run whose `output_identity.output_hash` matches the
  recomputed hash): every derivation output ref resolves to a material entity
  present in the state **(rule a, T1)**; every `source_file` input ref resolves
  in the universe `collectProvenance(state) ∪ collectSpanSourceFiles(state)`
  **(rule b)**; every material entity is covered by ≥1 current-run derivation
  output **(rule c, T2)**.
- Failures throw `ReconError('InvalidReconState', …, { issues })` with
  `issues[].check === 'traceability'`.

Rule (b) resolution universe (rulings R4 + R6b):

- `collectProvenance(state)` = provenance records embedded across **all**
  collections (project, contracts … evidence). `validateReconState` derives
  the top-level `provenance[]` registry from exactly that set and normalizes
  the state to it, so the registry and `collectProvenance` are the same
  universe — a derivation input must resolve to a real provenance record
  wherever it lives, which is what spec T1 means by "a valid object".
- `collectSpanSourceFiles(state)` adds the file part of `source` spans on the
  material five collections (contracts, functions, state variables,
  relationships, facts). This half is load-bearing: on the vault fixture the
  provenance records cover only 2 of the 5 derivation input files —
  `IStrategy.sol`, `IVault.sol`, `MathLib.sol` are reachable only through
  entity `source` spans (R6 added span-derived inputs, R6b added the matching
  resolution universe). Without it, every pipeline state would be rejected.

The orphan report uses a **conservative superset**: `refResolves` in the
service unions provenance files from all 13 collections with `source` span
files from all 13 collections (validation covers spans on the material five
only). Orphan universe ⊇ validation universe — false negatives only, never a
state that validates but reports orphans.

Historical-run refs are validated structurally only; at query time they
resolve through `run_outputs` (see Persistence).

**Lineage is structurally guaranteed by rules (a)/(b)/(c)**: under a current
run it is impossible to store a material entity without a derivation output
(c), an impossible derivation output ref (a), or an input file that does not
exist (b). This is the T1/T2 enforcement point and the structural test anchor.

## Query catalog (spec §16)

`createTraceabilityService(state)` (`src/traceability/service.ts`) is
read-only over the in-memory state, with indexes built once at construction.

| # | Spec query | Method | Notes |
|---|---|---|---|
| Q1 | Why does this output exist? | `traceBackward(objectId, {depth?})` | throws `EntityNotFound` for unknown ids |
| Q2 | Where did this fact originate? | `getProvenance(objectId)` | entity's spans, sorted unique; unknown id throws |
| Q3 | Which run produced this object? | `getRun(objectId)` | tie-break below |
| Q4 | Which outputs depend on this source location? | `traceForward(ref, {depth?})` | takes a `TraceReference` |
| Q5 | Which outputs were generated by an extractor version? | `findByDerivation(operation, operationVersion)` | any-run, sorted by derivation id |
| Q6 | Which outputs differ between two runs? | `compareRuns(runIdA, runIdB)` | see below |
| Q7 | Which outputs have incomplete lineage? | `findIncompleteTraces()` | `PARTIAL`/`MISSING` only |
| Q8 | Which objects are orphaned? | `findOrphanedTraceReferences()` | `{run_id, derivation_id, ref}` |
| Q9 | Which runs analyzed the same source? | `findRunsBySourceIdentity(sourceHash)` | any-run, sorted by run id |
| Q10 | Show complete lineage | `trace(entityId, {direction, depth})` | `direction: 'backward' \| 'forward' \| 'both'` |

Additional service methods: `getRunById(runId)` (exact lookup, `undefined` if
absent), `getDerivations(objectId)` (matches inputs **or** outputs, sorted by
id), `getTraceStatus(objectId)`, `getOutputs(runId)` (run → output traversal).

**Q3 tie-break (`getRun`)**: candidates = runs of derivations whose `outputs`
contain the object (no candidate → `undefined`). Among them prefer a run whose
`output_identity.output_hash` equals the current state hash (the current run;
if several match, the greatest run id among them); otherwise fall back to the
**lexicographically greatest `run_id`** (code-unit comparison). Deterministic,
documented, and pinned at `service.test.ts:215`.

**Q6 (`compareRuns`)**: canonical comparison over `run_outputs.content_hash`
(`added`/`removed`/`changed`/`unchanged`, each sorted by
`(entity_type, entity_id)`). Classification: `diff_source` when
`source_identity.source_hash` differs, else `same_source_diff_analyzer` when
`analyzer_version` differs, else `same_source_same_analyzer`. Unknown run id →
`EntityNotFound`.

**Watch-item behaviors (current, intentional, asserted):**

- `traceForward` accepts a ref that appears in any derivation's inputs or
  outputs even when the target is absent from the state collections, while
  `traceBackward`/`getTraceStatus`/`getProvenance` throw `EntityNotFound` on
  unknown ids (`integrity.test.ts:394`). Spec T10 governs run attribution, not
  ref-existence checks; NOT_FOUND distinctness holds for entity-rooted queries.
- `forwardStatus` returns `NOT_APPLICABLE` for a ref whose type is known but
  which is not registered in any state collection (same test, line 429).
- Lineage queries are **any-run**; attribution is per-derivation-own-run; see
  R7 below.

## Traversal (spec §14–§15)

- `DEFAULT_TRACE_DEPTH = 5`; `depth` is normalized (finite, ≥0, truncated) and
  any non-finite value falls back to 5.
- Iterative BFS with a `visited` set keyed on `kind|id` — cycle-safe, no
  recursion. A frontier discarded at the depth bound sets `truncated: true`
  only when it had unvisited children (a fully-visited boundary reports
  `truncated: false`).
- Backward chain: `entity → derivation → source_file + provenance_span →
  source_identity → run`. `source_identity` nodes are deduped by
  `source_hash` and fan out to every run sharing that source hash (any-run
  view, R7); `run` nodes return no children.
- Forward chain: `source_file/entity → derivation → material outputs`. It
  follows **only real derivation edges**.
- Node kinds: `entity | source_file | provenance_span | derivation |
  source_identity | run`.
- `trace(…, direction:'both')` merges backward and forward node lists with
  dedup.

**Flat extraction topology**: today's pipeline emits one derivation per
extractor whose inputs are source files and whose outputs are material
entities — there is no fact→relationship derivation chain. Consequently, for
pipeline states `trace(both)` equals `traceBackward` (the forward side adds
only the root), and forward traversal from a source file reaches the
extractor's material outputs directly. This is asserted explicitly
(`e2e.test.ts:257`) and is a documented limitation, not a shortcut: if
entity→entity derivations are ever introduced, the `both` assertion must widen
to a union.

**Synthetic probes**: the pipeline emits no chains and no cycles by
construction, so `tests/traceability/e2e.test.ts` appends explicitly-labelled
`e2e.chain_probe` / `e2e.cycle_probe` derivations (through
`createReconState`, no mocks) to exercise the depth bound and cycle safety
end-to-end.

## Invariants T1–T10 (spec §17)

| Invariant | Requirement | Enforcement |
|---|---|---|
| T1 Valid references | every trace reference resolves | rule (a) current-run outputs; rule (b) current-run source inputs; `findOrphanedTraceReferences()` for the rest |
| T2 No orphan material output | material output never stored without trace info | rule (c) coverage; fails `createReconState` with `InvalidReconState{check:'traceability'}` |
| T3 Run ownership | each derivation belongs to exactly one run | `derivation.run_id` must exist in `runs`; PK on `derivations.id` |
| T4 Output ownership | derived outputs attributable to their run | `derivations[].outputs → run_id` linkage + `run_outputs` rows per run; every `outputs[].run_id` must exist in `runs` |
| T5 Immutable historical provenance | historical provenance never overwritten | additive `run_outputs`/`derivations` rows; re-save asserts identical content; test `integrity.test.ts:542` |
| T6 Versioned derivation | logic changes distinguishable via `operation_version` and/or analyzer version | `operation_version = ANALYZER_VERSION`; analyzer version is part of the run id (hence of the derivation id); queryable via Q5 — see the derivation-id note above |
| T7 No false resolution | UNKNOWN never becomes RESOLVED without evidence | status is per-entity, never blanket; zero-lineage stays `MISSING` (`integrity.test.ts:498`) |
| T8 Explicit incomplete state | missing lineage → `PARTIAL`/`MISSING`, never silent pass | `statusOf` + Q7; validation rejects current-run gaps |
| T9 Deterministic serialization | same logical trace serializes identically | `serializeReconState` canonical sorting; byte-identical double analysis (`lineage.test.ts:182`) |
| T10 Cross-run isolation | Run A's trace must not resolve to Run B's derivation merely because ids match | see R7 |

**Ruling R7 (cross-run semantics, pinned before Task 8):** lineage queries
(`traceBackward`, `traceForward`, `getDerivations`, status) are **any-run** —
an honest multi-run graph. Attribution is per-derivation: each derivation's run
endpoint resolves only to its own run, and derivation ids embed their own run
id (`derivation:<run-id>:…`). `getRun` prefers the current run. T10 therefore
means *correct attribution, not hidden visibility*: historical derivations of
an identically-ids entity remain visible in the lineage view, but never claim
another run's identity (`integrity.test.ts:293`, `:320`).

**Documented resolution 1 — run attribution via linkage, not entity columns.**
Spec §12 asks for a Fact's "run identity"; adding columns to Fact /
Relationship / entity schemas was forbidden by the no-entity-schema-change
constraint. Resolution: run attribution lives in the traceability layer
(`derivations.outputs → run_id` plus `run_outputs` rows) and is answered by
`getRun(objectId)` / `getOutputs(runId)`. Entity schemas are untouched.

**Documented resolution 2 — historical vs current scope of T1.** T1 ("every
trace reference resolves") cannot be enforced against historical runs: an old
run legitimately references entities that no longer exist in the current
collections. Resolution: strict resolution (rules a/b/c) applies to the current
run only; historical derivation refs are structurally validated for run
membership and id uniqueness only — no type-membership or resolution check
(type membership is enforced solely for `run_outputs[].entity_type` on every
run and, through rule (a), for current-run derivation outputs) — and resolve at
query time through `run_outputs`. Historical output refs load clean and are
not flagged orphaned (`integrity.test.ts:366`); a dangling historical ref with
no `run_outputs` row *is* reported by Q8 (`integrity.test.ts:394`).

## Persistence (spec §19)

`migrations/003_traceability.sql` (additive only; `001`/`002` are immutable
under checksum enforcement — never edited):

- `runs(id PK, project_id, schema_version, analyzer_version, started_at,
  completed_at, status, source_identity, compiler_identity,
  configuration_identity, input_manifest_hash, output_identity)` — structured
  fields stored as JSON columns.
- `derivations(id PK, run_id → runs, operation, operation_version, inputs,
  outputs, provenance, status, metadata)` + indexes on `(run_id)` and
  `(operation, operation_version)` (the Q5 filter).
- `run_outputs(run_id → runs, entity_type, entity_id, content_hash,
  PRIMARY KEY(run_id, entity_type, entity_id))` + index on `entity_id`.

Save/load rules (ruling R1), inside the existing `saveState` transaction:

- `persistDerivation` / `persistRunOutput`: `findRow` → `assertSameContent` →
  skip. Divergent content under an existing key throws
  `DuplicateCanonicalEntity`.
- `persistRun`: same, but on an existing row only `started_at`,
  `completed_at`, `status` are `UPDATE`d — timestamps are mutable execution
  metadata under an immutable run id (spec §4.1); identity fields must match.
- Persist order runs → derivations → outputs (FK `REFERENCES runs(id)` with
  `PRAGMA foreign_keys = ON`, `src/repository/migrate.ts:27`). Re-saving an
  identical state is idempotent (one run row).
- `loadState` reads the three tables in canonical order (`runs`/`derivations`
  `ORDER BY id`, `run_outputs` by `(run_id, entity_type, entity_id)`), attaches
  `traceability` only when ≥1 run row exists, then runs the full
  `createReconState` validation — so corrupted lineage is rejected on load.
- A save/load round trip preserves run/source/compiler/configuration identity,
  derivations, provenance spans, statuses, and trace relationships (spec §19),
  proven end-to-end on real pipeline output (`e2e.test.ts:283`).

## Determinism guards (spec §20)

- `src/traceability/**` contains no `Math.random`, `Date.now`, `new Date`, or
  UUID usage (grep-verified as part of final verification); the module only
  hashes and sorts.
- Timestamps are excluded from `run_id`, `derivationId`, and
  `input_manifest_hash`; two analyses with different injected timestamps
  produce identical ids and different `started_at` only
  (`lineage.test.ts:203`).
- Two analyses with identical config produce byte-identical
  `serializeReconState` output, including traceability (`lineage.test.ts:182`).

## Error semantics mapping (spec §22)

The five classes stay distinct; none may be collapsed:

| §22 class | Meaning | Where it lives today |
|---|---|---|
| `UNKNOWN` | semantic target cannot be resolved | analyzer issue severity `UNKNOWN` in the issue taxonomy (`src/recon/issues.ts`, bucketed/flushed via `src/recon/issue-buckets.ts` — e.g. `call_target_unresolved`, `unresolved_*`). **Not** part of traceability's error surface |
| `UNSUPPORTED` | construct outside supported analyzer capability | issue severity `UNSUPPORTED` (`unsupported_*` codes from `src/recon/ir/build.ts`). **Not** part of traceability's error surface |
| `NOT_FOUND` | requested entity/reference does not exist | `ReconError('EntityNotFound')` thrown by the service (`requireEntity`, `requireKnownRef`, `requireRun`/`compareRuns`) |
| `INCOMPLETE_TRACE` | entity exists but required lineage is unavailable | explicit `TraceStatus` `PARTIAL`/`MISSING` + `findIncompleteTraces()` — reported, never thrown, never silently valid |
| `FAILED` | derivation operation failed | `DerivationStatus`/`ReconRunStatus` `'FAILED'` values are representable; the pipeline only ever emits `COMPLETED` today (a failed analysis aborts before a state exists) |

Issue identity note: `UNKNOWN`/`UNSUPPORTED` issues carry stable intake IDs (`IndexedIssue`, attached at the semantic intake boundary) for ESM evidence basis; they remain outside traceability's error surface and finding surface as stated above.

Two further traceability-specific failure modes, both
`ReconError('InvalidReconState')`:

- `assertTraceability` issues → `{ issues: [{ check: 'traceability', source,
  missing }] }`.
- Unknown keys inside the `traceability` object → zod `strictObject` →
  `SchemaValidationFailed`.

## Security boundaries (spec §21)

- The traceability module performs **no I/O**: no `node:fs`,
  `node:child_process`, `node:net`, or process execution anywhere under
  `src/traceability/` (grep-verified). It reads only the in-memory
  `ReconState`, at the same trust level as `GraphIndex`.
- Traversals are bounded (default depth 5, cycle-safe visited set); the
  service never recurses unboundedly over untrusted graph shapes.
- No repository-provided value is trusted as a canonical id: ids are content
  hashes computed by this codebase; source paths are handled by the existing
  Phase-2 discovery/normalization rules (root-escape is rejected there as
  `RootEscape`).
- Migrations are additive only; no existing schema is rewritten.
- Scope exclusions (spec §27) hold: no evaluation, no LLM, no network in the
  trace layer.

## Limitations and known gaps

- **No AST/IR node ids.** Provenance spans (`file:start-line-end`) are the
  only structural location references; the model never records AST node or IR
  identifiers (spec §10's illustrative "AST node 817" chain is out of scope).
  `getProvenance` and derivation `provenance` are span strings only.
- **Flat extraction topology.** Forward traversal does not chain
  fact→relationship; `trace(both) == traceBackward` for pipeline states (see
  Traversal).
- **Multi-run saves require span-stable source edits.** Canonical entity rows
  are immutable (`saveState` has no DELETE/UPDATE path for entities — the
  Phase-1/2 "never overwrite" rule), while stable ids (`sourceContractId` and
  peers) carry content-varying `source` spans. A second analysis whose edits
  shift existing entity spans (prepending or inserting lines above them)
  therefore throws `DuplicateCanonicalEntity` on save and rolls the whole
  transaction back atomically — loud rejection, no silent data loss. EOF /
  append-safe edits keep spans stable and co-persist across runs
  (`e2e.test.ts:477`); the rejection is pinned at `e2e.test.ts:557`. Until
  Phase-3 entity row versioning lands, multi-run history supports only edits
  that do not shift existing entity spans.
- **`getRun` tie-break.** Current-run match first, else lexicographically
  greatest `run_id`; `undefined` when no derivation lists the object. Two runs
  sharing an identical `output_hash` are reachable — an EOF-only source edit
  keeps the `omitTraceability` serialization byte-identical, hence equal
  `output_hash` across runs (`e2e.test.ts:493`) — and both qualify as current:
  validation applies the strict rules to the first such match in `runs` order
  (`validate.ts:393-395`), while `getRun` returns the greatest matching
  `run_id` among them (`service.ts:461-468`); only the single-current
  preference/fallback is pinned (`service.test.ts:215`).
- **`binary_hash` absent for bundled solc** (no binary digest is available for
  the solc-js backend).
- **Git fields quirk.** When git is unavailable (`recordGit: false`, the root
  is not a git toplevel, or `rev-parse HEAD` fails) `resolveGitContext`
  returns an empty context: `SourceIdentity.repository`/`commit` and
  `Project.commit` are simply **absent** and analysis continues without
  crashing (with `recordGit: true` the timestamp falls back to epoch with a
  RECOVERABLE `git_unavailable` issue; with `recordGit: false` it falls back
  to epoch silently, with no issue — `timestamp.ts:33-49`). The model records
  no git *branch* field at all.
  The quirk carried from the Task 3 review: `computeSourceIdentity` omits
  `repository`/`commit` only when the value is `undefined` — a caller-supplied
  empty string would persist unvalidated (only `source_root` filters empty
  strings). The pipeline never passes `''`.
- **`FAILED` statuses are representable but unused** (see error mapping).
- **Provenance records without line spans contribute no span**, so they
  understate status (in the T8-safe direction: `PARTIAL` rather than
  `COMPLETE`).
- **Coverage config gap.** `vitest.config.ts` coverage `include` is
  `['src/recon/**/*.ts']` only — `src/traceability/**` is **not measured** by
  `npx vitest run --coverage` (verified during final verification: zero
  traceability files in `coverage/coverage-summary.json`). The suite exercises
  it heavily, but the number is invisible to the coverage gate. Left as-is
  deliberately; widening `coverage.include` is a separate, controller-owned
  decision.

## Spec §26 DoD evidence

| DoD bullet | Evidence |
|---|---|
| **Model** | |
| ReconRun exists | `src/traceability/types.ts:36` (interface, zod schema at `:136`); `tests/traceability/schema.test.ts:232` |
| SourceIdentity exists | `types.ts:12`; `identities.test.ts:334` |
| CompilerIdentity exists | `types.ts:23`; `identities.test.ts:313` |
| ConfigurationIdentity exists | `types.ts:27`; `identities.test.ts:182` |
| OutputIdentity exists | `types.ts:31`; `identities.test.ts:127` |
| Derivation exists | `types.ts:51`; `schema.test.ts:263` |
| TraceStatus exists | `types.ts:3`; `service.test.ts:455` |
| **Integration** | |
| deterministic extraction produces traceable outputs | `lineage.test.ts:80`, `:133`, `:182` |
| existing provenance remains compatible | `src/epistemic/provenance.ts` untouched since Phase 1 (last change `4baa45d`), `schema.test.ts:281` (legacy state), `e2e.test.ts:312` (facts retain provenance) |
| run ownership is enforced | `schema.test.ts:263`, `integrity.test.ts:788`, `schema.test.ts:610` (output run ownership) |
| derivation ownership is enforced | `integrity.test.ts:788` (rule a), `persistence.test.ts:244` |
| **Traversal** | |
| backward traversal works | `service.test.ts:270`; `e2e.test.ts:159` |
| forward traversal works | `service.test.ts:303`; `e2e.test.ts:214` |
| source → output traversal works | `e2e.test.ts:214` |
| output → source traversal works | `e2e.test.ts:159` |
| output → run traversal works | `e2e.test.ts:243` (`getRun`), `:159` (run endpoint) |
| run → output traversal works | `e2e.test.ts:243` (`getOutputs`) |
| **Integrity** | |
| orphan detection works | `integrity.test.ts:394` (non-empty branch) |
| incomplete trace detection works | `integrity.test.ts:436`; `e2e.test.ts:329` |
| invalid references are rejected | `schema.test.ts:446`, `:473`; `persistence.test.ts:273` |
| cross-run contamination is rejected | `integrity.test.ts:293`, `:320` |
| historical provenance is preserved | `integrity.test.ts:542`; `e2e.test.ts:477` |
| **Determinism** | |
| canonical identities are deterministic | `identities.test.ts:122`, `:245` |
| derivation IDs are deterministic | `identities.test.ts:259`; `integrity.test.ts:652` |
| output identity is deterministic | `identities.test.ts:127`; `lineage.test.ts:193` |
| save/load is deterministic | `persistence.test.ts:244`; `schema.test.ts:324`; `e2e.test.ts:283` |
| **Testing** | |
| unit tests | `tests/traceability/{schema,identities,service,compare,lineage}.test.ts` |
| invariant tests | `tests/traceability/integrity.test.ts` (12 tests) |
| persistence round-trip tests | `tests/traceability/persistence.test.ts`; `e2e.test.ts:283` |
| deterministic serialization tests | `schema.test.ts:324`; `lineage.test.ts:182` |
| corrupted lineage tests | `persistence.test.ts:273`; `integrity.test.ts:394` |
| cross-run isolation tests | `integrity.test.ts:293`, `:320` |
| regression tests | `identities.test.ts:122` (source-hash pin vs `buildIr`); `e2e.test.ts:312` |
| **Documentation** | |
| architecture documented | this file, Architecture section (spec §3) |
| identity formulas documented | this file, Identity formulas section |
| trace status semantics documented | this file, TraceStatus semantics section |
| required queries documented | this file, Query catalog section (Q1–Q10) |
| security boundaries documented | this file, Security boundaries section |

## Tests

`tests/traceability/`: `schema.test.ts` (18), `persistence.test.ts` (5),
`identities.test.ts` (10), `lineage.test.ts` (7), `service.test.ts` (11),
`compare.test.ts` (8), `integrity.test.ts` (12), `e2e.test.ts` (13) — 84
traceability tests inside the full suite.
