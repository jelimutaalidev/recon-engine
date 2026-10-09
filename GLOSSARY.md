# Recon Engine

Deterministic static modeling of Solidity systems as auditable evidence, so LLM reasoning later (observations → assumptions → hypotheses) stands on verified facts instead of convincing fabrications.

## Language

### Epistemics

**Influence-capable**:
A static capability relation between program points under stated evidence; a declared branch-insensitive over-approximation.
_Avoid_: dataflow, taint, causation, runtime effect

**Structural dependency**:
Co-access, co-location, or graph adjacency with no satisfied edge rule; never an influence claim.
_Avoid_: influence of any kind

**Runtime causal influence**:
What actually happened at runtime; unrepresentable in our models by construction.
_Avoid_: anything an ESM record claims

**ESM UNKNOWN**:
A first-class record of scoped ignorance with examined basis; counted, sorted, and hashed like any record.
_Avoid_: absence, false, inferred fact

### Model records

**Condition**:
A compiler-evidenced necessary constraint on the execution of an effect set.
_Avoid_: branch predicate, gate meaning or purpose

**Path**:
An ordered structural route with per-step conditions; never executable, feasible, minimal, or complete.
_Avoid_: exploit path, reachability claim

**Execution context**:
The static positional frame of an execution point; runtime fields are mandatory UNKNOWN.
_Avoid_: actor identity, origin, role or owner claims

**Composition**:
The traversal/closure algebra (operators, bound, cycle rule) producing composed summaries; never a finding.
_Avoid_: verdict, transitive-closure claim

### Evidence plumbing

**Basis**:
The examined intake ids a record cites; every basis entry must resolve to real intake.
_Avoid_: synthesized references, message-text descriptors

**ReconState**:
The deterministic, content-addressed snapshot of extracted facts that every downstream model consumes read-only.
_Avoid_: analysis verdict, mutable working state
