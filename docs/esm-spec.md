# Execution Semantic Model Specification (ESM) — DRAFT

**Status:** DRAFT (unapproved design gate output). This document is a
specification draft produced from the approved ESM brainstorming
(architecture gate). It is NOT approved for implementation. Approval of
this draft does not approve implementation or any implementation plan.
Normative keywords (MUST/MUST NOT) bind future implementation ONLY after
human approval of this draft AND a separately approved implementation plan.

**Relationship to frozen work:** Phase 1–4 SSEM is frozen at
`6d33f5d` and FORMALLY CLOSED. This draft proposes a purely additive,
read-only layer. It changes no frozen file, schema, rule, or behavior.
Anything in this draft that would require touching frozen work is marked
`[EXPLICIT SPEC CHANGE — STOP, needs human approval]` and is NOT decided
here.

**Requirement sources:** R1–R9 are defined by the ESM design brief (they do
not exist in repo docs — verified by grep over `docs/`). Capability-gap
and adversarial review inputs are carried in the brief's core requirement:
«Recon Engine MUST be able to represent deterministic, provenance-backed
influence relationships between security-relevant program values,
conditions, calls, state effects, and external effects without claiming
execution behavior that cannot be established from available evidence.»

## 1. Purpose, scope, and non-goals

**1.1 Purpose.** ESM answers exactly one question, evidence-first:
"What influences what, under what evidenced execution structure?" It
represents deterministic, provenance-backed influence relationships
between security-relevant program values, conditions, calls, state
effects, and external effects. Every represented item carries its
evidence, its epistemic level (capability, never causation), and its
provenance. Anything unprovable is explicit UNKNOWN, never absence.

**1.2 Non-goals (normative).** ESM MUST NOT become: symbolic execution;
SMT/SAT solving; exploit search; vulnerability detector; arbitrary taint
analysis; full alias analysis; value-range analysis; path satisfiability
solver; gas optimizer; PoC generator. ESM MUST NOT use LLM reasoning in
the extraction layer (LLM stays in the reasoning layer, never in semantic
extraction). The four inequalities are normative:
Influence ≠ Taint; Path ≠ Exploit Path; Value Transition ≠ Economic
Exploit; Candidate Invariant ≠ Confirmed Vulnerability.

**1.3 Problems solved / deliberately unsolved.** Solved: R1 influence
(R1), gating conditions (R2-partial), caller context structure (R3),
temporal occurrence (R4), economic-transition explanation chains (R5),
cross-boundary structure (R6), bounded composition (R7), access identity
(R8), evidence preservation (R9). Deliberately unsolved: branch
predicates, path feasibility, return-value linkage, alias resolution,
value content, runtime actor/origin/values, ordering effects, assembly
semantics, dynamic-dispatch targets — all explicit UNKNOWN (see §13).

## 2. Vocabulary (no alias invention)

| Term (this spec) | Meaning | Never means |
|---|---|---|
| **ESM record** | One typed record inside the ESM artifact (DRAFT) | a SSEM record, a finding, a proven fact |
| **Influence-capable** | A static capability relation under stated evidence (declared over-approximation, branch-insensitive) | proven runtime dataflow, causation, taint |
| **Structural dependency** | Co-access, co-location, or graph adjacency without a satisfied edge rule | influence of any kind |
| **Runtime causal influence** | What actually happened at runtime | anything ESM can represent (unrepresentable by construction) |
| **Condition** | A compiler-evidenced necessary constraint on effect execution | the meaning/purpose of a gate, a branch predicate |
| **Path** | An ordered inter-procedural route with per-step conditions | an executable/feasible/minimal/complete path |
| **Execution context** | Static positional frame (entry, chain, call-kinds, gates) | runtime actor, origin, values |
| **Composition** | The traversal/closure algebra (operators + bound + cycle rule) | a record, a result claim, a finding |
| **ESM UNKNOWN** | First-class unknown record (scope + reason + examined basis) | absence, false, an inferred fact |

**2.1 The three influence levels (normative, cf. brainstorming S2).**
(1) *Structural dependency*: adjacency/co-access, no edge rule satisfied —
recordable only as co-access facts, never as edges. (2) *Influence-capable*:
an edge whose strict evidence rule is satisfied — the ONLY influence
claim ESM makes; always labeled with its evidence and the declared
over-approximation (branch-insensitive, per spec §6 honesty precedent).
(3) *Runtime causal influence*: unrepresentable — no ESM record, field, or
claim may denote it. READS-after-WRITES + call chain yields AT MOST level
(2), never level (3).

## 3. Evidence classes (E-class mapping, extends spec §2.3)

ESM reuses `EVIDENCE_CLASSES = ['E1','E2','E3']`
(`src/semantic/model.ts:15-17`) unchanged. Mapping: **E1** — extractor
facts usable as-is (signatures, selectors, types, slots, visibility,
mutability, modifiers name+argsText-opaque, `resolvedRef`, bases,
READS/WRITES/CALLS, EMITS/USES facts, issues, fidelity). **E2** —
deterministic derivations over in-scope compiled E1 only (closures,
paired-access intersections, call-chain routes, composition results
within bound). **E3** — everything else: explicit UNKNOWN records or
`unknown`-typed fields. Classes never upgrade silently (SINV-6 doctrine,
`src/semantic/validate.ts:220-230`). **Forbidden as evidence:** identifier
names, modifier-name meanings, string literals, event-name lookalikes,
cross-project selector heuristics, bare signatures as ABI identity,
general EVM knowledge stated as extracted fact (e.g. delegatecall storage
semantics, payable-revert behavior, timestamp monotonicity) — structural
markers for these are allowed; semantic claims about them are not.

## 4. Determinism, canonicalization, identity (mirror of §13 idiom)

All ESM derivations MUST be deterministic: content ids over
(name-sorted, canonical) payloads per the `semanticContentId` idiom
(`src/semantic/ids.ts:22`); ordering by `compareCodeUnits`
(`src/util/canonical.ts:27`); serialization by `stableStringify`
(`src/util/canonical.ts:1`); no wall-clock, randomness, locale ordering,
absolute paths, or environment values. Traversal order canonical
(sorted ids). Repeated derivation/finalization byte-identical.
`semantic_hash`-style artifact hash (§17) is identity/integrity ONLY,
never evidence that a claim is correct.

## 5. Primitive P1 — SemanticInfluence

**5.1 Formal definition.** A directed, evidence-typed capability edge
`from → to` where endpoints are located references (see §5.4), labeled
with exactly one kind, its evidence refs, its E-class, and its
over-approximation declaration. An edge asserts influence-capability
(§2.1 level 2) and nothing stronger.

**5.2 Admissible evidence.** READS/WRITES relationships + spans;
resolved CALLS edges + `call_kind` metadata; gate descriptors (§6);
ExternalBoundary records (§10); StateAccess records (§9); composition
lineage (§12).

**5.3 Minimum evidence threshold (all required, else no edge).**
`data-supported`: same location id on both ends (E1 type identity) AND a
writer≠reader pair AND a call-chain connecting them in write→read
direction. `control-supported`: an evidenced gate (§6 Condition record)
on the function owning the effect, PLUS shared function ownership (the
gate record and the effect record carry the same function id). Direction
follows evidence: the gate is the edge SOURCE, the effect is the TARGET
(gates constrain effects, never vice versa). `call-supported`: a
resolved CALLS edge (E1 target identity, never bare-signature matching)
into the effect-owning function. Unresolved/marker/ambiguous evidence
fails the threshold.

**5.4 Allowed claims.** The three kinds above, each labeled with its
evidence refs and the sentence "capable under stated evidence;
materialization UNKNOWN". Endpoint shapes: state-version
`(location, writer-context)`, call-site, external-boundary,
ambient-source, and gate/condition (**as `from` endpoint only** — see
gate-endpoint rule below). No other endpoint shapes exist.

**5.4a Gate-endpoint rule (normative, resolves the §5/§6 endpoint
question).** A Condition record MAY appear as an Influence edge `from`
endpoint and MUST NEVER appear as a `to` endpoint; gate→gate edges are
forbidden. Rationale: direction follows evidence — a gate constrains an
effect, while no evidence direction runs from an effect back into its
gate; admitting gate-as-target would license reversed-causality
readings ("the effect influences its own gate"). Gates carry no values:
no data, content, or meaning flows through a gate endpoint (gates are
uninterpreted predicates per §6.5), so a control-supported edge MUST
NOT be read as value flow. Admissible shape is exactly
`gate(G, f) → effect(f)` with shared function ownership (§5.3).

**5.5 Forbidden claims.** Causation, proven dataflow ("g reads f's
value"), taint status, transitivity by default, sources/sinks roles,
sanitizers, implicit flows, alias-crossing propagation, temporal-sourced
edges, boundary-UNKNOWN-sourced edges, value content, gates as `to`
endpoints, gate→gate edges, effect→gate reversed readings, and any
data/content/meaning flowing via a gate endpoint.

**5.6 UNKNOWN conditions + reason taxonomy.** Arg→param mapping:
`no-evidence`. Return→caller: `no-return-linkage` (ESM reason, new).
Branch-gated materialization: `no-branch-evidence`. Alias-across-vars:
`alias-possible`. Syntactic loss of identity: `syntactic-loss`.
Assembly region: `assembly-skipped`. Out-of-scope: `out-of-scope`.
Bound hit: `bound-hit`. Revisit: `cyclic`. (Existing SSEM reasons
`no_evidence`, `unresolved_call`, `unsupported_assembly`,
`out_of_scope_target`, `syntactic_fidelity`, `dropped_file` reused where
they fit; the twelve ESM-only tokens listed above are frozen as
written (new tokens need validator-spec approval before enforcement
— see §18.)

**5.7 Provenance requirements.** Every edge carries `basis ≥1` of real
intake ids (relationship/fact ids + spans); provenance copied
byte-equal per §12.3 idiom (`resolveProvenanceCopy` pattern); no
synthesized provenance.

**5.8 Deterministic identity/hash rules.** Content id over
`(kind, from, to, sorted evidence refs)`; edges sorted by id;
duplicate ids rejected globally (SINV-2 idiom,
`src/semantic/validate.ts:402-410`).

**5.9 Fidelity/degradation behavior.** Any edge whose rule needs identity
collapses to UNKNOWN (with reason) under syntactic fidelity; surviving
edges carry a fidelity echo; degradation notes propagate verbatim, never
upgraded.

**5.10 Composition behavior.** Edges are the atoms of §12; no implicit
transitive closure. Transitivity exists ONLY as composition output with
full lineage + widening markers.

**5.11 SSEM consumer/boundary.** SSEM transition basis enrichment and
ladder `based_on` (subject to §19 integration decision), including
control-supported gate→effect edges as transition basis like any
Influence edge. SSEM MUST NOT re-derive influence; ESM MUST NOT
classify edges as findings.

**5.12 Adversarial counterexample.** Overloaded same-name functions
with different selectors: endpoints keyed by function id + selector, so
`transfer(address,uint256)` (IERC20) and `transferFrom`-adjacent
lookalikes never merge — bare-signature matching is structurally
impossible, unlike a name-keyed design which would conflate them.

**5.13 Value-transition scaffolding boundary (normative).** From current
evidence ESM may claim ONLY located-transition scaffolding:
`(from-location, to-location, via-effect/site)` triples with E1-resolved
locations and an evidenced via effect. It MUST NOT claim: amounts,
asset identity/classification, source/destination ownership beyond the
declaring contract, balance deltas, share/debt/collateral deltas.
Normative distinction: structural/value-transition scaffolding ≠ proven
economic movement ≠ economic exploit. Economic movement requires asset
identity plus amounts (unavailable — SSEM C-layer classifications
consume scaffolding plus pins; ESM never asserts them). The
`SemanticValue`-as-entity removal is hereby reaffirmed: no value entity
may be reintroduced to close this gap; triples compose as scaffolding
(locations + via), never amounts.

## 6. Primitive P2 — SemanticCondition

**6.1 Formal definition.** A compiler-evidenced necessary constraint on
the execution of an effect set: `{kind, descriptor, evidence[]}` with
`kind ∈ {modifier-gate, visibility-gate, mutability-gate,
unresolved-branch}`.

**6.2 Admissible evidence.** Modifier invocation list (name + opaque
`argsText` — recorded verbatim, never parsed for meaning);
`visibility`, `mutability` (FunctionIR E1 fields); function id + span
for `unresolved-branch` (necessary only — sufficiency requires
construct-existence evidence per §6.6).

**6.3 Minimum evidence threshold.** Gate kinds: the compiler field
present on the function. Gate-INVENTORY statement per function ("f's
evidenced gates are exactly [list]") is always satisfiable: it states
completeness over examined gate fields (modifier/visibility/mutability
entries consulted), with basis = function id + the examined field
evidence — an E2 closed-world derivation, not a construct claim.
Construct-specific `unresolved-branch` records additionally require
CONSTRUCT-EXISTENCE evidence per §6.6; a bare function id + span is
necessary but NOT sufficient.

**6.4 Allowed claims.** "Execution of f's effects requires gate G"
(structural necessity). Conjunctions recorded as lists, never as boolean
formulas.

**6.5 Forbidden claims.** The meaning/purpose of any gate ("onlyOwner
means owner-only" — classification, not ESM); branch predicates;
predicate text; economic intent; satisfiability.

**6.6 UNKNOWN conditions + reason taxonomy.** A construct-specific
`unresolved-branch` record MUST have construct-existence evidence: the
construct's presence proven by available evidence, PLUS the predicate's
unavailability. Evidencing records (closed list): flagged-construct
issues WITH file+line provenance (`unsupported_assembly` proves an
assembly region exists; `unsupported_try_catch` proves try/catch
exists; sibling flagged-construct issues likewise);
`customErrorUses` WITH signature + span (a revert site exists, so an
`unresolved-branch` scoped to that revert site is legitimate). Basis
MUST include the existence-evidence id, not just the function id.
Plain `if/require/loop` with NO evidencing record → NO record at all
(neither claim nor UNKNOWN): manufacturing UNKNOWNs for unproven
constructs fabricates existence of the unknown itself. Missing gate
evidence on an examined function → `no-evidence` (the gate-inventory
statement still holds — it asserts exactly what was examined).

**6.7 Provenance requirements.** Basis = function id + gate evidence
(modifier entry / field provenance); no synthesized text beyond the
`"modifier M gates f"` structural-observation idiom (cf. Layer E,
`src/semantic/authority.ts:205-209`).

**6.8 Deterministic identity/hash rules.** Content id over
`(kind, function id, descriptor)`; gate lists sorted code-unit.

**6.9 Fidelity/degradation behavior.** Gates survive syntactic fallback
(fields persist); predicate absence is the normal case, not degradation.

**6.10 Composition behavior.** Conditions conjoin as lists along
composition (modifier-wrap prepends); never simplified, never solved.
Gate-inventory statements compose as examined-field unions;
construct-UNKNOWNs propagate per §12 (never absorbed, never invented).

**6.11 SSEM consumer/boundary.** Layer E gate observations consume
Condition records as evidence (frozen Layer E logic unchanged);
Condition records are edge-source-eligible per §5.4a (from-only);
nothing else about Conditions changes. ESM MUST NOT output role
kinds, authority classes, or `authority_kind`.

**6.12 Adversarial counterexample.** `onlyOwner`-named modifier on a
function with no in-scope ownership backing: Condition records
`modifier-gate {onlyOwner}` + classification stays absent — the gate is
structural evidence while `authority_kind: 'unknown'` remains correct.
A name-interpreting design would upgrade this to owner-authority; ESM
cannot.

**6.13 Formal rationale: visibility/mutability stay Conditions (not
Context metadata).** Criterion: a gate kind qualifies as Condition iff
it is (a) a compiler-evidenced (E1) necessary constraint on effect
execution, and (b) invariant per function (not varying along the call
chain). Visibility/mutability satisfy both; precedent: Layer E's gate
descriptor already bundles `{modifiers, visibility, mutability}`
(`src/semantic/authority.ts:232` region). Context holds the complement:
positional, per-chain properties (caller position, per-hop call-kind).
This criterion governs future gate kinds — anything failing it is
Context metadata or UNKNOWN, never a Condition. No ontology change was
needed; the distinction is now formal.

## 7. Primitive P3 — SemanticPath

**7.1 Formal definition.** An ordered inter-procedural route
`[(node, via-edge, condition)]` over the call/inheritance/delegate
graph, each step annotated with its Condition (possibly UNKNOWN and
flagged as such).

**7.2 Admissible evidence.** Resolved CALLS edges, inheritance bases,
delegate markers, P2 records.

**7.3 Minimum evidence threshold.** ≥1 resolved edge or base; every hop
resolved or explicitly UNKNOWN-marked; intra-function segments collapse
to a single node (no internal ordering claims — source-span order is not
execution order, §6/IC-1 precedent,
`src/semantic/transitions.ts:54-72`).

**7.4 Allowed claims.** "Structural route A→B→C exists under conditions
[c1,c2]". Route existence + per-step conditions only.

**7.5 Forbidden claims.** Executability, feasibility, satisfiability,
reachability ("C reachable via this path"), minimality, completeness,
ordering against other paths.

**7.6 UNKNOWN conditions + reason taxonomy.** Unresolved hop →
terminated route with `unresolved-target` marker + unknown entry.
Intra-function detail → collapsed node (no claim, no entry needed —
absence of claim, not absence of evidence).

**7.7 Provenance requirements.** Basis = ordered edge ids + condition
ids; every Path record carries a mandatory non-claim header (honesty
statement idiom, §6 precedent).

**7.8 Deterministic identity/hash rules.** Content id over ordered
(step tuples); routes sorted by id; no two routes share an id
(SINV-2 idiom).

**7.9 Fidelity/degradation behavior.** Hops losing identity terminate
the route honestly; syntactic inputs yield shorter/UNKNOWN-annotated
routes, never invented hops.

**7.10 Composition behavior.** Paths are BUILT by §12 (not inputs to
it); path enumeration itself bounded (max 128 routes per
query-anchor — frozen, see §21.4; overflow yields explicit
truncated-routes UNKNOWN, never silent), never invented hops.

**7.11 SSEM consumer/boundary.** No current SSEM consumer (explicit —
not a gap to fill silently). Future impact attribution may consume
routes; routes MUST NOT carry impact/effect-typing (that is the
transition's job).

**7.12 Adversarial counterexample.** Diamond call structure A→B→D,
A→C→D with an UNKNOWN condition on B: the route set is {A-B-D
(flagged), A-C-D} with no feasibility ranking — a path-enumerating
design would prune or rank; ESM records both and flags, refusing to
decide which executes.

## 8. Primitive P4 — ExecutionContext

**8.1 Formal definition.** The static positional frame of an execution
point: `{entry, chain, callKinds, gates, unknown:{actor, origin, value,
block, order}}`. Runtime fields are MANDATORY-present and MANDATORY-
UNKNOWN (their presence as UNKNOWN is the claim: "not evidenced").

**8.2 Admissible evidence.** CALLS graph (chain, per-hop kinds),
visibility (entry points), modifier lists (gates).

**8.3 Minimum evidence threshold.** Entry function id + at least the
trivial chain `[entry]`; longer chains require resolved edges per hop.

**8.4 Allowed claims.** Positional structure only: "execution at f
under chain C with gates G".

**8.5 Forbidden claims.** Actor identity, origin (`tx.origin`),
values, block context, ordering vs other executions, role/owner/admin
status of any party.

**8.6 UNKNOWN conditions + reason taxonomy.** Any runtime field →
`runtime-unobservable` + examined basis (chain edges consulted).
Delegatecall hop → `context-shift` marker + storage-subject UNKNOWN
(EVM opcode semantics MUST NOT be stated as extracted fact).

**8.7 Provenance requirements.** Basis = chain edge ids + entry
function id; no party identifiers ever appear in basis.

**8.8 Deterministic identity/hash rules.** Content id over
`(entry, ordered chain, gates)`; contexts sorted by id.

**8.9 Fidelity/degradation behavior.** Chains truncate at identity
loss; truncated suffix recorded as UNKNOWN-hop, never dropped
silently.

**8.10 Composition behavior.** Context attaches to Path steps and
Influence edges as their positional frame; delegate-shift and
callback-reentry cycle through §12 operators.

**8.11 SSEM consumer/boundary.** Layer E actor links consume the
structural chain; classification stays in SSEM. ESM contexts MUST NOT
appear as `actor` claims and MUST NOT feed `authority_kind`.

**8.12 Adversarial counterexample.** Proxy `delegatecall` into an
implementation: context records `context-shift: delegatecall` with
storage-subject UNKNOWN — a design that states "executes in proxy
storage" would be asserting EVM semantics as evidence; ESM marks and
moves on, leaving the question to an explicitly UNKNOWN field that a
future evidence-backed rule (not general knowledge) may fill.

## 9. Primitive P5 — StateAccess

**9.1 Formal definition.** A variable-granularity storage access:
`{location: stateVar id | UNKNOWN, op ∈ {read, write, readwrite},
span, slot-opaque?, subPath: UNKNOWN, scope: contract id}`.

**9.2 Admissible evidence.** StorageAccess edges (op + resolvedRef +
span); StateVarIR (type, visibility, mutability, slot).

**9.3 Minimum evidence threshold.** Location exact iff resolvedRef
resolves E1; else location UNKNOWN with the access edge as basis
(access occurrence is still evidence).

**9.4 Allowed claims.** Exact variable access; opaque slot presence;
op classification (readwrite expands to both, Layer B precedent).

**9.5 Forbidden claims.** Sub-path identity (mapping keys, struct
fields, array indices/lengths); memory/calldata locations; disjointness
in either direction; packing offsets/extents.

**9.6 UNKNOWN conditions + reason taxonomy.** Sub-path: always
`sub-path-unobservable`. Unresolved access: `unresolved-target`.
Memory/calldata: `location-unidentified`. Different-vars aliasing:
`alias-possible` — two different variables MUST NEVER be assumed
disjoint (formal anti-alias rule); same variable IS the same location
(E1 type identity).

**9.7 Provenance requirements.** Basis = access edge id + var id (when
resolved); span preserved for ordering-blind sorting only.

**9.8 Deterministic identity/hash rules.** Content id over
`(location|UNKNOWN, op, span-key)`; accesses sorted (function, span
tuple idiom, cf. `src/semantic/transitions.ts:231-237`).

**9.9 Fidelity/degradation behavior.** Syntactic loss of resolution →
all accesses UNKNOWN-location (occurrence preserved).

**9.10 Composition behavior.** Accesses aggregate per function (Layer B
idiom) then compose; alias-UNKNOWN blocks cross-variable propagation
in §5.10 (propagation requires E1 location identity).

**9.11 SSEM consumer/boundary.** Layer C custody/claims basis; ESM
MUST NOT output asset types, custody locations-as-claims, or
representation pairings.

**9.12 Adversarial counterexample.** `balances[msg.sender]` and
`allowances[a][b]` in one function: both record variable-level access
with `subPath: UNKNOWN`; no claim relates the two mappings, and no
claim separates them either. A points-to design would resolve keys;
ESM records the boundary of its knowledge instead.

## 10. Primitive P6 — ExternalResult

**10.1 Formal definition.** A boundary-call fact: `{site:
call-site id, kind (CallKind + unresolved markers), target: fqn |
marker-id | UNKNOWN, returnLink: UNKNOWN, result: UNKNOWN,
issues[]}`.

**10.2 Admissible evidence.** CallSite (kind + resolvedRef/span);
unresolved markers (`unresolved-delegatecall|staticcall|lowlevel|
indirect-call` facts); `call_target_outside_sources` /
`call_target_unresolved` issues.

**10.3 Minimum evidence threshold.** Site + kind always (they are the
record); target exact iff E1-resolved; else marker-id or UNKNOWN.

**10.4 Allowed claims.** Boundary crossing occurred at site with kind;
target identity when resolved. Nothing else.

**10.5 Forbidden claims.** Return-value linkage, result values,
callee behavior, trust levels, dependency types, selector-only
recognition as identity (OD-6: stays E3/UNKNOWN).

**10.6 UNKNOWN conditions + reason taxonomy.** Return linkage +
result: always `no-return-linkage` (current evidence). Unresolved
target: `unresolved-target`. Out-of-scope: `out-of-scope`.

**10.7 Provenance requirements.** Basis = call-site span + marker/
issue ids; no callee-side ids ever (they are not evidenced).

**10.8 Deterministic identity/hash rules.** Content id over
`(site, kind, target)`; boundaries sorted by id.

**10.9 Fidelity/degradation behavior.** Unresolved kinds are the
normal case, not degradation; each yields entry + UNKNOWN target.

**10.10 Composition behavior.** Boundary records terminate Paths
(§7); they source NO Influence edges when target is UNKNOWN
(edge-source-ineligible, §5.3).

**10.11 SSEM consumer/boundary.** Layer F dependencies consume
boundary records and classify separately (dependency_type, trust
assumptions); ESM MUST NOT output trust levels, dependency types, or
`trust_assumption_ref`.

**10.12 Adversarial counterexample.** Low-level `.call{value:x}("")`
to an unknown address: boundary recorded (kind + site), target
UNKNOWN, return UNKNOWN — while a taint design would propagate the
return value into the caller and a detector would flag reentrancy.
ESM records the crossing and stops; callback/reentry ordering stays
UNKNOWN under §12's reentry rule.

## 11. Primitive P7 — TemporalSource

**11.1 Formal definition.** An ambient-input temporal marker:
`{kind: block.timestamp|block.number|… | UNKNOWN-kind, consumers:
[function ids], value: UNKNOWN, ordering-effect: UNKNOWN}`.

**11.2 Admissible evidence.** ONLY: (a) issue/fact records naming
the builtin (or builtin class) WITH file+line provenance, AND (b) an
enclosing-function attribution via span containment (use-site span
structurally inside a function span — an E2 derivation, stated as
such), AND (c) the consuming function id. Compiler builtin
classification ALONE (a kind taxonomy without an occurrence record)
is NOT sufficient evidence — classification ≠ occurrence.

**11.3 Minimum evidence threshold.** All of §11.2(a–c) MUST hold,
else NO record. If an occurrence record exists but provenance is
insufficient (missing file/line, or attribution ambiguous across
functions) → UNKNOWN-kind record with examined basis (occurrence
acknowledged; kind/consumers unproven). If NO occurrence record
exists → NO record at all: absence of evidence is not evidence, and
no placeholder is manufactured. (Asymmetry with §6 is deliberate
and consistent: gate-inventory states completeness over examined
fields, while temporal sources are existential claims requiring
occurrence evidence.) If granularity is insufficient to name the
builtin — including the normal case, where the occurrence record
carries file+line provenance but names only a builtin class (the
expected shape per `src/recon/ir/build.ts:301`, where builtin names
are dropped) — kind is UNKNOWN-kind with examined basis (never
guessed from surrounding code). The class label MAY appear in
basis/provenance text but MUST NEVER appear as the kind value.
Source text MUST NOT be read to recover the builtin name (decision
21.1).

**11.4 Allowed claims.** Occurrence + consumer list. Period.

**11.5 Forbidden claims.** Value, ordering effects, time-dependence
("f is time-dependent"), miner influence, monotonicity, staleness,
causal influence of any kind. Formal verdict: **consumer ≠ causal** —
a consumer list denotes occurrence-sites, never causes.

**11.6 UNKNOWN conditions + reason taxonomy.** Value + ordering:
always `value-unobservable` + `ordering-unobservable`. Ambiguous
builtin: `ambiguous-source-kind`. Insufficient-provenance
occurrence: UNKNOWN-kind with the occurrence basis retained
(kind/consumers unproven, occurrence acknowledged).

**11.7 Provenance requirements.** Basis = issue/fact ids +
consumer function ids, with the span-containment attribution recorded
as an E2 derivation step in the basis lineage; no block data (none
exists).

**11.8 Deterministic identity/hash rules.** Content id over
`(kind, sorted consumers)`; temporals sorted by id.

**11.9 Fidelity/degradation behavior.** Preserved (flags survive
fallback); never upgraded, never dropped.

**11.10 Composition behavior.** Temporal markers attach as ambient
inputs where consumer sets overlap influence endpoints — WITHOUT any
causal edge (hard rule, §5.10 reinforcement).

**11.11 SSEM consumer/boundary.** Basis for `temporal`
CandidateInvariants; ESM MUST NOT claim time-dependence or feed
invariant statements beyond occurrence records.

**11.12 Adversarial counterexample.** `block.timestamp` occurring
in a payout function with an evidencing builtin-use record: temporal
occurrence recorded with the function as consumer; the gating
predicate itself gets NO record (bare `require` has no evidencing
record per §6.6 — only the function-level gate-inventory holds); NO
claim connects the timestamp to the payout outcome. A detector would
flag "timestamp dependence"; ESM records occurrence + UNKNOWN effect
— the distinction between evidence and verdict, mechanically
enforced.

## 12. Primitive P8 — SemanticComposition (algebra, not a record)

**12.1 Formal definition.** The traversal/closure algebra producing
composed summaries and Paths from per-function evidence. Operators
(each: input → output → bound → cycle behavior → widening →
lineage semantics):
- `call-inline`: caller summary ∪ callee summary along a resolved
  edge as an OWNERSHIP-PARTITIONED union (§12.7): every
  effect/condition/access/basis entry retains its owner tags
  `(function id, contract id)`; partitions stay separable (dropping
  either side's tags fails validation); conditions conjoin as
  owner-tagged lists; located value triples compose as scaffolding
  (locations + via), never amounts (§5.13); lineage appends
  `(call-inline, edge id)`; unresolvable callee → UNKNOWN-target
  marker, caller side preserved.
- `inherit-merge`: base summaries into derived along E1 bases;
  lineage appends `(inherit-merge, base fqn)`; unknown base →
  marker, derived side preserved.
- `modifier-wrap`: gate conditions prepend to the wrapped
  function's condition list; lineage appends `(modifier-wrap,
  modifier name)`; never interprets the modifier.
- `delegate-shift`: context replaced by shift marker +
  storage-subject UNKNOWN; effects composed under the marker;
  lineage appends `(delegate-shift, site id)`.
- `callback-reentry`: reentry-CAPABILITY union (never a claimed
  second invocation). Requires BOTH (a) an evidenced outward call
  (resolved CALLS edge or boundary marker WITH site id) AND (b) an
  evidenced reentry entry (external/public function id, optionally
  with in-scope hook interface). Missing either → result UNKNOWN
  with reason (no union at all — capability unproven; the operator
  MUST NOT synthesize a second-invocation record, it reuses the
  existing function summary under the capability marker). The union
  output carries lineage status `reentry-capable` (vs `direct`),
  distinguishing it from first-invocation composition; order UNKNOWN
  always. NO promotion of `reentry-capable` to concrete effects
  downstream — SSEM MUST treat it as capability-level. Lineage
  appends `(callback-reentry, outward-call id, entry id)`;
  provenance = both evidences.
Bound: fixed maximum traversal depth **8** (frozen: corpus-measured
max depth 2 over 9 corpora / 78 functions, p99 2, zero truncation at
8; 4× observed max with headroom for realistic 3–5-hop patterns;
fixed constant + explicit widening preserve determinism; see §21.3).
Cycle behavior: visited-set over `(function id, context-hash)` —
where context-hash is the context record's own content id per §8.8 —
revisit terminates the branch with a `cyclic` marker. Widening:
bound-hit or cycle yields explicit UNKNOWN records scoped to the cut
branch (never silent drop, never partial claim presented as whole).
Lineage semantics: every composition output carries the ordered
operator sequence + bound-hit flags + cycle markers + input record
ids, so any consumer can audit exactly how it was derived.

**12.2 Admissible evidence / thresholds / claims.** Same as the union
of §§5–11 inputs; operator preconditions are the per-primitive
thresholds (an operator whose input is UNKNOWN propagates UNKNOWN,
never invents).

**12.3 Forbidden.** Unbounded recursion, fixpoint-by-widening-to-
concrete, cycle unrolling, order inference, cross-branch value
merging, lineage-free outputs, owner-tag stripping, flat merges
erasing caller/callee separation, context collapse into an
undifferentiated context, reentry union without both evidences,
promotion of `reentry-capable` to concrete, synthesized
second-invocation records.

**12.4 UNKNOWN / provenance / identity / fidelity.** Widened parts
get first-class §13 unknowns with reason `bound-hit`/`cyclic`;
lineage IS the provenance (ordered operator + input ids);
composition results are content-addressed like records; fidelity
echoes the weakest input fidelity; degradation notes propagate
verbatim.

**12.5 SSEM boundary.** SSEM consumes composition outputs and paths;
it MUST NOT re-traverse (no second composition implementation in
SSEM); ESM composition outputs MUST NOT carry impact, findings, or
classifications.

**12.6 Adversarial counterexample.** Recursive `distribute()` calling
itself with a state update: first visit composes normally, revisit
hits the visited-set → branch terminates with `cyclic` marker +
UNKNOWN scoped to deeper effects. A fixpoint design would iterate to
convergence and claim a summary; ESM marks the cut honestly.

**12.7 Ownership preservation (normative).** Composed summaries MUST
partition by owner (originating function id + contract id):
ExecutionContext is recorded SEPARATELY for caller and callee, linked
by the edge id — composition MUST NOT collapse caller/callee execution
context into a single undifferentiated context. Contract/function
identity is retained on both sides; StateAccess keeps declaring
contract + accessing function; gates keep owning function; external
effects keep the origin chain (effect → site → function → contract);
provenance lineage includes the owner map. Test obligation (normative
for future implementation): a composed A→B summary MUST expose
separable A-partition and B-partition; any consumer MUST attribute
each entry to its owner; context-collapse fails validation.
Counterexample/test obligation for reentry: a `chargeFee()`-style
outward call from a contract with NO exposed external entry → no
union, UNKNOWN (capability unproven); an unknown-target outward call
without an anchorable entry → UNKNOWN; a hook-interface case →
capability union WITH `reentry-capable` status + UNKNOWN order.

## 12.8 Transient lifecycle of ComposedSummary (normative)

**Ruling (normative).** A ComposedSummary is a deterministic, transient
pipeline output. It is NOT an ESM record (§2: an ESM record is a typed
record inside the artifact; §2 Composition "never means a record"): it
has no content id, is not a member of any §14 array, is not counted in
§14 counts, and is not hashed into `esem_hash`.

1. **Shared derivation pass (normative).** `deriveEsm(index):
   EsmArtifact` is UNCHANGED. One internal helper derives, in a single
   pass over the code-unit-sorted function ids through the single
   `composeFunction` implementation, the primitives, the per-function
   summaries, and the composed unknowns. `deriveEsm` and the separate
   pure function `deriveCompositions(index)` (returning `{ summaries,
   unknowns }`) are thin projections of that helper's result: no
   second traversal, no duplicate derivation, no second implementation
   (the §19.3 "MUST NOT re-traverse" constraint binds any consumer to
   the single implementation). No cache, memoization, or shared mutable
   state is introduced: each public call recomputes purely, and the
   determinism guarantee is scoped to content-identical indexes (same
   record contents; Map insertion order irrelevant; mutated indexes
   outside the guarantee). The transient `unknowns` MUST equal, by id
   set, the composed unknowns merged into the artifact for the same
   index — the observable proof both projections fed from one pass.
2. **Artifact-invariance (normative).** For any content-identical
   index: (a) **determinism** — `serializeEsm(deriveEsm(index))` is
   byte-identical across repeated calls in one process (full serialized
   `EsmArtifact` bytes — including `counts` and `esem_hash` — not the
   hash alone), and `computeEsmHash` recomputes to the attached
   `esem_hash`; (b) **non-interference** — `serializeEsm(deriveEsm(index))`
   is byte-identical whether or not `deriveCompositions(index)` is
   additionally invoked in-process, for exactly these call orderings:
   `[deriveEsm, deriveEsm]`, `[deriveCompositions, deriveEsm]`,
   `[deriveEsm, deriveCompositions, deriveEsm]`,
   `[deriveCompositions, deriveCompositions]` ("all interleavings" in
   this section means these four orderings only — not an exhaustive
   proof over unlisted sequences); (c) **equivalence** — the transient
   `unknowns` id-set equals the artifact's composed-unknowns id-set
   for the same index. The pre-/post-API-addition comparison is
   implemented by these in-tree surrogates (the pre-change code is gone
   post-merge): the entire pre-existing `deriveEsm` suite stays green
   unmodified (behavior preserved) plus (a)–(c). Structural,
   review-gated rather than test-provable: (d) `deriveEsm` and
   `deriveCompositions` are thin projections of one shared internal
   helper — single per-function loop, no second traversal, no duplicate
   derivation; (e) `deriveEsm`'s signature is textually unchanged,
   envelope/counts/hash/id rules untouched, and no cache, memoization,
   or shared mutable state is introduced (no module-level mutable
   bindings, no index mutation).
3. **Entry ordering preserves §12.1 semantics (normative).** Within
   each per-function partition, that function's own modifier gates
   come first in authored modifier order (§12.1 modifier-wrap: "gate
   conditions prepend"; §6.10 conjunctions "never simplified, never
   solved"). The remaining own entries use the existing canonical
   comparator (kind, then ref, code-unit). Composed unions preserve
   first-seen order (caller before callee, derived before base). No
   global re-sort of summary entries is performed; §12.1 prepend
   semantics are not overridden. Repeated derivation is byte-identical.
   Reordering guarantee (narrow): permuting the insertion order of
   index maps (`functionsById`, `relationshipsById`, `factsById`,
   `contractsById`, `stateVariablesById`, `provenanceById`,
   `issuesByFile` buckets) and of the primitive parts arrays yields
   identical summaries, unknowns, artifact, counts, and hash — because
   every such collection is re-sorted (code-unit) before
   order-sensitive use. Expressly excluded from reordering: authored
   intra-record orders that are semantic content (`fn.modifiers`
   order, `provenance` record arrays as byte-equal evidence, opaque
   evidence strings), which MUST be preserved byte-equal; and derived
   positional arrays (`chain`, `callKinds`, `hops`, lineage sequence),
   which follow the specified traversal order. A reversed-insertion
   test MUST NOT shuffle, sort, or normalize these excluded orders.
4. **Summary ordering and cardinality (normative).** Exactly one
   summary per `functionsById` key, including empty-partition
   functions, sorted by `(owner.function, owner.contract)`
   code-units. Summary contexts are copies of existing §8 records
   sorted by id code-units. Transient unknowns are id-sorted,
   matching post-finalize artifact unknown order.
5. **References without synthetic ids (normative).** Every entry `ref`
   MUST resolve to a primitive record id of the same run (equal to the
   corresponding §14 array member id); every summary context MUST be an
   existing §8 record (id in the run's contexts); every lineage `edge`
   / `entry` MUST be a real intake id or an operator-bound marker
   (modifier name, base ref, site id) per the §12.1 operator tuples.
   Traversal-internal visited keys (e.g. `resolveContextId` fallbacks)
   MUST NEVER appear in outputs. Basis ≥1 and no-synthesized-
   provenance (§16) apply unchanged.
6. **Lineage flags are opaque diagnostics (normative).** Lineage
   preserves traversal order with first-seen dedupe. Flag values and
   marker shapes beyond the §12.1 operator tuples and the
   bound-hit/cyclic markers are opaque diagnostics: no closed flag
   vocabulary is invented here, emitted flags are not changed, and
   consumers MUST NOT interpret them. Auditability rests on the
   operator sequence, owner tags, and entry references.
7. **Bounded auditability (normative).** Transient output supports:
   input/reference traceability (entry refs → primitive ids),
   operator sequence (lineage order), and ownership partitioning
   (owner tags per §12.7). It does NOT provide per-step
   input-consumption reconstruction (lineage records carry no
   per-step input linkage) or integrity binding of transient
   summaries (outside `esem_hash`); both remain deferred, and
   recomputation-based verification is deferred together with
   consumption.
8. **Consumers: NONE in production today (explicit deferral,**
   **normative).** Precedent: §19.2 Paths ("no consumer today —
   explicit"). §12.5 is direction plus future-consumption constraint
   (outputs stay impact/finding/classification-free; SSEM MUST NOT
   re-traverse per §19.3). **§19.2 map UNCHANGED.** SSEM wiring,
   ladder `based_on`, SINV, UNKNOWN roll-up, temporal scope, and
   source-reader policy remain STOP (§§18, 19.5, 21.1–21.2).
9. **§12.4 note (interpretive, normative as stated).** Summaries
   satisfy the determinism half (byte-identical, sorted as above) and
   are keyed by owner tuple; no summary content-ids are minted (no id
   family for summaries exists in §14/§21.6). "Content-addressed like
   records" applies to composition outputs that are records (paths,
   unknowns). Fidelity echo and degradation notes for composition
   outputs are carried by the artifact as today (artifact
   `inputs.fidelity` plus unknowns); summaries gain no separate
   fidelity/degradation fields — deferred. **§§14/15/16/18
   UNCHANGED** (eight arrays, counts keys, `seme:` family, envelope
   exclusivity, hash exclusions, provenance rules).

*Example (non-normative; normative rules govern, orders as stated).*
A→B: summaries sorted by owner (`(A,Hub)` before `(B,Hub)`); the
A-summary entries open with A's modifier gates in authored order
(`m1`, `m2`), then remaining entries in (kind, ref) order; contexts
are serialized by id code-units (chains `[A]`, `[A,B]`, `[B]` shown
for illustration — actual order is id order, not chain order);
lineage shows traversal order with flag strings carried opaquely.

*Deferred (not decided).* Ever enveloping summaries; an edge-link
field on contexts; per-step input linkage; integrity binding;
exact new-function name (`deriveCompositions` proposed, human
confirms).

## 13. Primitive P9 — SemanticUnknown

**13.1 Formal definition.** First-class unknown record:
`{scope (which question is unanswered, in closed vocabulary),
reason (closed taxonomy below), basis (examined intake ids, ≥1),
provenance}`. UNKNOWN is data, not absence: it is counted, sorted,
hashed, and validated like any record.

**13.2 Reason taxonomy (frozen token list; new tokens need validator-spec
approval before enforcement, see §18).** Reused SSEM reasons where
they fit: `no_evidence`, `unresolved_call`,
`unsupported_assembly`, `out_of_scope_target`, `syntactic_fidelity`,
`dropped_file`. ESM-only additions: `no-return-linkage`,
`no-branch-evidence`, `sub-path-unobservable`,
`location-unidentified`, `alias-possible`, `value-unobservable`,
`ordering-unobservable`, `ambiguous-source-kind`,
`runtime-unobservable`, `context-shift`, `bound-hit`, `cyclic`.
Closed: reasons outside this list MUST NOT be emitted.

**13.3 Allowed / forbidden.** Allowed: precise scoping of ignorance
with examined basis. Forbidden: UNKNOWN mutating into absence
(counted as zero), into false, or into an inferred fact downstream
(enforced at consumption: SSEM roll-up rule §19.4 treats ESM
unknowns as basis-only, never as resolvable).

**13.4 Provenance / identity / fidelity / composition.** Basis ≥1
real intake ids + byte-equal provenance where applicable; content
id over `(scope, reason, sorted basis)`; sorted with all records;
fidelity echo preserved; composition propagates unknowns (never
absorbs them).

**13.5 SSEM boundary.** ESM unknowns are consumable as `basis` refs
by SSEM unknowns; they MUST NOT auto-create SSEM unknowns and MUST
NOT satisfy ladder `based_on` patterns (frozen regexes — see §19.5).

**13.6 Adversarial counterexample.** A `try/catch` around an external
call whose body was walked but whose semantics are flagged unknown:
records `scope: catch-branch-semantics, reason: unsupported-construct
(mapped to syntactic-fidelity family), basis: [issue id, function
id]` — instead of either dropping the branch silently or claiming
"failures are handled". The unknown is counted in `counts` and hashed
into the artifact: ignorance with a receipt.

## 14. Artifact schema / envelope (frozen — new, additive only)

The ESM artifact is a SEPARATE artifact (approach A retained from
brainstorming; SSEM envelope `semantic-model/v1` untouched — frozen).
Proposed envelope `esem-model/v1`: `{schema_version,
inputs:{state_output_hash, fidelity, scope_hash?, file_count},
influences[], conditions[], paths[], contexts[], accesses[],
boundaries[], temporals[], unknowns[], counts{}, esem_hash}`.
`counts` recomputed from array lengths (SINV-2 idiom). Status field:
NONE at ESM level — ESM output has no COMPLETE/PARTIAL/FAILED notion;
completeness-like questions are degradation echoes + unknown counts,
never a verdict (validation PASS ≠ completeness doctrine extends
here). All arrays id-sorted; all records schema-validated at build.
Record id family (frozen per §21.6 approval): `seme:` prefix
with kind bound in the content-id payload (mirroring the
`semanticContentId(prefix, payload)` idiom); coexistence with the
frozen `sem*:` families is decided as convention (ladder `based_on`
integration itself remains STOP per §19.5).

## 15. Canonical serialization, ordering, semantic hash

Serialization = `stableStringify` (`src/util/canonical.ts:1`); ordering
= `compareCodeUnits` (`src/util/canonical.ts:27`) over every id-bearing
array; duplicate ids rejected globally (SINV-2 idiom,
`src/semantic/validate.ts:402-410`); `esem_hash` =
`sha256(stableStringify(artifact − esem_hash − host-coupled binding
fields))` mirroring OD-3 (`src/semantic/report.ts:108-118`): excluded
are exactly `esem_hash` + run/host-coupled binding (`run_id`,
`input_manifest_hash`, `scope_hash`-equivalents); `state_output_hash`
is INCLUDED (content sensitivity). Hash is identity/integrity ONLY.
Nested ref-lists (`based_on`-equivalents, basis, endpoints) preserve
authored order (IC-1/W10 nested-order ruling precedent: order-bearing
arrays without declared sort tuples are not re-sorted). Leakage: output
bytes MUST match none of timestamp/absolute-path/backslash patterns
(SINV-10 idiom).

## 16. Provenance model

Every ESM record carries `basis ≥1` of real intake ids; provenance
copied byte-equal per §12.3 idiom (`resolveProvenanceCopy` pattern);
roots MUST be state entities or registry provenance (SINV-4/5 idiom,
`src/semantic/validate.ts:134-139,213`); DAGs MUST be acyclic
(SINV-5 idiom); argsText-style opaque strings are evidence text, never
parsed; no synthesized provenance, ever.

## 17. Degradation propagation

ESM echoes input fidelity (`semantic|syntactic`) and degradation notes
verbatim; syntactic collapse rule (§§5–11) converts identity-needing
claims to UNKNOWN with reason (never silent); degradation is preserved
through finalize-equivalent and hash (notes are content, hashed);
ESM MUST NOT manufacture degradation to explain gaps, and MUST NOT
suppress degradation it received.

## 18. Validator requirements (requirements ONLY — no new SINV reasons defined here)

A future ESM validator MUST mechanically enforce, in fixed order:
schema conformance + envelope exclusivity; id uniqueness + sortedness +
counts match; `basis ≥1` + resolvability + provenance byte-equality;
`based_on`-equivalent DAG acyclicity + provenance roots; forced
confidence/status levels (to be fixed at spec-phase — DRAFT proposes
DERIVED/INFERRED/SPECULATIVE mirroring, NOT decided); forbidden-
vocabulary scan (spec §2.1 list); attribution to state entity;
unknown discipline (every UNKNOWN-field has a ledger entry; widened
branches ledgered); hash recompute + leakage scan; binding re-derivation
(`state_output_hash` + run/scope equivalents); scope compatibility
(EXCLUDED rejected, UNRESOLVED/UNSUPPORTED need degradation);
fidelity honesty (syntactic ⇒ degraded, never clean); envelope shape.
`[EXPLICIT SPEC CHANGE — STOP, needs human approval]`: minting new
SINV-family reason tokens (§13.2 additions) and any ESM validator are
spec changes OUTSIDE this draft; this section states requirements so a
later phase can adopt them verbatim, not decisions.

## 19. SSEM relationship and consumption contract

**19.1 Direction.** SSEM consumes ESM read-only (like ReconState);
ESM never imports SSEM derivations as evidence (no circularity:
ESM evidence closes over Phase 1–3 intake only).

**19.2 Consumption map (PROPOSED, additive).** Influence edges →
transition `basis` enrichment + ladder `based_on` candidates;
Conditions → Layer E gate-evidence; Paths → future impact
attribution (no consumer today — explicit); Contexts → Layer E
structural actor evidence; Accesses → Layer C basis; Boundaries →
Layer F dependency evidence; Temporals → `temporal` invariant
basis; ESM unknowns → SSEM unknown `basis` refs.

**19.3 Non-duplication rule.** SSEM MUST NOT re-derive influence,
re-traverse composition, or re-resolve ESM UNKNOWNs; ESM MUST NOT
classify, mint observations/assumptions/hypotheses, or emit findings.
Layer E's frozen gate logic stays as-is; future integration consumes
ESM Condition records through new (spec-approved) code paths only.

**19.4 Unknown roll-up (PROPOSED — needs approval).** ESM unknowns
are consumable ONLY as `basis` refs of SSEM unknowns; they MUST NOT
auto-create SSEM unknowns, MUST NOT satisfy frozen ladder
`based_on` regexes (`semobs/semasm` — frozen model.ts), and MUST NOT
be read as resolvable-later. Roll-up is basis-linkage, never
promotion.

**19.5 Frozen integration points (explicit STOPs, not decisions).**
(a) Ladder `based_on` patterns admitting ESM refs = frozen
`model.ts` change. (b) New SINV-family reasons = spec + validator
change. (c) ESM id family decided as `seme:` (§14); ladder `based_on`
integration remains STOP. Only (c)-family is resolved by freeze; (a),
(b), roll-up (§19.4), and remaining §21 items stay STOP/deferred as
marked.

## 20. R1–R9 traceability matrix

| Req | Spec sections | Status in this draft |
|---|---|---|
| R1 Semantic Influence | §5 (edge rules), §12 (transitivity only via algebra) | Specified; taint excluded by construction |
| R2 Path & Condition Semantics | §6 (gates + gate-inventory + construct-UNKNOWN), §7 (routes) | Partial by design: gates + gate-inventory specified; evidenced constructs get explicit UNKNOWN, unproven constructs get no record (§6.6) |
| R3 Execution / Caller Context | §8 (static frame + mandatory UNKNOWN runtime) | Specified |
| R4 Temporal Sources | §11 (occurrence + consumers, causal forbidden) | Specified as occurrence-only |
| R5 Economic Transition Semantics | §5.4 endpoints (location pairs), §5.13 scaffolding boundary, §12 call-inline | Specified as located-transition scaffolding ONLY: amounts/identity/deltas forbidden; scaffolding ≠ movement ≠ exploit; Value entity stays removed |
| R6 Cross-Boundary Influence | §10 (boundary facts, return/result UNKNOWN) | Specified; return linkage permanently UNKNOWN on current evidence |
| R7 Semantic Composition | §12 (5 operators + bound 8 + widening + cycles) | Specified; path cap 128 (§7.10, §21.4 frozen) |
| R8 State Identity & Memory Semantics | §9 (variable granularity, anti-alias rule) | Specified; sub-path/memory permanently UNKNOWN on current evidence |
| R9 Evidence-Preserving Semantics | §3, §13, §16, §17 | Specified end-to-end |

## 21. Unresolved decisions (NOT resolved silently — each needs explicit approval)

1. **Structural source reader exception:** DEFAULT NO (IR-only strict). Allowing even a bounded source-text reader is an explicit exception to the no-second-parser frozen rule. Recommend AGAINST unless R2-partial proves insufficient in a pilot.
2. **Temporal scope final:** DEFAULT `block.*` flagged builtins only; `msg.*` builtins excluded (actor-adjacent → context-UNKNOWN). Final list needs corpus evidence.
3. **Composition bound value:** **8** (frozen: corpus-measured max depth 2 over 9 corpora / 78 functions, p99 2, zero truncation at 8; 4× observed max with headroom for realistic 3–5-hop patterns; fixed constant + explicit widening preserve determinism).
4. **Path enumeration bound:** **128 routes per query-anchor** (frozen: corpus-wide simple routes order ~10², per-anchor single digits; >10× headroom; overflow yields explicit truncated-routes UNKNOWN, never silent).
5. **New SINV family:** EXPLICIT SPEC CHANGE — STOP (see §18). The §13.2 reason-token strings themselves are frozen as written; only family/enforcement stays STOP.
6. **Id family: `seme:` DECIDED (family only).** Ladder `based_on` integration: EXPLICIT SPEC CHANGE involving frozen `model.ts` — STOP (see §19.5).
7. **Unknown roll-up rule (§19.4 PROPOSED):** needs approval before any SSEM code cites ESM unknowns.
8. **ESM status/completeness notion:** DEFAULT NONE (§14) — any future PARTIAL-like notion is a spec decision, not an implementation convenience.

## 22. Deviations from current architecture

NONE. This draft is purely additive: it requires zero changes to
frozen files, schemas, rules, goldens, hashes, or behaviors. The only
forward references to frozen work are read-only consumption patterns
already proven by SSEM waves W1–W13. §19.5 lists the exact points
where future work WOULD touch frozen scope — flagged as STOPs, not
deviations.

## 23. Consistency review against Phase 1–4 frozen constraints

- No second parser/IR/discovery/extraction: ESM consumes EvidenceIndex-
  level intake + derives; source text never read (enforced by §6.5,
  §11.5, decision 21.1). CONSISTENT.
- OD-1 state-only: ESM input closes over Phase 1–3 intake; byteStart
  and IR internals unavailable and unneeded (ordering by line-tuples
  per IC-1 precedent). CONSISTENT.
- Epistemic doctrine (§2.1 vocab, E-classes, forbidden words, no
  CONFIRMED): restated normatively in §§2–3 with ESM mappings; no
  relaxation. CONSISTENT.
- Determinism/hash doctrine (OD-3 idiom): mirrored in §§4, 15, never
  altered. CONSISTENT.
- SSEM validator/finalize/wrapper untouched: §§18–19 state
  requirements and consumption contracts without modifying
  `validate.ts`/`report.ts`/`analyze.ts` semantics. CONSISTENT.
- Phase 1–3 foundations (ReconState, IR, traceability, scope):
  referenced as read-only sources only. CONSISTENT.
- Goldens/pins/corpus: no pin additions, no corpus changes, no
  golden expectations proposed. CONSISTENT.
- IC-1/IC-2/W6-behavior/mirrors/hygiene carry-forwards: explicitly
  preserved (§§7.3 ordering precedent, §19 notes, decision list).
  CONSISTENT.

## 24. Adversarial summary (30 cases → 4 mechanisms, 0 special-case rules)

M1 typed edges + strict evidence (overloads-by-selector, helpers,
library-context rule, fallback/receive entries, dynamic-dispatch
UNKNOWN, unknown-external UNKNOWN, return-UNKNOWN). M2 UNKNOWN-first
conditions + evidenced gates (modifiers ordered, multi-modifier,
unchecked-arithmetic UNKNOWN, try/catch walked-but-unknown,
timestamp occurrence-only, fee-computation UNKNOWN). M3 bounded
composition + cycle rule (inheritance merge, override-resolved-or-
UNKNOWN, recursion/loop fixpoint-to-UNKNOWN, delegatecall shift,
proxy impl/upgrade UNKNOWN, callback capability-or-UNKNOWN, oracle
marker + assumption-stays-assumption). M4 first-class unknowns
(mapping/struct/array sub-paths, aliasing never-disjoint, packing
opaque-slots, revert signature-only, assembly skipped regions,
constructor once-ness UNKNOWN). Hardest cases held by explicit
rules, not exceptions: aliasing (§9.6), reentrancy (§12
callback-reentry), delegatecall/proxy (§8.6 + §12 delegate-shift
without stating opcode semantics as fact), unknown return (§10.6
permanent UNKNOWN).
