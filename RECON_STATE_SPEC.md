# RECON_STATE_SPEC.md

## 1. Purpose

`ReconState` is the canonical structured representation of a smart-contract protocol during the RECON phase.

It is the shared knowledge model used by:

* deterministic analyzers
* collectors
* recon agents
* orchestrators
* context builders
* artifact generators

`ReconState` is NOT a vulnerability database.

The RECON system must distinguish:

```text
FACT
  ↓
OBSERVATION
  ↓
ASSUMPTION
  ↓
PRELIMINARY HYPOTHESIS
```

A hypothesis is not a vulnerability finding.

---

# 2. Core Design Principles

## 2.1 Schema-first

All persistent recon data must conform to a versioned schema.

No agent may introduce arbitrary persistent fields outside the schema.

---

## 2.2 Stable identifiers

Every entity and intelligence object must have a stable ID.

Recommended format:

```text
project:<name>

contract:<name>
function:<contract>.<name>
state:<contract>.<name>

asset:<name>
role:<name>
dependency:<name>

fact:<id>
obs:<id>
asm:<id>
hyp:<id>
rel:<id>
evidence:<id>
```

IDs must be deterministic where possible.

Do not use random IDs when an object can be deterministically identified from its canonical identity.

---

# 3. Entity Types

## 3.1 Project

Represents the protocol being investigated.

Fields:

```text
id
name
description
chains[]
repository
commit
version
scope
created_at
updated_at
```

---

## 3.2 Contract

Represents a deployed or source-level contract.

Fields:

```text
id
name
address
chain_id
contract_type
source_file
source_verified
compiler_version
is_proxy
implementation_id
deployment_status
```

Allowed `contract_type` values:

```text
core
token
vault
lending
staking
amm
router
oracle
bridge
proxy
implementation
adapter
library
interface
governance
periphery
unknown
```

---

## 3.3 Function

Represents a Solidity function or externally callable function.

Fields:

```text
id
contract_id
name
signature
selector
visibility
mutability
parameters[]
returns[]
modifiers[]
source
```

Allowed visibility:

```text
public
external
internal
private
unknown
```

Allowed mutability:

```text
pure
view
nonpayable
payable
unknown
```

---

## 3.4 StateVariable

Fields:

```text
id
contract_id
name
type
visibility
slot
source
```

The storage slot may be unknown.

Never fabricate storage information.

---

## 3.5 Asset

Represents economically meaningful assets.

Fields:

```text
id
name
address
chain_id
asset_type
decimals
custody
underlying_asset_id
```

Allowed `asset_type`:

```text
native
erc20
erc721
erc1155
share
debt
collateral
reward
lp
receipt
unknown
```

The system must distinguish protocol assets from merely technical values whenever possible.

---

## 3.6 Role

Represents privileged or security-sensitive authority.

Fields:

```text
id
name
role_type
holder
source
```

Examples:

```text
owner
admin
default_admin
guardian
pauser
keeper
relayer
upgrader
governance
multisig
timelock
```

---

## 3.7 Dependency

Represents an external system or component trusted by the protocol.

Fields:

```text
id
name
dependency_type
address
chain_id
interface
trust_level
```

Examples:

```text
oracle
erc20
dex
router
bridge
messenger
permit
external_protocol
keeper
relayer
unknown
```

---

# 4. Relationship Model

Relationships are first-class objects.

A relationship must contain:

```text
id
type
source_id
target_id
provenance[]
metadata
```

Supported relationship types:

```text
CALLS
READS
WRITES
EMITS
INHERITS
IMPLEMENTS
USES
DEPENDS_ON
DELEGATES_TO
UPGRADES
CONTROLS
PROTECTS
MINTS
BURNS
TRANSFERS
PRICES
CUSTODIES
INITIALIZES
```

The relationship list is extensible.

Never encode important relationships only as free-form text.

---

# 5. Provenance

Every factual claim must have provenance.

Minimum provenance fields:

```text
id
source_type
location
repository
commit
file
line_start
line_end
description
```

Allowed source types:

```text
source_code
bytecode
abi
deployment
documentation
configuration
git_history
audit
issue
onchain
generated
llm_inference
```

Examples:

```text
src/Vault.sol:120-135
```

or:

```text
ethereum:0x123...
```

or:

```text
commit:abc123
```

The system must never fabricate provenance.

If provenance is unavailable, explicitly mark it as unavailable.

---

# 6. Fact

A `Fact` represents directly verifiable information.

Fields:

```text
id
type
subject_id
predicate
object_id
value
provenance[]
confidence
created_at
```

Example:

```text
subject:
function:Vault.deposit

predicate:
WRITES

object:
state:Vault.totalShares
```

Facts must not contain unsupported security conclusions.

Bad:

```text
Vault.deposit is vulnerable.
```

Good:

```text
Vault.deposit writes state:Vault.totalShares.
```

---

# 7. Observation

An `Observation` is a derived statement based on one or more facts.

Fields:

```text
id
type
statement
based_on[]
provenance[]
confidence
created_at
```

Example:

```text
statement:

Share issuance depends on vault accounting state.

based_on:

fact:001
fact:002
fact:003
```

Observations must remain descriptive.

---

# 8. Assumption

An `Assumption` represents a security-relevant assumption inferred from observations.

Fields:

```text
id
type
statement
based_on[]
confidence
status
created_at
```

Allowed status:

```text
OPEN
SUPPORTED
WEAKENED
REJECTED
```

Example:

```text
The vault assumes changes in underlying token balance
are compatible with its share-accounting model.
```

An assumption is not a finding.

---

# 9. Preliminary Hypothesis

A `Hypothesis` represents a potential security-relevant consequence of violating or abusing an assumption.

Fields:

```text
id
type
statement
based_on[]
affected_entities[]
required_conditions[]
status
confidence
created_at
```

Allowed status:

```text
OPEN
SUPPORTED
WEAKENED
REJECTED
```

Example:

```text
Unexpected changes to the underlying token balance
may affect share pricing.
```

The RECON phase must not label this as a confirmed vulnerability.

---

# 10. Evidence

Evidence represents information used to support or challenge an inference.

Fields:

```text
id
evidence_type
description
supports[]
contradicts[]
provenance[]
created_at
```

Allowed evidence types:

```text
static
source
onchain
configuration
historical
documentation
generated
```

A piece of evidence may support or contradict a hypothesis.

---

# 11. Epistemic Model

The system must preserve the following distinction:

```text
FACT
    = directly verifiable

OBSERVATION
    = derived from facts

ASSUMPTION
    = inferred security assumption

HYPOTHESIS
    = speculative security consequence
```

Agents must never silently upgrade one epistemic level into another.

For example:

```text
FACT
↓
"Vault reads token balance"

does NOT automatically mean:

HYPOTHESIS
↓
"Vault has a donation vulnerability"
```

The intermediate reasoning must be explicitly represented.

---

# 12. Confidence

Confidence is secondary to epistemic type.

Recommended values:

```text
FACT:
    VERIFIED

OBSERVATION:
    DERIVED

ASSUMPTION:
    INFERRED

HYPOTHESIS:
    SPECULATIVE
```

Optional numeric confidence:

```text
0.0 - 1.0
```

Numeric confidence must never override epistemic classification.

For example:

```text
HYPOTHESIS
confidence: 0.99
```

is still a hypothesis.

---

# 13. Evidence Graph

All derived security reasoning must be traceable.

Example:

```text
Source
  ↓
Fact
  ↓
Observation
  ↓
Assumption
  ↓
Hypothesis
```

Example:

```text
src/Vault.sol:120
       ↓
FACT-021
       ↓
OBS-007
       ↓
ASM-003
       ↓
HYP-001
```

The system must be able to traverse this chain in both directions.

---

# 14. ReconState

Canonical top-level structure:

```text
ReconState
│
├── project
│
├── contracts[]
├── functions[]
├── state_variables[]
│
├── assets[]
├── roles[]
├── dependencies[]
│
├── relationships[]
│
├── facts[]
├── observations[]
├── assumptions[]
├── hypotheses[]
├── evidence[]
│
└── provenance[]
```

---

# 15. Immutability Rules

Raw facts should be append-only whenever possible.

If a fact changes because the source version changes:

Do NOT silently overwrite the previous fact.

Instead:

```text
fact:v1
fact:v2
```

with corresponding provenance.

Recon must be reproducible against a specific:

```text
repository commit
chain
deployment
block
compiler version
```

when available.

---

# 16. Agent Write Permissions

Agents must have restricted write scopes.

### Surface Agent

May create:

```text
contracts
functions
state_variables
facts
relationships
```

### Architecture Agent

May create:

```text
relationships
observations
facts
```

### Asset Agent

May create:

```text
assets
relationships
facts
observations
```

### Privilege Agent

May create:

```text
roles
relationships
facts
observations
```

### Dependency Agent

May create:

```text
dependencies
relationships
facts
observations
```

### Security Recon Agent

May create:

```text
observations
assumptions
hypotheses
```

It should not modify raw source-derived facts.

---

# 17. LLM Rules

LLMs are reasoning components, not the source of truth.

LLMs must:

1. cite supporting IDs
2. preserve provenance
3. distinguish facts from inference
4. never invent source locations
5. never invent contract relationships
6. never convert hypotheses into findings
7. explicitly state missing information
8. avoid duplicate entities
9. reuse existing stable IDs
10. produce structured output

---

# 18. Context Retrieval

LLMs should not receive the entire repository by default.

A Context Builder should retrieve:

```text
target entity
+
related entities
+
relevant relationships
+
supporting facts
+
observations
+
assumptions
+
source snippets
```

Example:

```text
Target:
hyp:001

Retrieve:

hyp:001
↓
asm:001
↓
obs:001
↓
fact:001
fact:002
↓
source snippets
```

The context builder should support bounded traversal.

Example:

```text
depth = 2
depth = 3
depth = 5
```

---

# 19. No Vulnerability Findings in ReconState v1

The following concepts are intentionally outside the initial RECON model:

```text
confirmed vulnerability
severity
CVSS
exploit PoC
profit calculation
exploit transaction
attack execution
```

These belong to later phases.

RECON only establishes:

```text
what exists
how it is connected
what it controls
what it depends on
what assets/state exist
what assumptions exist
what preliminary hypotheses deserve investigation
```

---

# 20. Required Invariants

The implementation must enforce:

### Invariant 1

Every relationship references valid entities.

### Invariant 2

Every fact has provenance.

### Invariant 3

Every observation references at least one fact or explicitly states why no fact exists.

### Invariant 4

Every assumption references one or more observations.

### Invariant 5

Every hypothesis references one or more assumptions or observations.

### Invariant 6

No hypothesis may be persisted as a confirmed vulnerability.

### Invariant 7

Agents cannot silently modify provenance.

### Invariant 8

Duplicate canonical entities must be detected.

### Invariant 9

Unknown information must remain `unknown`, not guessed.

### Invariant 10

Every LLM-generated inference must be traceable to structured context.

---

# 21. Versioning

Schema must be versioned.

Initial version:

```text
recon-state/v1
```

Future breaking changes require:

```text
v2
v3
...
```

Migration logic must be explicit.

---

# 22. Design Goal

The system should allow this workflow:

```text
Source Code
     ↓
Deterministic Analysis
     ↓
Facts
     ↓
ReconState
     ↓
Specialized Recon Agents
     ↓
Observations
     ↓
Assumptions
     ↓
Preliminary Hypotheses
     ↓
Recon Artifacts
```

The same `ReconState` must remain usable regardless of which LLM provider or model is used.

The architecture must optimize for:

```text
traceability
consistency
reproducibility
extensibility
LLM context efficiency
security-research usability
```

---

# 23. Non-Goals

Version 1 must NOT attempt to:

* automatically prove vulnerabilities
* automatically exploit contracts
* execute attacks
* calculate exploit profit
* replace human security judgment
* treat documentation as authoritative over source/on-chain evidence
* rely exclusively on LLM reasoning
* use vector search as the primary source of truth

---

# 24. Definition of Done for ReconState Foundation

The foundation is complete when:

1. all core entities have validated schemas
2. all relationships have validated schemas
3. provenance is mandatory for facts
4. stable IDs work
5. duplicate entities can be detected
6. facts/observations/assumptions/hypotheses are separated
7. relationships can be queried
8. evidence chains can be traversed
9. ReconState can be persisted and loaded
10. schema versioning works
11. invalid agent output is rejected
12. unit tests cover all core invariants

No autonomous LLM agent should be implemented until these requirements pass.