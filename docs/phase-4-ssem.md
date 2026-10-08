# Phase 4 — Security Semantic & Economic Model (SSEM): user-facing record

**Status:** user-facing record for the Phase 4 semantic pass (post W12 goldens).
Normative detail lives in [`docs/phase-4-ssem-spec.md`](./phase-4-ssem-spec.md);
tracking issue: [recon-engine #5](https://github.com/jelimutaalidev/recon-engine/issues/5).

## What this is

Phase 4 derives a deterministic, evidence-backed **semantic model** over frozen
pipeline output (`AnalysisResult.state` plus provenance, fidelity, and issues).
It produces structure and candidate properties — never verdicts. The model is
the substrate for a future Recon Intelligence Agent phase; that phase is out of
scope (spec §3).

The model answers, per run: **what does this codebase structurally say about
contract semantics, state transitions, assets and custody, accounting relations,
privilege, and external trust — and which security properties are worth stating
as candidates?** (spec §1).

## Honesty statement (normative, from spec §6)

> transition records are *structural function summaries over extraction output*.
> They are not symbolic execution, not data-flow, not path-sensitive:
> reads/writes are branch-insensitive sets, ordering is **source-line order of
> provenance spans, not execution order**, values are unknown, and
> assembly-bearing functions are excluded (flagged). Over-approximation is
> declared, never resolved.

Consequences for readers: a transition record tells you which state a function
structurally touches and which external surfaces it structurally reaches. It
does not tell you values, branch behavior, or execution order. Anything the
evidence does not support is recorded as `unknown` with an `UnknownIndexEntry`
ledger entry, or no record is emitted at all.

## Architecture (from spec §4.1)

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

Hard data-flow facts: the semantic pass reads `AnalysisResult.state` and never
returns a modified `state`; `computeOutputIdentity(state)`, scope report bytes,
and traceability records are therefore unchanged by Phase 4. ReconState
receives zero new content in Phase 4 (spec §14; projection deferred under
OD-2).

## The four-way distinction (normative, spec §2.2)

These four are never collapsed:

| Concept | Definition | Example |
|---|---|---|
| **Asset** | The underlying economic object itself (token contract, native balance, position principal) | the vault's underlying ERC20 |
| **Custody** | *Where* an asset balance is held — a location controlled by an address/contract | vault contract holds 1,234 USDC |
| **accounting representation** | An on-chain record whose value *denotes* a quantity derived from an asset (share, receipt, debt, LP token) | vault shares |
| **Claim** | A holder's entitlement to assets implied by holding a representation or satisfying conditions | shares imply a claim on underlying |

A share token is an accounting representation of a Claim over an Asset; it is
not the Asset; Custody says where balances sit; a Claim is an entitlement, not
a code entity. Claims are always observation-level records, never facts: code
proves representations and transfers, not entitlements (spec §5.3, §7 C5).

## The epistemic ladder (spec §11.1)

```
FACT ──► OBSERVATION ──► SECURITY ASSUMPTION ──► CANDIDATE INVARIANT ──► PRELIMINARY HYPOTHESIS
(ReconState,        (artifact,          (artifact,            (artifact,               (artifact
 read-only)          DERIVED)            INFERRED)            lifecycle)               SPECULATIVE)
```

Forced confidences (spec §5.3; `src/recon-state/validate.ts:31-36`):
OBSERVATION is always `DERIVED`, SECURITY ASSUMPTION always `INFERRED`,
PRELIMINARY HYPOTHESIS always `SPECULATIVE`. Levels never upgrade silently. No
status `CONFIRMED` exists anywhere. Density is not quality: an empty invariant
array is a valid, honest output (spec §11.2.5).

## Candidate properties are not confirmed properties

Every candidate invariant carries a `based_on` chain to observations or
assumptions, an `invariant_class`, and a lifecycle status of `OPEN`,
`SUPPORTED`, `WEAKENED`, or `REJECTED`. The statement is phrased as a property
worth checking (for example, "totalShares never exceeds accounted underlying")
— never as a verdict that the property holds or is broken. Candidate ≠
confirmed: confirmation would require an investigation phase that does not
exist yet, so every candidate ships with its basis chain and its status, and
later evidence may flip that status to `WEAKENED` downstream.

## Determinism and binding

- Same inputs imply byte-identical artifact: content-addressed ids
  (`semanticContentId`, `src/semantic/ids.ts:22`), code-unit-sorted arrays
  (`compareCodeUnits`, `src/util/canonical.ts:27-29`), canonical serialization
  (`stableStringify`, `src/util/canonical.ts:1-3`), no timestamps, paths, or
  randomness in artifact content (spec §13; SINV-10).
- `semantic_hash` covers the model with `semantic_hash` itself and the
  host-coupled binding fields (`run_id`, `input_manifest_hash`, `scope_hash`)
  removed; those fields are instead re-derived at validation time (SINV-11:
  `input.state_output_hash` must equal `computeOutputIdentity(state).output_hash`).
  This keeps goldens byte-identical across machines (spec §13.3; OD-3).
- Entry point `analyzeProjectSemantic` (`src/semantic/analyze.ts:59`) returns
  the analysis object unchanged alongside the semantic envelope; every record
  carries `basis ≥1` tracing to state-rooted evidence (SINV-3/4/5/8).

## Evidence-poor real inputs fail closed (no behavior change)

Probing `analyzeProjectSemantic` on real extractor output — which is
evidence-poorer than the semantic fixtures — yields a `FAILED` envelope
rather than a populated model. That behavior is intentional and unchanged by
this documentation wave: nothing here alters any derivation to make real
inputs produce populated output. Read the outcome with this distinction:

- **Implementation defect**: code contradicts the spec (proven by execution,
  fixed with a regression test — for example the W12 dangling-observation
  wiring, Task 13 report §2 item 3).
- **Evidence limitation**: the spec's evidence rules honestly permit no record
  (for example unpinned signatures, unnamed out-of-scope targets). The output
  stays `unknown` or absent; the limitation is ledgered, not repaired by
  guessing.
- **Fail-closed**: the chosen behavior under limitation — a `FAILED` envelope
  with `{code, stage}` and empty layers (spec §4.3; `src/semantic/analyze.ts:190-213`),
  or `unknown` ledger entries. Consumers must check `status` (SINV-14). A
  closed failure is the correct answer when evidence is inadequate; a
  populated-but-unfounded model would be the defect.
- **Deferred producer**: a derivation the spec shapes but no plan task built
  (Layer-A `contracts: []`, movement wiring). Recorded as absent, never built
  ad hoc to turn a red input green.

The extraction-enrichment versus evidence-threshold decision for real inputs
belongs to a future task. This record states the FAILED-on-real-inputs
behavior plainly and changes no code to hide it.

## Vault corpus clarification (spec §16.1)

The vault row of the corpus table ("in-scope interfaces classify; out-of-scope
hints stay unknown") is clarified as follows, matching frozen golden behavior:

- The `CashToken`-typed state variable resolves to an in-scope interface whose
  ABI carries the full pinned ERC20 subset, so it classifies as `erc20` (E2)
  with a `CustodyRecord` at the holding contract (`src/semantic/pins.ts:20-25`;
  spec §7 C1–C2).
- The `ShareToken`-typed state variable has no pinned share/receipt family in
  `src/semantic/pins.ts` (the share family is intentionally omitted there for
  lack of unambiguous corpus evidence), so it stays `unknown` — classified
  only as far as the evidence reaches, never by name or by role intuition.
- Pin absence is not a nonexistence proof: it means "no unambiguous corpus
  evidence was available to pin this family," not "this family does not exist."
- The `treasury: address` hint, with no typed or in-scope evidence behind it,
  yields no record — only an `UnknownIndexEntry` with reason `no_evidence`
  (spec §7 C1 failure column). A hint without evidence never fabricates a
  record.

## Task 13 adjudication record (W12; recorded, not relitigated)

Golden adjudication froze derivation-under-adequate-evidence across 9 corpora
(commits `f2c10e2`, `39e351a`, `9487b1b`, fix round `ed87a5c`; full report in
`.superpowers/sdd/2026-10-07-recon-phase4-ssem/task-13-report.md`):

1. `contracts: []` in all goldens — **DEFERRED GAP** (no fix). No Layer-A
   producer exists in the plan's task set; building one for goldens would be a
   new feature. Pinned as absent.
2. Vault under-claim (asset present, shares relation absent) — **EVIDENCE
   LIMITATION**. The `erc20` classification is provable from the pin closure;
   the `assets_shares` relation is unprovable without share pins, so the
   golden asserts its absence rather than a fabricated relation.
3. Layer-F dangling trust observations — **IMPLEMENTATION DEFECT** (fixed in
   `f2c10e2`, completed in `ed87a5c`). Assumptions cited observation ids the
   pipeline dropped; every trust-bearing model failed validation until the
   observations were threaded end to end. Same release fixed the
   validator-side ledger-key mismatch (SINV-9 accepting layer keys) and the
   callback dependency id collision (`39e351a`) — both proven by execution
   with regression tests, zero frozen-test churn.
4. Zero `asset_movements` everywhere — **DEFERRED GAP** (no fix). Movement
   linking was never wired; the honest output is the failure branch (no
   movement record), with one genuine C7 `asset_ref`/`no_evidence` entry in
   the callback-token corpus. Goldens assert `[]` universally.
5. ABI-closure shortfall — **unresolved EVIDENCE LIMITATION**. Oracle typing
   rests on in-scope call signatures and consumed direction on foreign
   interface edges, documented per corpus; nothing is upgraded beyond what
   the evidence supports.
6. IC-2 (dropped-file manufacture discipline) — **parked as ruled**. The
   dropped-file state in goldens is brief-mandated input data exercising the
   frozen B6 branch, not manufactured logic.

## OD rulings summary (pointer; rulings live in spec §21)

Final W13 rulings on the spec §21 table: OD-1, OD-3, OD-6, OD-7 decided as
constrained (state-only intake; hash binding excludes host-coupled fields;
in-scope compiled evidence only; non-fatal FAILED envelope); OD-2, OD-4, OD-5
deferred to a future approved projection/persistence phase (ReconState stays
untouched); OD-8 pinned with corpus citations in `src/semantic/pins.ts`
(every pin family cites the corpus ABI it was observed in; unpinned families
stay `unknown`). See spec §21 for the per-row ruling text.

## Non-goals

This section is the only place in this record that uses verdict-adjacent
vocabulary, so that automated phrasing checks can allow it here and nowhere
else. A candidate invariant is not a finding: it is a property worth checking,
stated with its basis chain and lifecycle status, and it must never be read as
a verdict.

Out of scope for Phase 4, without exception:

- No confirmation of vulnerable code, no exploit construction or execution, no
  attack execution, no severity scoring, no finding generation, no PoC
  authoring or validation, no autonomous scanning.
- No claim of semantic completeness: empty arrays (no invariants, no
  relations, no movements, `contracts: []`) are valid honest outputs where
  evidence is insufficient.
- No claim of ABI-closure completeness: unpinned families stay `unknown`
  (OD-8); pin absence is not a nonexistence proof.
- No claim of movement completeness: unlinked effects carry no `asset_ref`
  and are ledgered, never inferred from verb-like names.
- No critical-severity language of any kind, no verdict predicates on trust
  postures (a dependency record with a trust assumption is a posture, never a
  statement that something is unsafe), no symbolic execution, data-flow, or
  path-sensitivity claims beyond the declared over-approximation in the
  honesty statement above.
