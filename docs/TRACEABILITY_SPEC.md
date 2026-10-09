TRACEABILITY_SPEC.md

Phase 2.5-A — Recon Traceability & Auditability Foundation

Status: Proposed
Schema: "recon-state/v1"
Scope: Deterministic Recon Pipeline
Non-goal: Evaluation, LLM reasoning, vulnerability discovery, exploit validation, autonomous learning

---

1. Purpose

Traceability is the ability to determine:

1. where a Recon output came from,
2. what evidence produced it,
3. what deterministic operation derived it,
4. which Recon Run produced it,
5. which source/compiler/analyzer/configuration identity was used,
6. whether the lineage is complete,
7. and whether the output can be reproduced within its declared execution context.

Traceability is not equivalent to source provenance.

- Provenance answers: "Where did this evidence come from?"
- Derivation lineage answers: "How did this output come to exist?"
- Run identity answers: "Under which execution context was it produced?"
- Traceability combines these into an auditable chain.

The canonical deterministic pipeline is:

Source
  ↓
Compiler / AST
  ↓
Normalized IR
  ↓
Extractor / Rule
  ↓
Fact / Relationship
  ↓
ReconState

Phase 2.5-A makes this pipeline auditable.

---

2. Design Principles

2.1 Evidence first

Traceability MUST point toward evidence.

The system MUST NOT use traceability metadata to upgrade an inference into a fact.

---

2.2 No silent lineage

A material output without sufficient lineage MUST NOT silently appear as fully traceable.

Its trace status MUST explicitly indicate incomplete or missing lineage.

---

2.3 Deterministic identity

Canonical IDs and hashes MUST NOT depend on:

- random values,
- wall-clock time,
- process IDs,
- machine-specific temporary paths,
- iteration order that is not explicitly canonicalized.

---

2.4 Immutable historical identity

A previous Recon Run MUST remain identifiable after a newer run is executed.

If the source changes, the system MUST create a new source/run identity rather than silently rewriting historical provenance.

---

2.5 Run isolation

An output produced by Recon Run A MUST NOT silently inherit derivation ownership from Recon Run B.

---

2.6 Explicit uncertainty

Traceability MUST preserve:

- "UNKNOWN"
- "UNSUPPORTED"
- "INCOMPLETE"

and MUST NOT convert them into positive claims.

---

3. Traceability Layers

Traceability consists of the following layers.

Layer 1 — Source Identity
Layer 2 — Run Identity
Layer 3 — Evidence / Provenance
Layer 4 — Derivation
Layer 5 — Output Lineage
Layer 6 — Trace Completeness

Future phases may extend the model with:

Reasoning
Decision
Outcome
Learning

Those are explicitly out of scope for Phase 2.5-A.

---

4. ReconRun

Introduce a first-class "ReconRun".

A Project may have multiple runs:

Project
 ├── Run A
 ├── Run B
 └── Run C

4.1 ReconRun fields

type ReconRunStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIAL';

interface ReconRun {
  id: string;

  project_id: string;

  schema_version: string;
  analyzer_version: string;

  started_at: string;
  completed_at?: string;

  status: ReconRunStatus;

  source_identity: SourceIdentity;
  compiler_identity: CompilerIdentity;
  configuration_identity: ConfigurationIdentity;

  input_manifest_hash: string;

  output_identity?: OutputIdentity;
}

Timestamps are execution metadata and MUST NOT be used as canonical object identity.

---

5. Source Identity

Source identity MUST be separate from compiler identity.

Do NOT place source hashes under compiler metadata.

5.1 SourceIdentity

interface SourceIdentity {
  source_hash: string;

  manifest_hash: string;

  repository?: string;
  commit?: string;

  source_root?: string;
}

Source hash

The existing Phase 2 source hashing scheme remains authoritative unless explicitly superseded:

sha256 over canonical sorted:
path:sha256(file)

The exact canonicalization MUST be documented and tested.

---

6. Compiler Identity

Compiler identity answers:

«Which compiler environment was used?»

interface CompilerIdentity {
  compiler: string;
  version: string;

  binary_hash?: string;

  backend: string;
}

Example:

{
  "compiler": "solc",
  "version": "0.8.37",
  "binary_hash": "sha256:...",
  "backend": "solc-js"
}

Compiler identity MUST NOT be confused with source identity.

---

7. Configuration Identity

Configuration identity answers:

«Which analysis configuration was used?»

interface ConfigurationIdentity {
  config_hash: string;
}

The hash MUST be calculated over a canonical serialization.

Machine-specific temporary paths SHOULD NOT affect canonical configuration identity.

---

8. Output Identity

Output identity provides deterministic identity for a serialized Recon result.

interface OutputIdentity {
  output_hash: string;
  serialization: string;
}

The canonical serialization format MUST be documented.

The hash MUST be calculated after deterministic ordering/canonicalization.

---

9. Derivation

A "Derivation" records how an output was produced from one or more inputs.

interface Derivation {
  id: string;

  run_id: string;

  operation: string;
  operation_version: string;

  inputs: TraceReference[];
  outputs: TraceReference[];

  provenance: string[];

  status: DerivationStatus;

  metadata?: Record<string, unknown>;
}

Where:

type DerivationStatus =
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED';

And:

interface TraceReference {
  entity_type: string;
  entity_id: string;
}

---

10. Derivation Example

Example:

Vault.sol:42
     ↓
AST node 817
     ↓
IR storage-access-119
     ↓
StorageAccessExtractor
     ↓
Derivation-123
     ↓
FACT-021
     ↓
REL-087

The derivation MUST retain enough information to identify:

- operation,
- operation version,
- input,
- output,
- run,
- provenance.

---

11. Trace Status

Every material traceable output MUST have an explicit trace status.

type TraceStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'MISSING'
  | 'NOT_APPLICABLE';

Meaning:

COMPLETE

All required lineage for that object exists.

PARTIAL

Some lineage exists, but one or more expected components are unavailable.

MISSING

Required lineage is absent.

NOT_APPLICABLE

The lineage component genuinely does not apply.

"NOT_APPLICABLE" MUST NOT be used merely to hide missing data.

---

12. Trace Requirements by Object

Fact

A Fact MUST have:

Fact
 ├── provenance
 ├── run identity
 └── derivation when derived by the deterministic pipeline

---

Relationship

A Relationship MUST have sufficient provenance and/or derivation to explain its creation.

Example:

Function A
   └── CALLS
       └── Function B

The system must be able to answer why this relationship exists.

---

Contract / Function / StateVariable

Source-derived entities MUST retain provenance to the source/IR from which they were extracted.

---

Observation / Assumption / Hypothesis

These are present in ReconState v1 but are not actively generated by Phase 2 deterministic extraction.

If they are populated by another subsystem, their traceability MUST NOT be fabricated by Phase 2.

---

13. Trace Graph

Traceability is represented conceptually as a directed graph.

SOURCE
  ↓
EVIDENCE
  ↓
AST / IR
  ↓
DERIVATION
  ↓
FACT
  ↓
RELATIONSHIP
  ↓
OBSERVATION
  ↓
ASSUMPTION
  ↓
HYPOTHESIS

Phase 2.5-A only guarantees the deterministic portion:

SOURCE
  ↓
AST / IR
  ↓
DERIVATION
  ↓
FACT / RELATIONSHIP

The remainder is future extensibility.

---

14. Backward Traversal

The system MUST support:

traceBackward(entityId, options)

Example:

REL-087
 ↓
DERIVATION-123
 ↓
IR-STORAGE-119
 ↓
AST-817
 ↓
Vault.sol:42
 ↓
SourceIdentity
 ↓
ReconRun

Primary use cases:

- debugging,
- audit,
- explaining an output,
- identifying faulty extraction,
- evaluation failure diagnosis.

---

15. Forward Traversal

The system MUST support:

traceForward(entityId, options)

Example:

Vault.sol:42
 ↓
FACT-021
 ↓
REL-087

Future phases may extend this to:

Observation
 ↓
Assumption
 ↓
Hypothesis

Primary use cases:

- impact analysis,
- source-change analysis,
- future reasoning traceability.

---

16. Required Traceability Queries

The implementation MUST support these conceptual queries.

Q1 — Why does this output exist?

traceBackward(outputId)

---

Q2 — Where did this fact originate?

getProvenance(factId)

---

Q3 — Which run produced this object?

getRun(objectId)

---

Q4 — Which outputs depend on this source location?

traceForward(sourceReference)

---

Q5 — Which outputs were generated by an extractor version?

findByDerivation(operation, operationVersion)

---

Q6 — Which outputs differ between two runs?

compareRuns(runA, runB)

This comparison MUST operate on canonicalized output.

---

Q7 — Which outputs have incomplete lineage?

findIncompleteTraces()

---

Q8 — Which objects are orphaned?

findOrphanedTraceReferences()

---

Q9 — Which runs analyzed the same source?

findRunsBySourceIdentity(sourceHash)

---

Q10 — Show complete lineage.

trace(entityId, {
  direction: 'both',
  depth: N
})

---

17. Traceability Invariants

These invariants MUST be enforced.

T1 — Valid references

Every trace reference MUST resolve to a valid object.

---

T2 — No orphan material output

A material output MUST NOT be silently stored without required trace information.

---

T3 — Run ownership

Every derivation MUST belong to exactly one Recon Run.

---

T4 — Output ownership

Every deterministic derived output MUST be attributable to the run that generated it.

---

T5 — Immutable historical provenance

Historical provenance MUST NOT be silently overwritten.

---

T6 — Versioned derivation

Changes to derivation logic MUST be distinguishable through "operation_version" and/or analyzer version.

---

T7 — No false resolution

Traceability MUST NOT convert:

UNKNOWN

into:

RESOLVED

without new evidence.

---

T8 — Explicit incomplete state

Missing lineage MUST result in:

PARTIAL

or:

MISSING

rather than silently passing validation.

---

T9 — Deterministic serialization

The same logical trace MUST serialize identically under identical declared inputs.

---

T10 — Cross-run isolation

A trace from Run A MUST NOT resolve to Run B's derivation merely because the entity IDs happen to match.

---

18. Stable Identity

Existing stable IDs remain authoritative.

Traceability MUST NOT introduce random IDs.

Recommended derivation identity:

derivation:<run-id>:<operation>:<canonical-input-digest>

If this identity scheme is implemented, the canonicalization MUST be specified and tested.

Do not use timestamps or random values.

Issue intake identity: `ReconIssue` records receive stable deterministic IDs (`issue:` prefix, `src/ids/ids.ts`) at the semantic intake boundary (`buildEvidenceIndex`, `src/semantic/evidence.ts`), derived from `{severity, code, normalized file?, line_start?, line_end?}` only — never `message`/`count`, never random or wall-clock values. This satisfies the stable-ID and no-random-ID rules above; ESM cites these IDs as evidence basis without minting substitute provenance.

---

19. Persistence

Traceability MUST survive:

saveState()
   ↓
database
   ↓
loadState()

A save/load round trip MUST preserve:

- run identity,
- source identity,
- compiler identity,
- configuration identity,
- derivation,
- provenance,
- trace status,
- relationships between trace objects.

---

20. Determinism

Two identical runs with identical declared inputs MUST produce:

same source identity
same compiler identity
same configuration identity
same canonical ReconState
same output identity
same derivation identity

Execution timestamps may differ, but MUST NOT affect canonical identities.

---

21. Security Requirements

Traceability data is derived from untrusted repositories and source inputs.

The implementation MUST preserve Phase 2 security guarantees.

Traceability MUST NOT:

- execute repository code,
- execute arbitrary configuration,
- follow unsafe filesystem paths,
- trust repository-provided identifiers as canonical IDs,
- allow source paths to escape the configured root,
- introduce network access.

---

22. Error Semantics

The following must remain distinct:

UNKNOWN
UNSUPPORTED
NOT_FOUND
INCOMPLETE_TRACE
FAILED

Examples:

UNKNOWN
→ semantic target cannot be resolved

UNSUPPORTED
→ construct is outside supported analyzer capability

NOT_FOUND
→ requested entity/reference does not exist

INCOMPLETE_TRACE
→ entity exists but required lineage is unavailable

FAILED
→ derivation operation failed

These states MUST NOT be collapsed.

---

23. No LLM Dependency

Phase 2.5-A MUST work without an LLM.

Traceability belongs to the deterministic infrastructure.

The architecture must remain:

OpenCode
    ↓
Recon Engine
    ↓
Deterministic Analysis
    ↓
Traceability
    ↓
ReconState

LLM/reasoning agents will consume traceability later.

They MUST NOT be required to create basic deterministic provenance.

---

24. Evaluation Readiness

Phase 2.5-A is not the Evaluation Engine.

However, it MUST expose enough information for the next phase to answer:

Why did the analyzer produce this result?
Which source produced it?
Which extractor produced it?
Which run produced it?
Which version produced it?

This allows Phase 2.5-B to distinguish:

Expected ≠ Actual

from:

Expected ≠ Actual
because extractor X changed behavior

That distinction is essential for meaningful regression evaluation.

---

25. Future Extension Points

The model MUST permit future lineage:

FACT
 ↓
OBSERVATION
 ↓
ASSUMPTION
 ↓
HYPOTHESIS
 ↓
ARGUMENT
 ↓
TEST
 ↓
OUTCOME
 ↓
LEARNING

Phase 2.5-A MUST NOT implement these future systems unless required to preserve schema compatibility.

---

26. Definition of Done

Phase 2.5-A is complete only when all are satisfied:

Model

- [ ] ReconRun exists
- [ ] SourceIdentity exists
- [ ] CompilerIdentity exists
- [ ] ConfigurationIdentity exists
- [ ] OutputIdentity exists
- [ ] Derivation exists
- [ ] TraceStatus exists

Integration

- [ ] deterministic extraction produces traceable outputs
- [ ] existing provenance remains compatible
- [ ] run ownership is enforced
- [ ] derivation ownership is enforced

Traversal

- [ ] backward traversal works
- [ ] forward traversal works
- [ ] source → output traversal works
- [ ] output → source traversal works
- [ ] output → run traversal works
- [ ] run → output traversal works

Integrity

- [ ] orphan detection works
- [ ] incomplete trace detection works
- [ ] invalid references are rejected
- [ ] cross-run contamination is rejected
- [ ] historical provenance is preserved

Determinism

- [ ] canonical identities are deterministic
- [ ] derivation IDs are deterministic
- [ ] output identity is deterministic
- [ ] save/load is deterministic

Testing

- [ ] unit tests
- [ ] invariant tests
- [ ] persistence round-trip tests
- [ ] deterministic serialization tests
- [ ] corrupted lineage tests
- [ ] cross-run isolation tests
- [ ] regression tests

Documentation

- [ ] architecture documented
- [ ] identity formulas documented
- [ ] trace status semantics documented
- [ ] required queries documented
- [ ] security boundaries documented

---

27. Explicit Non-Goals

This phase MUST NOT implement:

- vulnerability detection,
- exploit generation,
- PoC generation,
- severity scoring,
- LLM reasoning,
- autonomous agents,
- RAG,
- vector database,
- learning/self-modification,
- investigation execution,
- attack simulation,
- evaluation dataset generation.

Those belong to later phases.

---

28. Architectural Principle

The final principle for Phase 2.5-A is:

«No material Recon claim should become an untraceable black box.»

The system must be able to explain:

WHAT
  ↓
WHERE
  ↓
FROM WHAT
  ↓
DERIVED HOW
  ↓
BY WHICH VERSION
  ↓
IN WHICH RUN

before we ask an AI system to reason over the result.

