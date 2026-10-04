# ReconState Foundation (v1)

Implementation of `RECON_STATE_SPEC.md` (schema-first reconnaissance state).
This document records what was built, the decisions taken where the spec left room,
and the known limitations. Read it next to the spec — the spec is the intent,
this file is the contract of the code.

## Scope

In scope: entity schemas, stable IDs, provenance, relationships, the epistemic
model (Fact / Observation / Assumption / Hypothesis), Evidence, the `ReconState`
aggregate, SQLite persistence with migrations, a repository API, bounded
reasoning traversal, deterministic serialization, tests, this document.

Out of scope (spec §23): LLM agents, vulnerability detection, exploit
generation, crawling, static analysis, vector search.

## Layout

```
src/
  ids/            stable + content addressing (sha256, 16-hex)
  domain/         contract, function, state variable, asset, role, dependency, project
  epistemic/      provenance, confidence, fact, observation, assumption, hypothesis, evidence
  relationships/  relationship type, factory, in-memory graph index
  recon-state/    schema, validate, serialize
  repository/     interface, mappers, sqlite implementation, migrations runner
  errors/         ReconError + error codes
  util/           stableStringify canonical JSON
migrations/       001_initial.sql (applied in filename order, checksummed)
fixtures/         vault.ts shared example payload
tests/            one file per cycle + agent-output gate
```

## Identity

- Address-bound ids: `contract|asset|dependency:<chain>:<address>` (both lowercased).
- Source-bound ids: `:<name>`; `project:<name>`;
  `function:<contract-id>:<signature>`, `state:<contract-id>:<name>`,
  `role:<contract-id>:<name>`.
- Epistemic/relationship/evidence ids are content-addressed:
  `contentId(prefix, payload)` = sha256 of canonical JSON (excluding `id`,
  `created_at`; set-like arrays sorted) truncated to 16 hex chars.
  Rebuilding an entity from its content always reproduces its id; changing
  content without changing the id is rejected on load
  (`InvalidReconState`, spec §15 Immutability Rules).
- Same id + different content in one state or store → `DuplicateCanonicalEntity`.

## Provenance

Every fact, observation, relationship, evidence (and optionally other entities)
carries ≥1 provenance record (spec §5). Source types are a closed enum of 12.
Per-type requirements are enforced by `createProvenance`:

| source_type | required |
|---|---|
| `source_code` | `file` or `location`; `line_end ≥ line_start` |
| `onchain` | `chain_id` + (`address` or `location`) |
| `deployment` | `chain_id` + `address` |
| `git_history` | `commit` |
| `unavailable: true` | `description`; skips type requirements |

`unavailable: true` is the explicit "we could not see the source" marker —
unknown information stays unknown instead of being guessed (spec §20, Invariant 9).

The top-level `provenance[]` of a `ReconState` is a derived registry: the union
of all embedded provenance records, deduplicated and sorted. It may be omitted
on input (it is derived); if provided, it must exactly match the derived id set.

## Epistemic model

| Entity | Must reference | Confidence |
|---|---|---|
| Fact | ≥1 provenance; at least one of `object_id` / `value` | forced `VERIFIED` |
| Observation | ≥1 fact in `based_on` OR ≥1 provenance | forced `DERIVED` |
| Assumption | ≥1 observation in `based_on` | forced `INFERRED` |
| Hypothesis | ≥1 assumption/observation in `based_on` | forced `SPECULATIVE` |
| Evidence | ≥1 provenance; ≥1 `supports`/`contradicts`; no overlap; epistemic targets only | n/a |

- Hypothesis status enum: `OPEN | SUPPORTED | WEAKENED | REJECTED` —
  `CONFIRMED` does not exist (spec §19, Invariant 6).
- Forced confidence means a wrong level for the record type is rejected
  (`InvalidConfidence`); a `VERIFIED` fact cannot upgrade a hypothesis to certainty.
- These rules are enforced in **two places**:
  1. the factories (`src/epistemic/*`) — the intended write path;
  2. `validateReconState` — the raw-JSON path (`createReconState`,
     `deserializeReconState`), so untrusted agent output or a tampered state
     file cannot bypass the factories. See `tests/agent-output.test.ts`.

## Relationships

18 relationship types (spec §4) validated in factories and again in
`validateReconState`. Endpoints must be entity references and must exist in the
state (referential integrity). `src/relationships/graph.ts` provides an
in-memory `GraphIndex` (`getRelationshipsFrom/To`, `findRelationshipsByType`,
`getRelatedEntities(id, depth)` — undirected BFS, cycle-safe, sorted).

Note: `EMITS` is a valid relationship type but cannot be used meaningfully
until `Event` entities exist — no entity id can serve as its target today.

## ReconState validation order

`createReconState(raw)` runs:

1. strict structural parse (unknown keys rejected → `SchemaValidationFailed`)
2. schema version check → `UnsupportedSchemaVersion`
3. provenance registry match (if provided) → `InvalidReconState`
4. entity identity recompute + duplicate detection → `InvalidReconState` / `DuplicateCanonicalEntity`
5. confidence levels → `InvalidConfidence`
6. epistemic rules (provenance/basis non-empty) → `MissingProvenance` / `InvalidEpistemicDependency` / `InvalidEvidenceReference`
7. content-id recompute (incl. relationship type check → `UnsupportedRelationshipType`)
8. referential integrity → `InvalidReconState` with `issues[]`

Serialization: canonical key order (`schema_version` first), arrays sorted by
id, 2-space indent. Round-trips are byte-stable; creation timestamps are
preserved.

## Persistence

- `migrations/001_initial.sql` applied through `runMigrations` into
  `schema_migrations` with a SHA-256 checksum; a changed file on an existing
  database fails with `MigrationError`.
- `SqliteReconRepository` implements `ReconRepository` **synchronously**
  (better-sqlite3 is synchronous; tests assert thrown `ReconError`s directly).
- Writes are idempotent: creating an existing id with identical content returns
  the stored row, differing content throws `DuplicateCanonicalEntity`.
- `saveState` runs inside one transaction; insert order respects foreign keys
  (project → contracts → functions → state variables → assets → roles →
  dependencies → relationships → facts → observations → assumptions →
  hypotheses → evidence → meta).
- `loadState()` returns `null` iff nothing was ever saved (tracked by
  `state_saved_at` in `meta`); an empty-but-saved state loads as an empty state.
- Embedded arrays use `PRIMARY KEY (owner_id, position)` join tables read back
  in `position` order, so `serialize(load(save(s))) === serialize(s)`.
- One project per store is enforced.
- SQLite reserved word: the project `commit` field is stored in a `commit_sha`
  column (mappers translate; API field names are unchanged).

## Reasoning traversal (spec §13, §18, DoD item 8)

`ReconRepository` exposes three bounded traversals over the stored basis graph
(SQLite recursive CTEs, default depth 5, depth clamped at ≥ 0):

- `getUpstreamReasoning(id, maxDepth?)` — `hypothesis → assumption/observation
  → fact` following `based_on`. Returns `[root, ...ancestors]` ordered by
  distance then id. Depth 0 returns only the root.
- `getDownstreamReasoning(id, maxDepth?)` — reverse edges: who bases on this
  node (fact → observation → assumption → hypothesis).
- `getEvidenceChain(id, maxDepth?)` — the upstream chain, then the ids of all
  Evidence records that support or contradict any node reached, sorted.

Basis edges strictly decrease epistemic rank (hypothesis → assumption →
observation → fact), so the graph is a DAG by construction; `UNION` + `GROUP BY
MIN(hop)` keeps traversals deduplicated and cycle-safe regardless. Non-epistemic
roots (e.g. a contract id) simply return `[root]`.

## Error codes

`SchemaValidationFailed`, `InvalidIdentifier`, `InvalidRelationshipSource`,
`InvalidRelationshipTarget`, `UnsupportedRelationshipType`, `MissingProvenance`,
`InvalidProvenance`, `InvalidEpistemicDependency`, `DuplicateCanonicalEntity`,
`UnsupportedSchemaVersion`, `InvalidSourceReference`, `InvalidEvidenceReference`,
`ConflictingEvidence`, `InvalidConfidence`, `EntityNotFound`, `InvalidReconState`,
`MigrationError`. All thrown as `ReconError` (`[code] message`, `details` bag).

## Decisions where the spec left room

| Question | Decision |
|---|---|
| ID format (spec examples vs task examples) | address-bound `prefix:chain:address` (lowercased); content ids for epistemic records |
| Function `source` field (spec §3.3) | optional free-text location string |
| role/dependency/contract_type values | closed enums (spec lists allowed `contract_type` values) |
| Provenance on relationships/evidence | mandatory (≥1) |
| Agent write scopes (spec §16) | **not enforced in v1** — see Limitations |
| `content_id` column name | content ids are the row primary key `id`; no separate column |
| Unknown top-level/entity keys | rejected (strict schemas), not silently stripped |
| `provenance` registry input | optional; derived; validated for exact match when given |

## Limitations

- **No agent write-scope enforcement (spec §16).** The per-agent
  create-permissions (Surface/Architecture/Asset/Privilege/Dependency/Security
  agents) are not implemented; any caller may write any entity. Must exist
  before autonomous agents share one store.
- **No Event entity**, so `EMITS` has no usable target yet.
- **Entity-internal references** (`function.contract_id`, `hypothesis.affected_entities`
  as foreign keys into specific collections) are checked for id *pattern* and
  for cross-collection existence where implemented; `affected_entities` is
  checked against all entity ids, not against specific collections.
- **Single project per database** — multi-project stores are rejected.
- **No orchestrator/CLI** — the foundation is a library; graph persistence is
  full-state (`saveState`) rather than incremental patches.

## Definition of Done (spec §24) → evidence

| # | Requirement | Evidence |
|---|---|---|
| 1 | core entities have validated schemas | `src/domain/*`, `tests/entities.test.ts` (30) |
| 2 | relationships have validated schemas | `src/relationships/*`, `tests/relationships.test.ts` (15) |
| 3 | provenance mandatory for facts | `createFact` + `assertEpistemicRules`; `tests/epistemic.test.ts`, `tests/agent-output.test.ts` |
| 4 | stable IDs work | `src/ids/*`, `tests/ids.test.ts` (26) |
| 5 | duplicate entities detected | `DuplicateCanonicalEntity` in validate + repository; `tests/recon-state.test.ts`, `tests/persistence.test.ts` |
| 6 | facts/observations/assumptions/hypotheses separated | distinct schemas + type literals; `tests/epistemic.test.ts` (41) |
| 7 | relationships can be queried | repo `getRelationshipsFrom/To/findRelationshipsByType` + `buildGraphIndex`; `tests/persistence.test.ts`, `tests/relationships.test.ts` |
| 8 | evidence chains can be traversed | `getUpstreamReasoning/getDownstreamReasoning/getEvidenceChain`; `tests/traversal.test.ts` (6) |
| 9 | ReconState can be persisted and loaded | `saveState/loadState` + migrations; `tests/persistence.test.ts` (16) |
| 10 | schema versioning works | `SUPPORTED_SCHEMA_VERSIONS`; `tests/recon-state.test.ts`, `tests/agent-output.test.ts` |
| 11 | invalid agent output is rejected | `tests/agent-output.test.ts` (12 raw-payload cases) |
| 12 | unit tests cover all core invariants | §20 mapping: I1 integrity (`recon-state`), I2 provenance (`epistemic`, `agent-output`), I3/I4/I5 basis rules (`epistemic`, `agent-output`), I6 no CONFIRMED (`epistemic`), I7 immutability/tamper (`recon-state`), I8 duplicates (`recon-state`, `persistence`), I9 unavailable provenance (`epistemic`), I10 traceable inference (basis-chain rules, `traversal`) |

Invariants 7 and 10 (provenance tamper-proof, inference traceable) are enforced
structurally: content ids re-verified on every load, and every epistemic record
must carry its basis/provenance chain.

## Running

```
npm test           # vitest, 169 tests across 8 files
npm run typecheck  # tsc --noEmit (strict, NodeNext)
```

Node ≥ 20 (developed on Node 24). SQLite via `better-sqlite3` (no server).
