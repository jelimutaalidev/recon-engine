# Security Semantic & Economic Model Specification (Phase 4)

**Status:** DRAFT for approval (2026-10-06). Not approved; no implementation may
begin until this document is approved and an implementation plan is written and
approved (OD table §21).

**Context:** Phase 4 "Security Semantic & Economic Model (SSEM)". Phase 3
(Scope Accounting) closed at commit `de91051`; GitHub issue to be filed on
approval.

**Related documents:** `RECON_STATE_SPEC.md` (Phase 1, incl. §16 Agent Write
Permissions); `docs/recon-layer-design.md` (Phase 2, §5 guardrails);
`docs/TRACEABILITY_SPEC.md` + `docs/traceability.md` (Phase 2.5-A);
`docs/scope-accounting-spec.md` + `docs/scope-accounting.md` (Phase 3);
`docs/recon-state.md`.

**Constraints (hard):**
- Phase 1–3 foundations are frozen. Any foundation touch must be explicitly
  justified and budgeted in §4.4; nothing else may change.
- No modification of `src/recon-state/**`, `src/traceability/**`, `src/scope/**`
  behavior, or their tests/goldens.
- Evidence-first philosophy preserved: no invented source locations,
  relationships, transitions, asset mappings, or trust relationships.
- No LLM, no network, no runtime message parsing, no severity scoring, no
  vulnerability confirmation, no exploit/PoC, no attack execution, no finding
  generation, no autonomous scanner.
- Determinism: same inputs ⇒ byte-identical artifact (§13).

---

## 1. Purpose and critical question

Answer, per run: **what does this codebase structurally say about contract
semantics, state transitions, assets and custody, accounting relations,
privilege, and external trust — and which security properties are worth stating
as candidates?** — as a deterministic, evidence-backed, provenance-preserving
semantic layer over the existing pipeline output.

Core architectural principle:

```
Source/IR → Semantic Model → Security Assumptions/Invariants → later Recon Intelligence Agents
```

Phase 4 builds only the middle stage: a **semantic model**. It produces
structure and candidate properties — never verdicts. The model is the substrate
for a future Recon Intelligence Agent phase; that phase is out of scope (§3).

## 2. Vocabulary alignment and evidence classes

### 2.1 Term alignment (no alias invention)

| Term (this spec) | Meaning | Never means |
|---|---|---|
| **Semantic model** | The Phase 4 derived artifact (`semantic-model/v1`) | ReconState, a scan result, a report of findings |
| **Semantic record** | One typed record inside the artifact | a fact proven by execution |
| **Extraction fact** | A `Fact` already in ReconState (Phase 1/2, `VERIFIED`) | a semantic conclusion |
| **Observation / Assumption / Hypothesis** | Artifact records **mirroring Phase 1 shapes** via artifact-local schemas (§5.3, §14) | confirmation; `CONFIRMED` does not exist; writes into ReconState |
| **Candidate invariant** | A security property statement with basis chain and lifecycle status | a verified invariant, a finding, a vulnerability |
| **UNKNOWN** | Issue severity and explicit unknown-field state (`src/recon/issues.ts:5`) | a scope status (scope uses `UNRESOLVED`, `docs/scope-accounting-spec.md:40,213`) |
| **Fidelity** | `semantic \| syntactic` compilation fidelity (Phase 2), propagated as model degradation flags | confidence in a semantic conclusion |

Forbidden vocabulary in semantic output records: `vulnerable`, `exploit`,
`severity`, `critical`, `finding`, `attack`, `PoC`, `confirmed` (as invariant
status). These words may appear only in this spec's non-goals (§19) and in
future agent-phase documents. Enforced by a docs-phrase gate (§16).

### 2.2 The four-way distinction (normative)

| Concept | Definition | Example | Host (§14) |
|---|---|---|---|
| **Asset** | The underlying economic object itself (token contract, native balance, position principal) | the vault's underlying ERC20 | artifact `AssetRecord` (projection-ready) |
| **Custody** | *Where* an asset balance is held — a location controlled by an address/contract | vault contract holds 1,234 USDC | artifact `CustodyRecord` |
| **Accounting representation** | An on-chain record whose value *denotes* a quantity derived from an asset (share, receipt, debt, LP token) | vault shares | artifact `AssetRecord` with `represents_asset_id` |
| **Claim** | A holder's entitlement to assets implied by holding a representation or satisfying conditions | shares ⇒ claim on underlying | artifact observation-level record (`ClaimRecord`, always epistemic) |

These four are never collapsed. A share token is an accounting representation
of a claim over an asset; it is not the asset; custody says where balances sit;
a claim is an entitlement, not a code entity.

### 2.3 Evidence classes (E-classes) — the honesty mechanism

Every semantic conclusion carries an evidence class. Classes never upgrade
silently (§11.2.1, SINV-6).

| Class | Definition | Sources |
|---|---|---|
| **E1 — compiler-verified** | Emitted directly by solc/IR/extractors | canonical signatures, selectors, types, storage slots, kinds, visibility, `resolvedRef`, inheritance bases, `READS`/`WRITES`/`CALLS` relationships, `EMITS`/`USES` facts, issue records, fidelity/`dropped[]` |
| **E2 — structural-code** | Deterministic derivation over **in-scope compiled** E1 evidence only | inheritance from in-scope bases; state-var types resolving to in-scope interfaces; canonical-signature sets of in-scope ABIs; resolved call targets; relationship metadata (`call_kind`); paired storage access patterns |
| **E3 — unresolved** | Everything else | explicit `UNKNOWN`; no record, or a record field typed `unknown` |

**Forbidden as evidence (E-x ⇒ never):** identifier names (`collateral`,
`treasury`), modifier invocation *names* (`onlyOwner`), string literals,
event-name lookalikes, cross-project selector heuristics against out-of-scope
targets. Phase 2 already holds this line: "onlyOwner is a structural fact, not
a trust conclusion" (`docs/recon-layer-design.md:202`), and Phase 2 guardrail
§5 forbids name-matching conclusions. Out-of-scope dependency recognition by
signature alone is E3 until OD-6 resolves otherwise.

## 3. Architectural principle and phase boundary (Layer M)

**In Phase 4 (this spec):**
- Deterministic derivation of semantic structure from frozen pipeline outputs.
- Evidence-classed records; epistemic ladder records; candidate invariants.
- Validation (SINV), serialization, hashing, golden corpus, docs records.

**In the future Recon Intelligence Agent phase (explicitly NOT designed here):**
- Selecting which candidate invariants/assumptions to investigate; prioritizing;
  autonomous scanning; report generation; any finding/severity language;
  any LLM or probabilistic component; consuming the artifact to produce
  agent-authored conclusions. Phase 4's artifact is that phase's input contract.

Boundary rule: **Phase 4 may state "the code structurally does X, and this
inductively suggests property P (candidate, status OPEN)". Phase 4 may never
state "P holds", "P is violated", or "X is dangerous".**

## 4. Architecture, data flow, and artifacts

### 4.1 Data-flow diagram

```
 Solidity sources
      │
      ▼
 [Phase 2 frozen: discover → compile → IR → extractors → buildState]
      │                                   │
      │                                   └── (IR internal; OD-1 governs exposure)
      ▼
 AnalysisResult { state: ReconState, issues, meta }      ← byte-frozen output
      │                    │                │
      │          provenance/relationships   │ fidelity, issues, dropped[]
      │          facts, entities (read-only)│
      ▼                    ▼                ▼
 [Phase 2.5 frozen: traceability attach → runs/derivations]   ← untouched
      │
      │  (optional composition with frozen Phase 3 wrapper: scope_report)
      ▼
 ┌────────────────────────────────────────────────────────────┐
 │ Phase 4 semantic pass — src/semantic/** (new, additive)    │
 │  intake: read-only indexes over ReconState + provenance    │
 │  derivation: B transitions · C custody · D accounting      │
 │              E authority · F trust · G epistemic ladder    │
 │  finalize: validate (SINV) → semantic_hash → serialize     │
 └────────────────────────────────────────────────────────────┘
      │  zero writes to ReconState; every record carries basis refs
      ▼
 SemanticModel artifact  schema_version 'semantic-model/v1'
      │
      ▼
 analyzeProjectSemantic(config) → { analysis, scopeReport?, semantic }
      │
      ▼
 (future) Recon Intelligence Agents — out of Phase 4
```

**Hard data-flow invariants:** the semantic pass reads `AnalysisResult.state`
and never returns a modified `state`; `computeOutputIdentity(state)`, scope
report bytes, and traceability records are therefore unchanged by Phase 4
(§17). Scope cross-check is read-only and mirrors Phase 3's
`validateScopeReportWithState` pattern (`src/scope/validate.ts:328`).

### 4.2 Proposed module/file layout (deliverable 4)

```
src/semantic/
  model.ts        zod schemas: envelope, binding, all record types, enums (§5)
  ids.ts          semanticContentId(prefix, payload) — local helper (§13)
  evidence.ts     read-only intake: indexed views over ReconState (facts,
                  relationships via GraphIndex, functions, state vars,
                  contracts, issues) + provenance resolution
  transitions.ts  Layer B
  custody.ts      Layers C (asset/custody/claim records)
  accounting.ts   Layer D
  authority.ts    Layer E
  trust.ts        Layer F
  ladder.ts       Layer G (observations, assumptions, hypotheses, invariants)
  derive.ts       pure orchestration: intake → B–G → artifact draft
  validate.ts     SINV checks (§15), throws InvalidSemanticModel
  report.ts       finalizeSemanticModel / computeSemanticHash / serialize
  analyze.ts      analyzeProjectSemantic wrapper (§4.3)
  index.ts        barrel

tests/semantic/
  model.test.ts ids.test.ts evidence.test.ts transitions.test.ts
  custody.test.ts accounting.test.ts authority.test.ts trust.test.ts
  ladder.test.ts validate.test.ts report.test.ts analyze.test.ts
  import-gate.test.ts docs-phrases.test.ts
  golden.test.ts golden/<9 corpus>.json          (§16)
fixtures/solidity/semantics/{lending,staking,amm,oracle,proxy,roles,
  callback,ambiguous}/…                          (vault reuses fixtures/solidity/vault)
docs/phase-4-ssem.md                             (user-facing record, post-approval)
```

Layout mirrors `src/scope/**` (Phase 3), including the static import gate over
`src/semantic/**` (same rules as `tests/scope/import-gate.test.ts`: allowlisted
specifiers only, no dynamic import, no I/O/network/eval, barrel required).

### 4.3 Entrypoint contract

```ts
analyzeProjectSemantic(config, opts?: { withScope?: boolean }): Promise<{
  analysis: AnalysisResult;      // unchanged object; state bytes identical
  scopeReport?: ScopeReport;     // present iff composed with frozen scoped wrapper
  semantic: SemanticModel;       // envelope, always present; status COMPLETE|PARTIAL|FAILED
}>
```

- Analysis failure: rethrow the original error unchanged (Phase 3's wrapper
  already attaches `scope_report` when composed); no semantic envelope exists
  without a state.
- Semantic-pass failure: **non-fatal** — envelope with `status: 'FAILED'`,
  `failure: { code, stage }` (error code only, no paths/messages ⇒ deterministic
  and leakage-free), all layer arrays empty. Consumers must check `status`
  (SINV-14).
- `PARTIAL` ⇔ input fidelity was `syntactic`, files were `dropped`, or
  assembly-bearing functions were skipped; degradation notes recorded (§6.B6).

### 4.4 Foundation touch budget (deliverable 3 — proposed schema changes)

**ReconState schema (`src/recon-state/schema.ts`): NO CHANGES.** No new
collections, no field edits, no version bump (`recon-state/v1` untouched).

**Frozen modules: NO CHANGES** to `src/traceability/**` (incl.
`MATERIAL_ENTITY_TYPES` at `src/traceability/types.ts:90-96`), `src/scope/**`,
`src/recon/**` extractors/IR/build, `src/epistemic/**`, `src/domain/**`,
`migrations/**`.

**Explicitly justified additive touches (budget, Phase 3 OD-6 pattern):**

| # | Touch | Justification | Gate |
|---|---|---|---|
| T-1 | `src/errors/errors.ts`: add `\| 'InvalidSemanticModel'` to `ReconErrorCode` | Validator needs a loud code; additive-only union extension, identical precedent to Phase 3's `InvalidScopeReport` | error-matrix test update |
| T-2 | (OD-1, only if approved) IR exposure to the wrapper | Layer B precision enrichment; fallback is state-only intake (v1 default) | separate approval |

Everything else is new code under `src/semantic/**` + tests + docs.

**New artifact schemas (all local to `src/semantic/model.ts`):** envelope,
`binding`, and record types `StateTransition`, `ContractSemantics`,
`AssetRecord`, `CustodyRecord`, `ClaimRecord`, `AccountingRelation`,
`AuthorityChain`, `ExternalDependency`, `TrustCapability`,
`SemanticObservation`, `SemanticAssumption`, `SemanticHypothesis`,
`CandidateInvariant`, `UnknownIndex` (§5). Epistemic records use
**artifact-local zod schemas mirroring Phase 1 shapes** (§5.3); no edits to
`src/epistemic/**`, and no Phase 1 schema is parsed with substituted
prefixes (its id/ref regexes would reject the `sem*` prefixes and its
required `created_at` would violate SINV-10).

## 5. Layer A — Canonical semantic entities (semantic IR)

### 5.1 Envelope

```ts
SemanticModel = {
  schema_version: 'semantic-model/v1',          // z.literal
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED',
  failure?: { code: string; stage: string },     // only when FAILED
  input: {
    fidelity: 'semantic' | 'syntactic',
    state_output_hash: string,                   // computeOutputIdentity(state).output_hash
    file_count: number,                          // AnalysisResult.meta.fileCount
    degradation?: string[],                      // sorted, deterministic notes
  },
  binding: {                                     // integrity fields (§13.3)
    run_id?: string,
    input_manifest_hash?: string,
    scope_hash?: string,                         // iff scopeReport composed
  },
  contracts:    ContractSemantics[],             // all arrays code-unit sorted by id
  transitions:  StateTransition[],
  assets:       AssetRecord[],                   // §5.3, §7
  custody:      CustodyRecord[],
  claims:       ClaimRecord[],
  accounting:   AccountingRelation[],
  authority:    AuthorityChain[],
  trust:        { dependencies: ExternalDependency[]; capabilities: TrustCapability[] },
  epistemic:    { observations: SemanticObservation[]; assumptions: SemanticAssumption[];
                  hypotheses: SemanticHypothesis[]; invariants: CandidateInvariant[] },
  unknowns:     UnknownIndexEntry[],             // §13.5
  counts:       { transitions: number; assets: number; custody: number; claims: number;
                  accounting: number; authority: number; trust: number;
                  observations: number; assumptions: number; hypotheses: number;
                  invariants: number; unknowns: number },
  semantic_hash: /^[0-9a-f]{64}$/                // stripped before hashing (§13.3)
}
```

(Exact zod syntax finalized in the implementation plan; field sets above are
normative.)

### 5.2 Record id families

Local `semanticContentId(prefix, payload)` = `sha256(stableStringify(payload))`
first 16 hex — algorithm byte-identical to `contentId` (`src/ids/ids.ts:60-63`)
but **prefixes are declared in `src/semantic/ids.ts`, not added to
`ContentIdPrefix`** (no `src/ids` edit):

| Prefix | Record |
|---|---|
| `semc:` | ContractSemantics |
| `semt:` | StateTransition |
| `sema:` | AssetRecord |
| `semk:` | CustodyRecord |
| `semcl:` | ClaimRecord |
| `semacc:` | AccountingRelation |
| `semau:` | AuthorityChain |
| `semdep:` | ExternalDependency |
| `semtc:` | TrustCapability |
| `semobs:` | SemanticObservation |
| `semasm:` | SemanticAssumption |
| `semhyp:` | SemanticHypothesis |
| `seminv:` | CandidateInvariant |

Payloads are canonical: fixed key sets, references by id (never embedded
copies of mutable structures), provenance ids sorted.

### 5.3 Record field sets (normative summaries)

**ContractSemantics** — `contract_id` (E1), `semantic_kind` evidence-classed
(`proxy` \| `implementation` \| `library` \| `token` \| `pool` \| `unknown`),
`bases_evidence[]`, `notes: UnknownIndexEntry[]`. `proxy` requires E2 (e.g.,
in-scope `DELEGATES_TO`-class evidence or in-scope interface inheritance);
absence ⇒ `unknown` (never inferred from naming).

**StateTransition** — §6.

**AssetRecord** — projection-ready mirror of `AssetSchema`
(`src/domain/asset.ts:12-20`): `name` (required — projection parity),
`address?`, `chain_id?`,
`asset_type ∈ ASSET_TYPES`, `decimals?`, `custody?`, `represents_asset_id?`
(accounting representation link; state field is `underlying_asset_id` — field
renamed here to make the representation direction explicit; projection maps it),
`evidence_class`, `basis[]`. Zero fields may be filled from names (§2.3).

**CustodyRecord** — `{ asset_id, holder_contract_id, location_kind:
'contract' | 'unknown', basis[] }`. EOA custody is unobservable ⇒ record
absent, not guessed.

**ClaimRecord** — `{ holder_ref, claim_on: asset_id, via: representation asset
id?, basis[], epistemic: 'observation' }` — claims are *always* observations,
never facts (code proves representations and transfers, not entitlements).

**AccountingRelation** — §8. **AuthorityChain** — §9.
**ExternalDependency / TrustCapability** — §10.

**Epistemic records** — `SemanticObservation` / `SemanticAssumption` /
`SemanticHypothesis` are **artifact-local zod schemas that mirror** the Phase 1
`Observation`/`Assumption`/`Hypothesis` shapes (`src/epistemic/*.ts`) with three
declared divergences: (a) `id` regexes accept the §5.2 `semobs:`/`semasm:`/
`semhyp:` prefixes (Phase 1 regexes are `^obs:`/`^asm:`/`^hyp:`); (b) `based_on`
ref patterns accept the corresponding semantic prefixes (state `fact:` refs
remain valid where cited); (c) **`created_at` is omitted** (determinism +
SINV-10 — Phase 1's field defaults to a wall-clock ISO string). The
forced-confidence map reuses `EXPECTED_CONFIDENCE` semantics
(`src/recon-state/validate.ts:31-36`):
`OBSERVATION→DERIVED`, `ASSUMPTION→INFERRED`, `HYPOTHESIS→SPECULATIVE`.

**CandidateInvariant** — `{ id, statement, invariant_class ∈ {auth, custody,
accounting, isolation, external_trust, temporal, other}, based_on: (semasm|semhyp|semobs)
refs ≥1, affected_entities: string[] (state ids), status ∈ {OPEN, SUPPORTED,
WEAKENED, REJECTED}, notes? }`. Statement phrasing rule: a *property to check*,
e.g. "totalShares never exceeds accounted underlying" — never "X is safe" and
never "X is broken".

**UnknownIndexEntry** — `{ record_ref, field, reason ∈ {unresolved_call,
unsupported_assembly, out_of_scope_target, no_evidence, syntactic_fidelity,
dropped_file}, basis[] }` — the machine-checkable ledger that unknowns stayed
unknown (§13.5).

## 6. Layer B — State transition model

**Honesty statement (normative, must appear in the user-facing doc):**
transition records are *structural function summaries over extraction output*.
They are not symbolic execution, not data-flow, not path-sensitive: reads/writes
are branch-insensitive sets, ordering is **source-line order of provenance
spans, not execution order**, values are unknown, and assembly-bearing
functions are excluded (flagged). Over-approximation is declared, never
resolved.

| Record | Fields | Evidence |
|---|---|---|
| StateTransition | `function_id`, `contract_id`, `pre_state_reads[]` (state-var ids), `writes[]` (`{state_var_id, kind: 'write'\|'readwrite'}`), `external_effects[]` (`{call_kind, target_ref?, target_evidence: E1\|E3, value_handling: 'payable'\|'nonpayable', basis}`), `asset_movements[]` (`{kind: 'transfer'\|'mint'\|'burn'\|'approve'\|'deposit'\|'withdraw', asset_ref?, direction, evidence_class, basis}`), `post_state_observations[]` (event fact ids — `EMITS` facts), `state_mutation: 'none'\|'storage'`, `fidelity_flags[]`, `unknowns[]`, `basis[]` | see rules |

**Extraction rules (deterministic):**

| Rule | Input (E-class) | Derivation | On failure |
|---|---|---|---|
| B1 reads/writes | `READS`/`WRITES` relationships of `function_id` (E1) | populate sets; sort by state-var id | absent set = empty (proved by extraction, not by absence-of-record) |
| B2 external effects | `CALLS` relationships + `metadata.call_kind` (E1/E2); unresolved-marker facts (E1) | effect with `target_ref` when resolved; else `target_evidence: E3`, `target_ref` absent | `UnknownIndexEntry(reason: unresolved_call \| out_of_scope_target)` |
| B3 value handling | `Function.mutability === 'payable'` (E1, `src/domain/function.ts:24`) | `value_handling` | n/a |
| B4 asset movements | Only from Layer C asset evidence + resolved in-scope call targets with E2 movement signature evidence (§7 rules) | movement records with `evidence_class` | no movement record (never guessed from verb-like names) |
| B5 post-state observations | `EMITS` facts of the function (E1) | event fact ids as observations | absent ⇒ empty |
| B6 fidelity | `meta.fidelity`, `dropped[]`, `unsupported_assembly` issues touching the function's file (E1) | `fidelity_flags ∈ {syntactic, assembly_skipped, file_dropped}` | function whose file was dropped ⇒ **no transition record** + `UnknownIndexEntry(reason: dropped_file)` |
| B7 no ordering claims | — | arrays sorted by (span.file, span.byteStart) — declared source order | n/a |

Every transition must satisfy target attribution (SINV-8): at minimum
`function_id` + `basis` referencing the function's state relationships/facts.

## 7. Layer C — Asset & custody model

**Rule of construction:** assets are recognized only from typed/in-scope
evidence; economic *roles* (share/debt/…) are classified only from pinned
signature/inheritance sets over in-scope ABIs. Anything weaker ⇒ `asset_type:
'unknown'` or no record (§2.3). The four-way distinction of §2.2 is structural:
`AssetRecord` (asset vs representation), `CustodyRecord` (location),
`ClaimRecord` (entitlement, observation-level).

| Rule | Input (E-class) | Derivation | On failure |
|---|---|---|---|
| C1 asset candidate | State variable whose declared type resolves to an in-scope contract/interface (E1/E2) | candidate `AssetRecord` with `asset_type: 'unknown'` | non-typed (`address`) or out-of-scope type ⇒ **no record** + `UnknownIndexEntry(no_evidence)` |
| C2 erc20 classification | In-scope interface/base ABI declares the pinned ERC20 signature subset (`transfer(address,uint256)`, `approve(address,uint256)`, `balanceOf(address)`, `transferFrom(address,address,uint256)`) (E2) | `asset_type: 'erc20'` | subset absent ⇒ remain `unknown` |
| C3 representation classes | In-scope ABI declares pinned subsets: share (`convertToShares(uint256)`-family + `asset()`), debt (`totalDebt()`-family), collateral (pinned subset — OD-8), reward (`earned(address)`-family), LP/receipt (`mint(uint256)`-family paired with C2 underlying) | `asset_type` + `represents_asset_id` when the underlying candidate co-occurs in the same contract's state (E2 pairing); exact signature lists pinned per OD-8 at plan time; extending recognition beyond in-scope compiled evidence requires OD-6 | unproven ⇒ `unknown` |
| C4 custody | Asset-typed state variable declared in contract X (E1) | `CustodyRecord{asset, X}` | no state-typed holder ⇒ absent (EOA custody unobservable) |
| C5 claim | Holder-side: in-scope function reads holder's representation balance AND underlying entitlement surface exists (E2 pairing) | `ClaimRecord` (observation-level) | absent |
| C6 native assets | Balance reads of `address(this).balance` are not modeled by IR | no native asset records in v1 | `UnknownIndexEntry(no_evidence)` at contract level when `payable` functions exist (hint only, no record) |
| C7 movement linking | Layer B4 movement requires resolved target + C-recognized asset | movement typed | unlinked ⇒ `asset_ref` absent + unknown entry |

Name-based traps (`uint256 public collateral;` declared as plain `uint256`
without typed evidence) must yield nothing — covered by the `ambiguous`
adversarial corpus (§16).

## 8. Layer D — Accounting model

Relations are represented **only when evidenced**; each is an
observation-epistemic record with `derivation` provenance:

| `relation_kind` | Positive evidence pattern (E2) | Derivation tag |
|---|---|---|
| `assets_shares` | same contract holds C-classified asset + share representation AND ≥1 function's READS/WRITE set intersects both, or in-scope interface declares the conversion surface | `paired-storage` / `interface-structural` |
| `debt_collateral` | C-classified debt + collateral candidates co-held with paired access | ditto |
| `reserves_liquidity` | C-classified asset (reserves proxy) + C-classified LP representation co-held with paired access; native balances are not modeled (C6) | ditto |
| `rewards_eligible_stake` | reward classification + stake/receipt representation with distribution function pairing | ditto |
| `fees_protocol_user` | pinned in-scope fee-interface evidence (OD-8) over C-classified assets with split destinations co-accessed; no name-based "fee" detection | ditto (typically partial) |

Fields: `{ id, relation_kind, endpoints[] (record ids), derivation, evidence_class:
'E2', basis[], epistemic: 'observation', unknowns[] }`. **No pairing ⇒ no
relation.** Never synthesize relations from co-occurrence alone (co-occurrence
without paired access is insufficient — the paired-access clause is mandatory).

## 9. Layer E — Privilege / authority model

Chain shape (normative):

```
Actor → Authority/Role → Function → State Transition → Economic/Security Impact
```

`AuthorityChain = { id, links: { actor, authority, function_id, transition_id?,
impact }, per_link: [{ link_kind, evidence_class, basis, unknown? }], status:
'complete' | 'partial' }`.

| Rule | Input (E-class) | Derivation | On failure |
|---|---|---|---|
| E1 actor | In-scope caller contract via resolved `CALLS` into the gated function (E2). A written address state variable is **not** actor identity: when its declared type resolves to an in-scope ownership interface (E2) it links as a *stored-authority-subject* observation; plain address writes yield no actor evidence (written values are unknown, §6) | actor link / stored-subject link | external/unknown caller ⇒ link `evidence: E3`, `status: partial` — chain **kept but marked partial**, never completed by guessing |
| E2 authority | (a) in-scope inherited role interface/base with role-typed storage (E2); (b) role/authority declarations with E2 backing | `authority_kind ∈ ROLE_TYPES` (`src/domain/enums.ts:53-67`) or `'unknown'` | modifier invocation text alone (E1 structural) ⇒ `authority_kind: 'unknown'` + observation "modifier M gates f" (structural) |
| E3 gate structure | `Function.modifiers[]`, visibility, `mutability` (E1, `src/domain/function.ts:24`) | gate descriptor record | — |
| E4 function & transition | `function_id`; transition from Layer B if present | link | dropped/absent transition ⇒ link to function only + unknown entry |
| E5 impact | transition `asset_movements` + `external_effects` (Layer B/C) | impact link typed by what the transition structurally does | no movements/effects ⇒ impact `unknown` |
| E6 role vocabulary sources | `owner`/`admin`/`default_admin`/`governance`/`multisig`/`timelock`/`upgrader`/`pauser`/`guardian`/`keeper`/`relayer` typed **only** via in-scope interface/inheritance evidence (E2); interface→kind pins are OD-8 (unpinned ⇒ `'unknown'`) | classification | any weaker signal ⇒ `'unknown'` — **`onlyOwner`-style names never classify authority** (§2.3; `docs/recon-layer-design.md:202`) |

An un-gated public function yields the observation "no gate observed on f"
(E1 basis: empty modifier list + public visibility) — phrased as absence of
observation; any downstream "callable by anyone" statement is an
**assumption with status OPEN** (§11), never a fact.

## 10. Layer F — External dependency / trust model

`ExternalDependency` (artifact-local mirror of `DependencySchema`
(`src/domain/dependency.ts:11-18`) — projection-ready) +
`TrustCapability` records. State's `dependencies` collection stays untouched
(§14).

| Rule | Input (E-class) | Derivation | On failure |
|---|---|---|---|
| F1 dependency candidate | Named call target / typed state var resolving to an out-of-scope or in-scope external contract (E1/E2) | `ExternalDependency` with `dependency_type` assigned **only** by a pinned in-scope interface/inheritance mapping (OD-8, extended to F1); everything else ⇒ `'unknown'` — no name-based type assignment (§2.3) | unresolved target, no named ref (E3) ⇒ no dependency record; `UnknownIndexEntry(out_of_scope_target)` |
| F2 observed capability | Outbound `CALLS`/low-level markers toward the dependency (E1/E2), with `call_kind` | `TrustCapability{ direction: 'observed', capabilities[] }` | — |
| F3 consumed capability | Inbound surface: `public`/`external` functions whose parameters accept addresses/calldata callbacks AND in-scope hook/callback interfaces (E2) | `direction: 'consumed'` capability | not provable ⇒ field `unknown` (record still emitted when F1 held, with `UnknownIndexEntry(no_evidence)`) |
| F4 trust assumption | Always a `SemanticAssumption` (`epistemic: INFERRED`, status `OPEN`) referencing the capability + relevant observations | assumption link on the capability (`trust_assumption_ref`) | capability without assumption ⇒ SINV failure (trust is never implicit) |
| F5 failure semantics | Observable only: low-level call result ignored vs checked is **not** provable without data-flow ⇒ v1 records `failure_semantics: 'unknown'` except when in-scope try/catch or require-on-result patterns surface as E1 facts (future enrichment) | honest unknown | `UnknownIndexEntry(no_evidence)` |

Normative prohibition: a dependency record with `trust_assumption_ref` is a
**trust posture**, never a vulnerability statement — no status, severity, or
"unsafe" language exists on these records (§2.1, §19).

## 11. Layer G — Candidate invariants / security assumptions (epistemic ladder)

### 11.1 The ladder (normative chain)

```
FACT ──► OBSERVATION ──► SECURITY ASSUMPTION ──► CANDIDATE INVARIANT ──► PRELIMINARY HYPOTHESIS
(ReconState,        (artifact,          (artifact,            (artifact,               (artifact
 read-only)          DERIVED)            INFERRED)            lifecycle)               SPECULATIVE)
```

- **FACT**s are existing ReconState facts (and E1 records referenced as fact
  basis); Phase 4 never mints extraction facts into state (§14).
- **OBSERVATION**: structural reading of facts + entities (e.g., "f writes
  owner slot and is modifier-gated", "contract holds asset A and representation
  S with paired access"). `based_on ≥1` state fact ids, else provenance records
  copied byte-identically from ReconState's provenance registry or embedded
  fact/relationship provenance (§12.3).
- **SECURITY ASSUMPTION**: an imported/posited security-relevant belief
  (e.g., "oracle O is assumed fresh", "entrypoint f is assumed permissionless").
  `based_on ≥1` observations. Status lifecycle `OPEN|SUPPORTED|WEAKENED|REJECTED`.
- **CANDIDATE INVARIANT**: a property worth checking
  (e.g., "accounted shares never exceed held underlying"), `based_on ≥1`
  assumptions/observations/hypotheses, own lifecycle (§5.3). *Candidate ≠
  finding; candidate ≠ verified.*
- **PRELIMINARY HYPOTHESIS**: an investigation lead built on an invariant
  candidate ("if the paired-access surface is reachable unguarded, the
  accounting relation is testable"), Phase 1 `Hypothesis` schema,
  `SPECULATIVE` forced.

### 11.2 Epistemic rules

1. Levels never upgrade silently (Phase 1 invariant,
   `RECON_STATE_SPEC.md:597-634`); the forced-confidence map applies.
2. A candidate invariant may not cite a hypothesis that does not already exist
   (acyclic `based_on` DAG; SINV-5).
3. No status `CONFIRMED` exists anywhere (§2.1).
4. Contradiction handling: later evidence weakening a candidate ⇒ downstream
   phase flips status to `WEAKENED` — Phase 4 only defines the lifecycle, it
   does not execute investigations.
5. Density is not quality: layers may emit zero invariants; an empty invariant
   array is a valid, honest output.

## 12. Layer H — Provenance and evidence rules

1. **Every** semantic record carries `basis ≥1` (SINV-3): references to state
   entities, relationships, facts, issues, provenance records (byte-copied,
   §12.3), or other artifact records with a resolvable chain to state-rooted
   evidence (SINV-4/SINV-5).
2. **Transitive provenance:** artifact epistemic records resolve provenance by
   walking `based_on` to roots that carry `provenance[] ≥1` (state facts,
   relationships, entity spans). Validator computes this closure.
3. **Copy-by-content rule:** when an artifact record embeds a provenance
   record (observation fallback path), it must byte-equal a provenance record
   already present in ReconState (registry or embedded in facts/relationships;
   content-addressed identity — identical content ⇒ identical `prov:` id).
   Source spans may only appear inside such copied records; inventing a record
   or span ⇒ SINV-4 failure.
4. No invented: source locations, relationships, transitions, asset mappings,
   trust relationships. If evidence is missing: no record, or record field
   typed `unknown` + `UnknownIndexEntry`.
5. Attribution: every record must trace to ≥1 target entity (function/
   contract/state var) — target attribution for machine checks (SINV-8).
6. State is read-only; provenance registry in state is not extended (§14).

## 13. Layer I — Determinism, identity, and versioning

### 13.1 Stable IDs and ordering
- Ids per §5.2 (content-addressed, 16-hex, canonical payload).
- Every array in the artifact is sorted with `compareCodeUnits`
  (`src/util/canonical.ts:27-29`) by id (records) or by declared tuple
  (basis id lists); no map-iteration order may reach output.
- Duplicate ids ⇒ SINV-2 failure (loud, like Phase 3 `duplicate_entry`).

### 13.2 Serialization and versioning
- `serializeSemanticModel` = `stableStringify` (`src/util/canonical.ts:1-3`).
- `schema_version: 'semantic-model/v1'` (z.literal, Phase 3 pattern
  `scope-report/v1`); version bumps are major-only and breaking.
- No `Date.now`, `Math.random`, absolute paths, ISO timestamps, backslashes,
  or `root` strings anywhere in artifact content (golden leakage scan, §16).

### 13.3 Semantic hash
```
semantic_hash = sha256(stableStringify(payload))
payload        = model with `semantic_hash` removed
                 and `binding.{run_id, input_manifest_hash, scope_hash}` removed
                 (i.e., hashed = schema/input/status/layers/epistemic/unknowns/counts
                  + input.state_output_hash)
```
Rationale (deviation from Phase 3's `scope_hash`, recorded as OD-3): run_id and
`input_manifest_hash` embed `sourceIdentity.manifest_hash`, which is coupled to
the analysis root directory (open foundation issue #4) — hashing them would
make the semantic artifact host-coupled and break byte-identical goldens on
other machines. Excluded binding fields are instead verified by
re-derivation at validation time (SINV-11: `input.state_output_hash` must equal
`computeOutputIdentity(state).output_hash`; `run_id`/`scope_hash` must match
the state's current run / composed report). Integrity is preserved without
root coupling.

### 13.4 Reproducibility
Double-run identity test (same inputs ⇒ `semantic_hash` equal and serialized
bytes equal), mirroring `tests/scope/golden.test.ts` double-run assertion.

### 13.5 Unknown index
`unknowns[]` is the explicit, sorted ledger of every unresolved field
(§5.3). Invariant: unknowns are additive output — a layer may not drop a
record's unknown marker when promoting a field to a known value (SINV-9).

## 14. Layer J — ReconState integration decision

### 14.1 Decision (recommended, awaiting approval)

**Phase 4 introduces a new derived semantic artifact (`semantic-model/v1`),
separate from ReconState. ReconState receives zero new content in Phase 4.**
Its ready-but-empty collections (`assets`, `roles`, `dependencies`,
`observations`, `assumptions`, `hypotheses`, `evidence` — populated by no
extractor today; `src/recon/build.ts:85-91` initializes them empty) remain
empty until a future, explicitly approved projection phase (OD-2).

### 14.2 Justification (why population now is not safely possible)

1. **Run-binding breakage (decisive).** Phase 3's
   `validateScopeReportWithState` looks up the current run by
   `computeOutputIdentity(current_state)` (`src/scope/validate.ts:360-371`), and
   traceability stores per-run `output_identity` immutably (T5,
   `docs/traceability.md:324-338`). Populating `assets/roles/dependencies/
   observations…` after run creation changes `serializeReconState` ⇒ changed
   `output_hash` ⇒ scope cross-check fails (`run_binding`) and stored run
   identities go stale. Pre-identity integration would require editing the
   frozen `src/recon/index.ts`/traceability pipeline **and** re-bless Phase 3
   scope goldens (they embed `run.output_hash`) — both forbidden by this
   phase's constraints.
2. **Precedent.** Phase 3 solved the same class of problem with a separate,
   versioned, hashed artifact bound read-only to run identity
   (`ScopeReport`). Phase 4 repeats the proven pattern.
3. **Additive-only mandate.** "Do not blindly expand ReconState" (phase brief)
   and Phase 1's own §16 Agent Write Permissions describe those collections as
   the home for *future agents* — that is a future-phase design, not a Phase 4
   implementation detail.
4. **Risk isolation.** Semantic overclaim, once introduced, can never corrupt
   canonical extraction output: `state` bytes, `output_hash`, scope report,
   and traceability records are provably unchanged (§4.1, §17).
5. **Projection-ready shapes.** Artifact records mirror the field sets of
   `AssetSchema`/`RoleSchema`/`DependencySchema` (§5.3), so a later approved
   projection is mechanical rather than a redesign.

### 14.3 What lives where (hosting matrix)

| Semantic object | Host | Why |
|---|---|---|
| Extraction facts, relationships, entities, provenance | ReconState (read-only) | Phase 1/2 owns them |
| Semantic structure (transitions, custody, accounting, authority, trust) | artifact | no matching collections; mutation forbidden (14.2) |
| Observations / assumptions / hypotheses | artifact (Phase 1 shapes mirrored) | writing state would change `output_hash` |
| Candidate invariants | artifact | no Phase 1 collection exists; creating one = schema expansion (OD-5) |
| ContractSemantics (layer A) | artifact | derived structure over state contracts; no state collection accepts it |
| UnknownIndexEntry ledger (§13.5) | artifact | unknowns are artifact-local; state issues untouched |
| Future projection of `assets/roles/dependencies/observations…` into state | deferred | OD-2 |

## 15. Layer K — Validation invariants (SINV)

`validateSemanticModel(model, ctx: { state, scopeReport? })` — throws
`ReconError('InvalidSemanticModel', …, { reason })` (T-1), fixed check order:

| # | Invariant | Failure `reason` |
|---|---|---|
| SINV-1 | strict zod schema; `schema_version === 'semantic-model/v1'`; status/failure exclusivity | `schema` |
| SINV-2 | id uniqueness; every collection code-unit sorted; counts match lengths | `ids_unsorted` |
| SINV-3 | every record has `basis ≥1`; basis target kinds allowed per layer (§12.1) | `basis_missing` |
| SINV-4 | every ref resolves (state ids exist; artifact ids exist; provenance copies byte-equal state content) | `basis_unresolvable` |
| SINV-5 | `based_on` DAG acyclic; roots carry provenance ≥1 (transitive closure) | `provenance_incomplete` |
| SINV-6 | no unsupported semantic upgrades: hosting matrix respected (§14.3); forced-confidence map exact; evidence classes never upgrade (checked by re-deriving each record's class from intake per the §6–§10 rule tables and comparing) | `epistemic_upgrade` |
| SINV-7 | epistemic separation: no forbidden vocabulary (§2.1); statuses ∈ allowed sets; candidate invariants not phrased as verdicts (banned-predicate scan) | `epistemic_leak` |
| SINV-8 | target attribution: every record traces to ≥1 state entity | `unattributed` |
| SINV-9 | UNKNOWN discipline: every `unknown` field has an `UnknownIndexEntry`; every no-record failure branch has an entry except explicitly proved-empty sets (B1/B5); no defaulting of unknown → concrete | `unknown_flattened` |
| SINV-10 | determinism: recomputed `semantic_hash` matches; no ISO-timestamp/absolute-path/backslash leakage in artifact | `hash_mismatch` / `leakage` |
| SINV-11 | binding: `input.state_output_hash === computeOutputIdentity(state).output_hash`; `binding.run_id`/`scope_hash` re-derive to current values when provided | `binding_mismatch` |
| SINV-12 | scope compatibility (only when `scopeReport` present): every state file referenced by semantic records resolves to an entry whose status ∉ {`EXCLUDED`, `NOT_FOUND`, `FAILED`}; no record references excluded paths; references to `UNRESOLVED`/`UNSUPPORTED` entries require a degradation note in `input.degradation` | `scope_conflict` |
| SINV-13 | fidelity honesty: `input.fidelity === 'syntactic'` ⇒ model status `PARTIAL` and degradation notes present; dropped-file/assembly unknowns present when issues exist | `fidelity_mismatch` |
| SINV-14 | failure envelope: `FAILED` ⇒ all layer arrays empty + failure present; `COMPLETE` ⇒ no degradation; `PARTIAL` ⇒ ≥1 degradation/unknown | `envelope_invalid` |

Compatibility with scope accounting: SINV-12 is read-only and never mutates or
re-derives the scope report; semantic derivation may run without a scope report
(check skipped, recorded as a `binding` note).

## 16. Test and evaluation strategy (golden / adversarial corpus)

### 16.1 Corpora (9, all semantic fidelity — no vulnerability detection)

| Corpus | Exercises | Key adversarial assertions |
|---|---|---|
| `vault` (reuse `fixtures/solidity/vault`) | assets↔shares, custody, ERC4626-like in-scope interfaces, authority of admin | in-scope interfaces classify; out-of-scope hints stay unknown |
| `lending` | debt↔collateral, fees split, pauser role | debt/collateral require paired access; naming traps fail closed |
| `staking` | rewards↔eligible stake, receipt representations, keeper/relayer | reward classification only via pinned signature sets |
| `amm` | reserves↔LP, router dependency (out-of-scope) | named out-of-scope router ⇒ dependency record with type `unknown` + unknown entries; unresolved target ⇒ no record + unknown entry |
| `oracle-dependent` | oracle capability (observed reads), freshness assumption (OPEN), push-style consumed capability | trust assumption always present (F4); failure semantics stay unknown |
| `upgradeable-proxy` | delegatecall effects, implementation/upgrader authority, INITIALIZES-class evidence | proxy kind requires E2; no proxy claim from naming |
| `role-based` | in-scope role interfaces, governance/multisig typing (E2 only), gated state writes | `onlyOwner`-named modifier without in-scope backing ⇒ `authority_kind: 'unknown'` |
| `callback-token` | consumed capabilities (hooks/receivers), token movements | no movement records without resolved + classified asset |
| `ambiguous` (adversarial) | vars named `collateral`/`treasury`, modifier `onlyOwner` w/o owner storage, `oracle`-named reads w/o in-scope oracle interface, admin-style setters (`setAdmin`) w/o in-scope role interface, event `Transfer` w/o token surface, function `mint` w/o supply effect | **zero** classified assets/authorities beyond E1/E2; unknown index populated; word count of non-unknown classifications asserted |

### 16.2 Test layers (gates)

1. **Unit suites** per module (§4.2) — rules B1–B7, C1–C7, D, E1–E6, F1–F5,
   ladder, each with isolated single-violation fixtures (Phase 3 fixture-
   isolation convention).
2. **Validator suites** — one test per SINV reason, accepted + rejected paths.
3. **Golden corpus** — pattern of `tests/scope/golden.test.ts`: explicit
   partition assertions written **before** freezing goldens; byte-compare with
   `UPDATE_GOLDEN=1` regen; double-run byte-identity; leakage scan (no ISO
   timestamp, no absolute path, no timestamp-shaped key, no backslash).
   Unlike Phase 3, fixtures are in-process built states (no filesystem walk);
   root independence of `semantic_hash` follows from §13.3 (OD-3).
   Isolated fidelity-degradation golden states (syntactic fallback, dropped
   file, assembly-bearing) cover B6/SINV-13 at golden level.
4. **Import gate** over `src/semantic/**` (Phase 3 pattern).
5. **Docs phrase gate** over `docs/phase-4-ssem.md`: required honesty sentence
   ("structural function summaries … not symbolic execution"), the four-way
   distinction terms, forbidden vocabulary absent (§2.1), candidate ≠ confirmed
   phrasing pinned.
6. **Foundation-untouched gate**: `git diff` per task restricted to the §4.4
   budget (Phase 3 regression-gate convention, `scope-accounting-spec.md:596-599`).

Evaluation is **fidelity-based only**: goldens measure whether the model
faithfully represents evidenced structure — never whether it "found issues".

## 17. Compatibility & impact analysis (deliverable 11)

| Phase | Guarantee | Phase 4 impact | Verification |
|---|---|---|---|
| Phase 1 | `recon-state/v1` schema, validators, epistemic rules, persistence | none — zero schema/validator/migration edits; epistemic schemas reused read-only | diff gate (§16.2.6); existing 172 Phase 1 tests unmodified |
| Phase 2 | extraction semantics, IR, guardrails, `AnalysisResult.state` bytes | none — read-only intake; no extractor/IR/build edits | `state` byte-identity test (wrapper returns identical `state`); existing Phase 2 tests untouched |
| Phase 2.5-A | traceability immutability, `MATERIAL_ENTITY_TYPES`, run identity | none — semantic artifact is not a state entity; lineage rides on referenced state entities; no derivation/`outputs` entries | existing traceability tests untouched; SINV-11 re-derivation only |
| Phase 3 | scope report bytes, INV-8/11 cross-check, goldens | none — state unchanged ⇒ `output_hash`/run lookup unchanged ⇒ goldens stable; cross-check composed read-only | existing 145 Phase 3 tests untouched; SINV-12 |
| Cross-cutting | `ANALYZER_VERSION` semantics | semantic artifact carries `schema_version` + `input.state_output_hash`; analyzer version bump lands in future implementation plan (mirrors T6 versioning) | identities tests untouched |

Known interlocks: foundation issue #4 (manifest root coupling) is *worked
around*, not fixed, by §13.3; `MATERIAL_ENTITY_TYPES` non-extension means
semantic records have `TraceStatus` `NOT_APPLICABLE` (correct: they are derived
artifact content, documented as such).

## 18. Definition of Done

1. All §4.2 modules implemented TDD; every extraction rule (B1–B7, C1–C7, D,
   E1–E6, F1–F5, ladder §11) has isolated unit coverage; every SINV has
   accepted + rejected tests.
2. All 9 corpora frozen with pre-freeze partition assertions; double-run
   byte-identity; leakage scan; adversarial no-fabrication assertions green.
3. `npx vitest run` fully green (existing 530 tests unmodified), `npx
   tsc --noEmit` clean, import gate + docs phrase gate green, diff gates
   enforce the §4.4 budget.
4. `docs/phase-4-ssem.md` (user-facing record) + this spec's OD table updated
   with final rulings; spec coverage map from plan tasks to spec sections.
5. Fresh-context review of the full branch with verdict "approved" (or fixes
   landed); all rulings ledgered before workspace cleanup.
6. Zero LLM/network/dynamic-import/eval references anywhere in `src/semantic/**`.
7. Re-run determinism: two full runs on two clean checkouts produce identical
   `semantic_hash` for all corpora (pinned `config.projectName`/`config.timestamp`,
   or identical checkout directory basename and commit — `output_hash` embeds
   `project.name` and the resolved timestamp).

## 19. Non-goals (explicit)

- No vulnerability confirmation, exploit/PoC, attack execution, severity
  scoring, finding generation, autonomous scanning.
- No LLM or probabilistic component of any kind.
- No symbolic execution, data-flow/taint analysis, alias analysis, value
  ranges, path sensitivity — declared over-approximation only (§6).
- No modification of Phase 1–3 foundations except the §4.4 budget.
- No ReconState schema expansion, no persistence of the artifact (OD-4),
  no Recon Intelligence Agent behaviors (§3).
- No deployment/on-chain/ABI fetching; no source outside the configured root.

## 20. Implementation waves (deliverable 12 — dependency order)

Spec-level breakdown; the implementation plan (post-approval, via
`writing-plans`) expands each task with tests and gates.

| Wave | Tasks | Depends on |
|---|---|---|
| W0 | Spec approval → Phase 4 tracking issue → implementation plan (separate skill) | user approval |
| W1 | T1 `errors.ts` `InvalidSemanticModel` + module skeleton + import gate + `ids.ts`/determinism helpers; T2 artifact zod `model.ts` + envelope/record schema tests | W0 |
| W2 | T3 read-only evidence intake (`evidence.ts`: GraphIndex views, fact/relationship/function indexes, provenance resolution) | T1, T2 |
| W3 (parallel) | T4 transitions (B) with B1–B7; T5 asset/custody (C) with C1–C7 | T3 |
| W4 | T6 accounting (D) | T5 |
| W5 (parallel) | T7 authority (E) with E1–E6; T8 trust (F) with F1–F5 | T3, T5 (impact links) |
| W6 | T9 epistemic ladder (G) over facts + B–F outputs | T4–T8 |
| W7 (parallel) | T10 validator (SINV-1…14); T11 finalize/hash/serialize (`report.ts`) | T9 |
| W8 | T12 wrapper (`analyzeProjectSemantic`) + scope composition + SINV-11/12 cross-checks | T10, T11 |
| W9 | T13 golden/adversarial corpus (9 fixtures, frozen goldens, all gates) | T12 |
| W10 | T14 user-facing record doc + phrase tests + spec OD rulings + final review | T13 |

Waves W3/W5/W7 exploit file-level parallelism (Phase 3 wave convention);
stop-on-spec-conflict remains in force for every task.

## 21. Open decisions (OD table)

| # | Decision | Recommendation | Rationale / alternative cost | Ref |
|---|---|---|---|---|
| OD-1 | IR access for the wrapper | **State-only intake for v1**; IR exposure (additive `AnalysisResult` field, T-2) deferred | ReconState already carries relationship metadata (`call_kind`), spans (provenance), modifiers, selectors, slots — enough for B–F; IR exposure is a foundation touch with serialization surface | §4.4, §6 |
| OD-2 | Projecting artifact records into ReconState collections (`assets/roles/dependencies/epistemic`) | **Defer to a future approved projection phase** | population post-run breaks `output_hash` run binding + frozen scope goldens (§14.2); revisit when pipeline/identity policy is deliberately reopened | §14 |
| OD-3 | `semantic_hash` binding fields (exclude `run_id`/`input_manifest_hash`/`scope_hash`) | **Exclude input-coupled fields; re-derive at validation (SINV-11)** | avoids host/root coupling (foundation issue #4); scope precedent hashes them but pays with host-coupled goldens | §13.3 |
| OD-4 | Artifact persistence | **In-process return only** (Phase 3 OD-5 precedent) | sqlite tables would touch migrations (frozen); consumers are in-process for now | §4.3 |
| OD-5 | Candidate-invariant home (artifact now vs future ReconState collection) | **Artifact; revisit with OD-2** | new ReconState collection = schema expansion + version questions | §5.3, §14.3 |
| OD-6 | Evidence threshold for E2 (pinned in-scope signature sets vs allowing out-of-scope selector recognition) | **In-scope compiled evidence only; out-of-scope selector recognition stays E3** | selector-only recognition of OZ-style external deps would reintroduce name/ABI heuristics at scale; cost: more `unknown`s, honestly | §2.3, §7 |
| OD-7 | `analyzeProjectSemantic` failure envelope (non-fatal FAILED vs throw) | **Non-fatal envelope** (deterministic `{code, stage}`, no messages) | analysis succeeded; killing the run would discard valid state; loudness preserved via mandatory status checks | §4.3, SINV-14 |
| OD-8 | Extended classification pin lists (exact signature subsets for §7 C3, §9 E6 role kinds incl. owner/admin, and §10 F1 dependency kinds beyond the frozen ERC20 set in C2; unpinned ⇒ `'unknown'`) | **Pin at plan time from corpus ABI evidence; spec freezes rule shape and the ERC20 set now** | exact 4-byte sets are implementation detail of E2 predicates; freezing wrong lists pre-corpus would force spec churn | §7, §9, §10 |
