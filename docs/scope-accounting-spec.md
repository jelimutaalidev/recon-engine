# Scope Accounting Specification (Phase 3)

**Status:** APPROVED (2026-10-06) — OD-1…OD-10 resolved (OD-3 and OD-4 as
revised, OD-9 with the `coverage → clean_coverage` rename; see §15). Spec frozen
pending implementation approval.

**Context:** GitHub issue #1 `[P0] Scope accounting: ANALYZED / EXCLUDED / NOT_FOUND /
UNRESOLVED / UNSUPPORTED / FAILED report`.

**Related documents:** `docs/TRACEABILITY_SPEC.md` §4.1, §21, §22, §27;
`docs/traceability.md` (error semantics mapping); `docs/recon-layer-design.md` §5.7;
`docs/recon-layer-design.md` anti-overclaim rules.

**Constraints:** Phase 2.5-A foundation is frozen. No Evidence Graph, no deployment
identity (#2), no temporal/versioning (#3) work in this phase.

---

## 1. Purpose and critical question

Answer, per run: **what was supposed to be analyzed, what was actually analyzed, and
what prevented analysis?** — as a first-class, deterministic, evidence-backed report.

Every accountable scope target receives exactly one status:

```
ANALYZED | EXCLUDED | NOT_FOUND | UNRESOLVED | UNSUPPORTED | FAILED
```

The report is the basis for the processing/accounting metrics (§10).
**Absence of evidence is never evidence of absence** (§5.3, INV-4).

## 2. Vocabulary alignment

- TRACEABILITY_SPEC §22 mandates five distinct classes — `UNKNOWN`, `UNSUPPORTED`,
  `NOT_FOUND`, `INCOMPLETE_TRACE`, `FAILED` — with "These states MUST NOT be
  collapsed." Scope statuses **coexist with, and never replace**, those classes:
  §22 classes live at issue/service/run layers; scope statuses live at the
  **target layer**.
- `UNKNOWN` remains an **issue severity** (`src/recon/issues.ts:4`); scope never
  emits an `UNKNOWN` status.
- "Scope accounting" (this document) is unrelated to TRACEABILITY_SPEC §27
  "scope exclusions" (no-eval / no-LLM / no-network boundary). All docs must
  disambiguate.
- All evidence signals already exist in the pipeline; scope accounting invents no
  new analysis signals:
  - discovery walk and exclusion rules (`src/recon/discover.ts:15,70-77,76,117-151`);
  - issue severities (`UNKNOWN` flushed at `extract/calls.ts:161`,
    `extract/event-error-facts.ts:68`, `extract/storage-access.ts:88`,
    `extract/inheritance.ts:18`; `UNSUPPORTED` at `ir/build.ts:1038`);
  - fidelity fallback and drops (`backend/solc/compile.ts:478-527`,
    `syntactic_fallback`, `compilation_failed`, `dropped[]`,
    `CompilationFailed` details `{issues, dropped}`);
  - `AnalysisResult.meta` (`src/recon/index.ts:11-20`).

## 3. Domain model

```ts
type ScopeStatus = 'ANALYZED' | 'EXCLUDED' | 'NOT_FOUND'
                 | 'UNRESOLVED' | 'UNSUPPORTED' | 'FAILED';
type TargetType  = 'source_file';        // extensible union (OD-2)
type Stage       = 'discover' | 'compile' | 'analysis'
                 | 'ir' | 'extract' | 'build';
// v1 mapErrorToStage (class-based, INV-7) emits only:
// discover | compile | analysis — ir/extract/build are retained as pipeline
// vocabulary; a code→ir/extract/build discrimination would claim precision the
// class-based mapper does not have.

interface EmbeddedIssue {
  code: string;
  severity: 'FATAL' | 'RECOVERABLE' | 'UNKNOWN' | 'UNSUPPORTED';
  message: string;
  file: string;                   // attribution key: must equal the entry's path (INV-13)
  line_start?: number;
  line_end?: number;
  count: number;
}

type ScopeEvidence =
  | { kind: 'analysis';   sha256: string }                       // ANALYZED
  | { kind: 'exclude_rule'; rule: string }                       // EXCLUDED (config/always)
  | { kind: 'size_limit'; limit_bytes: number }                  // EXCLUDED (limit:maxFileBytes)
  | { kind: 'walk_miss';  include: string }                      // NOT_FOUND
  | { kind: 'issue';      issue: EmbeddedIssue }                 // UNRESOLVED / UNSUPPORTED
  | { kind: 'run_error';  stage: Stage; error_class: string; message: string }; // FAILED

interface ScopeEntry {
  target_type: TargetType;
  path: string;                 // root-relative posix; absolute paths forbidden (INV-10)
  status: ScopeStatus;
  evidence: ScopeEvidence[];    // >= 1, required kind(s) per status (INV-3)
}

interface Ratio { n: number; d: number }   // integers only; no floats in the report

interface ScopeMetrics {
  clean_coverage: Ratio;                 // |ANALYZED| / |E| — gap-free processing share (§10)
  resolution_completeness: Ratio;         // |ANALYZED| / (|ANALYZED| + |UNRESOLVED|)
  unsupported_rate: Ratio;                // |UNSUPPORTED| / |E|
  failed_rate: Ratio;                     // |FAILED| / |E|
  not_found_rate: Ratio;                  // |NOT_FOUND| / |E|
  excluded_by_rule: { rule: string; count: number }[];  // sorted code-unit by rule
  fallback_count: number;                 // entries carrying a syntactic_fallback issue (fidelity disclosure, not a status input)
}                                          // ALL fields mandatory together — companion-lock (INV-14)

interface ScopeReport {
  schema_version: 'scope-report/v1';      // zod strictObject: unknown keys rejected
  run: { run_id: string; input_manifest_hash: string; output_hash: string } | null;
  run_status: 'COMPLETED' | 'FAILED';
  run_fidelity?: 'semantic' | 'syntactic'; // present iff run_status COMPLETED
  failed_stage?: Stage;                    // present iff run_status FAILED
  counts: {
    expected: number;                      // = |E|
    analyzed: number; excluded: number; not_found: number;
    unresolved: number; unsupported: number; failed: number;
  };
  entries: ScopeEntry[];                   // sorted by compareCodeUnits(path)
  metrics: ScopeMetrics;
  scope_hash: string;                      // sha256(stableStringify(report without scope_hash))
}
```

Example (four targets: `|S| = 4`, `|E| = 3`, `clean_coverage = 1/3`):

```json
{
  "schema_version": "scope-report/v1",
  "run": { "run_id": "run:...", "input_manifest_hash": "...", "output_hash": "..." },
  "run_status": "COMPLETED",
  "run_fidelity": "semantic",
  "counts": { "expected": 3, "analyzed": 1, "excluded": 1, "not_found": 1,
              "unresolved": 1, "unsupported": 0, "failed": 0 },
  "entries": [
    { "target_type": "source_file", "path": "contracts/A.sol", "status": "ANALYZED",
      "evidence": [{ "kind": "analysis", "sha256": "ab12…" }] },
    { "target_type": "source_file", "path": "contracts/B.sol", "status": "UNRESOLVED",
      "evidence": [{ "kind": "issue", "issue": { "code": "call_target_unresolved",
        "severity": "UNKNOWN", "message": "…", "file": "contracts/B.sol", "count": 1 } }] },
    { "target_type": "source_file", "path": "contracts/C.sol", "status": "EXCLUDED",
      "evidence": [{ "kind": "exclude_rule", "rule": "config:excludes:contracts/C.sol" }] },
    { "target_type": "source_file", "path": "contracts/D.sol", "status": "NOT_FOUND",
      "evidence": [{ "kind": "walk_miss", "include": "contracts/D.sol" }] }
  ],
  "metrics": { "clean_coverage": { "n": 1, "d": 3 }, "resolution_completeness": { "n": 1, "d": 2 },
               "unsupported_rate": { "n": 0, "d": 3 }, "failed_rate": { "n": 0, "d": 3 },
               "not_found_rate": { "n": 1, "d": 3 },
               "excluded_by_rule": [{ "rule": "config:excludes:contracts/C.sol", "count": 1 }],
               "fallback_count": 0 },
  "scope_hash": "…"
}
```

## 4. Canonical scope inventory and denominator

The inventory is built by an independent, read-only walk that reuses discovery
primitives (shared glob/containment code, not a second glob implementation):

**S (accounting universe)** =
- files matching at least one `config.includes` pattern (default `**/*.sol`,
  `src/recon/config.ts:32`), enumerated **before** exclusion checks;
- **literal** (glob-magic-free) `config.includes` entries with zero filesystem
  match → `NOT_FOUND` expectations;
- always-excluded directories encountered during traversal (`.git`,
  `node_modules`, `.recon-cache`, `src/recon/discover.ts:15`) → **one dir-level
  exclusion marker each** (contents never enumerated; walk stays bounded);
- files under the root that match no include pattern are **outside the model and
  never accounted** (include globs define the universe; config is trusted
  operator input).

**Sets:**
- `E (expected) = S ∖ EXCLUDED`; `counts.expected = |E|`;
- `NOT_FOUND ⊆ E` (an expectation is what was supposed to exist);
- inventory in-memory records may hold absolute paths for I/O; **reports never do**.

**Exclusion rule strings (exact, stable API):**

| Rule | Trigger |
|---|---|
| `config:excludes:<pattern>` | file matches a user exclude glob (`config.ts:33`) |
| `always:<dirname>` | traversal hit an always-excluded directory |
| `limit:maxFileBytes` | matched file exceeds `limits.maxFileBytes` (`discover.ts:127-136`) |
| `type:non-file` | directory / symlink-to-dir / special entry, not a regular file |

**Rule evaluation order and formats (deterministic):**
- a matched file's exclude pattern is checked **before** the file is read
  (unread ⇒ size unknown ⇒ a file can carry at most one exclusion rule);
  `limit:maxFileBytes` applies only to files that pass pattern exclusion;
- `always:<dirname>` uses the directory **basename** (the always-set is matched
  at any depth); the entry's `path` is the full root-relative directory path,
  no trailing slash;
- literal expectations are normalized root-relative posix paths: duplicates
  collapse to one expectation; a literal include that escapes the root after
  normalization is rejected (`RootEscape`) during inventory build — absence is
  never claimed for paths outside the root.

## 5. Status semantics

### 5.1 The six statuses

| Status | Meaning (attempt outcome) | Required evidence (target-attributable, INV-13) | Never triggered by |
|---|---|---|---|
| `ANALYZED` | **Processing-outcome claim only:** target was in E, read and digested, completed every pipeline stage the run reached, at the run's recorded fidelity | `analysis` (sha256); may additionally carry `issue(syntactic_fallback)` as fidelity evidence | issue-absence, construct modeling, or semantic completeness (it asserts none of them) |
| `EXCLUDED` | Policy declined analysis before it started | `exclude_rule` or `size_limit` | repository content |
| `NOT_FOUND` | A **specific named** expectation provably does not exist | `walk_miss` from a **completed** walk | globs matching nothing; empty extraction output; a failed/partial walk |
| `UNRESOLVED` | Processed, with positive **per-target** semantic incompleteness evidence | ≥1 `issue` with `severity === 'UNKNOWN'` whose `file` equals **this entry's** `path`; may additionally carry `analysis` | `syntactic_fallback` alone; run-level / other-file UNKNOWN issues; absence of relationships/facts |
| `UNSUPPORTED` | **Structured, per-target** content attribution proves this file's bytes were refused (parse errors) and it was dropped | `issue(compilation_failed)` with `file` equal to this entry's `path`, **or** structured `dropped[]` containing this entry's `path` | human-readable message-text inference; batch causes without per-target attribution; `unsupported_*` construct findings |
| `FAILED` | Run failure prevented analysis and **no per-target content attribution exists** for this target | `run_error {stage, error_class, message}`, applicable because the target is on-disk, in E, and unattributed | content problems proved for that target (those are `UNSUPPORTED`); `EXCLUDED` / `NOT_FOUND` entries |

**Orthogonality of `run_status` and entry status (normative):** `run_status`
describes the pipeline/run outcome; `ScopeEntry.status` describes target-level
accounting. Neither may be inferred from the other. A `FAILED` run may
legitimately have `counts.failed = 0` when every expected on-disk target has
independently attributable `UNSUPPORTED` status. A `COMPLETED` run may
legitimately contain `UNSUPPORTED`, `UNRESOLVED`, or other target statuses when
those statuses are independently supported by target-level evidence and the run
itself completed. Identical entry partitions may therefore carry different
`run_status` values, and identical `run_status` values may carry different
entry partitions — both dimensions are asserted independently (T5, T7, T9, T11).

**`ANALYZED` MUST NOT imply:** semantic completeness, complete construct
modeling, absence of issues, soundness, security coverage, audit coverage, or
risk reduction. It claims exactly one thing: the pipeline processed the target
successfully at the run's recorded fidelity.

Boundary pins (OD-3, test-pinned):
- **Attribution is per-target:** every status's evidence must be attributable
  to that entry (INV-13).
- `severity UNSUPPORTED` findings (`unsupported_*`, `ir/build.ts:293-301`) are
  **findings, not target status**: the file stays `ANALYZED` with the findings
  recorded in the issues artifact (`AnalysisResult.issues`).
- `syntactic_fallback` is **fidelity evidence** (§5.3), never a status trigger by
  itself.
- Unattributable batch/compiler failure (e.g. unlocated `CompilationFailed` with
  empty `dropped[]`) ⇒ all on-disk expected entries `FAILED`, never
  `UNSUPPORTED` — a batch cause without per-file proof must not be laundered
  into per-file content blame.
- The classifier reads **structured artifacts only** — inventory, issues,
  `details.dropped`, error class — and **never parses human-readable
  error-message text** for attribution.
- Determinism: per-target-attributed content failures are machine-reproducible
  (pinned compiler, same diagnostics ⇒ same `dropped` list); environment
  failures are recorded verbatim as `run_error` (content-independent).

### 5.2 Precedence

1. Pre-analysis facts first: `EXCLUDED` and `NOT_FOUND` (disjoint from outcomes).
2. For attempted (on-disk, in-E) targets, exactly one winner, in order:
   `UNSUPPORTED > FAILED > UNRESOLVED > ANALYZED`.

Precedence operates **only over evidence already attributed to the target**
(INV-13); evidence not attributable to a target never enters its precedence
evaluation. Derivation is a **pure function** of `(inventory, issues,
meta, error-details)` — no clock, no randomness, no environment reads,
no message-text parsing (INV-6, INV-7).

### 5.3 UNKNOWN vs NOT_FOUND vs UNRESOLVED; syntactic fallback (never conflated)

- **`UNKNOWN`** — issue *severity*: a specific semantic site could not be resolved
  (§22 class; lives in `AnalysisResult.issues`). Finding layer. An UNKNOWN issue
  attributes to **exactly one** target: the entry whose `path` equals
  `issue.file`. File-less (run-level) UNKNOWN issues attribute to **no** target
  entry — they must not flip any status.
- **`UNRESOLVED`** — target *status*: ≥1 UNKNOWN-severity issue **attributable to
  that exact target** — positive, per-target evidence of incompleteness. Aggregate
  layer. Syntactic mode emits attributable UNKNOWN-severity issues
  (`calls.ts:161`, `event-error-facts.ts:68`, `storage-access.ts:88`,
  `inheritance.ts:18`).
- **`NOT_FOUND`** — target *status*: proof-of-absence certified by a completed walk
  over a literal expectation. A failed or partial walk yields `FAILED`, never
  `NOT_FOUND`.
- **Syntactic fallback (OD-4):**
  - `syntactic_fallback` is **fidelity evidence**: semantic compile failed for
    the file, so only syntax-only analysis ran. It means fidelity degradation of
    the analysis performed on the target — not that the target itself has
    unresolved semantics.
  - `syntactic_fallback` alone MUST NOT produce `UNRESOLVED`.
  - The marker is preserved on the entry (embedded issue, allowed alongside
    `ANALYZED`) plus report-level `run_fidelity` and metric `fallback_count` —
    nothing is erased (§2.6 discipline honored).
  - In practice, fallback files usually still become `UNRESOLVED`, because
    syntactic mode cannot resolve declarations (`recon-layer-design.md:111-112`)
    and extractors emit attributable UNKNOWN issues; a site-less fallback file
    becomes `ANALYZED` + fidelity evidence — correct, since no semantic site
    exists to be incomplete about.
  - A **run-level** UNKNOWN issue MUST NOT mark unrelated target entries
    `UNRESOLVED` (INV-13).
- Consequences (all test-pinned):
  - a file with zero issues/zero extracted entities after a completed run ⇒ `ANALYZED`;
  - a glob matching nothing ⇒ **no entry** (a set with no members names no target);
  - `unsupported_*` findings alone ⇒ `ANALYZED` + issues;
  - `syntactic_fallback` without attributable UNKNOWN issues ⇒ `ANALYZED` + fidelity evidence.

## 6. Accounting levels

- **Per-file:** each `ScopeEntry` — the atomic accounting unit.
- **Per-target:** the same entries, tagged `target_type` (extensible; v1 =
  `source_file` only, OD-2).
- **Per-project:** `counts` + `metrics`, recomputed from entries only (never stored
  twice — INV-1/INV-11 keep them consistent). One project per report.

## 7. Determinism and reproducibility

- The report contains **no wall-clock, no randomness, no absolute paths, no
  hostname/user/environment strings** except verbatim `run_error.message` on FAILED
  reports (environment-dependent by nature; `stage` + `error_class` are stable).
- All ordering via `compareCodeUnits` (`src/util/canonical.ts`); embedded issues
  sorted by `(code, file, line_start)`; inventory walk uses discovery's sorted order.
- `scope_hash = sha256(stableStringify(report without scope_hash))`.
- Guarantee levels:
  - **COMPLETED reports: byte-reproducible across environments** for identical root
    bytes + config (time enters only through the existing timestamp-free `run_id`);
  - **FAILED reports: stable per environment**, content-attributable parts
    (statuses, dropped attribution, stage/class) stable cross-environment.

## 8. Integration

### 8.1 Provenance and Traceability (read-only binding)

- COMPLETED report references the state's current traceability run:
  `run_id`, `input_manifest_hash`, `output_hash` (from
  `state.traceability.runs[*].output_identity`); FAILED ⇒ `run: null`.
- Cross-checks (INV-9, INV-11): every file span cited in `state.provenance` maps to
  an entry with status ∈ {`ANALYZED`, `UNRESOLVED`}; `meta.fileCount` equals the
  on-disk outcome partition (§9).
- **No extension** of traceability outputs, `entity_type` lists, `materialEntities`,
  or `assertTraceability` — scope stays outside the frozen layer.

### 8.2 Partial and failure semantics

- Success: complete S-partition, `run_status: COMPLETED`, `run` bound,
  `run_fidelity` from `meta.fidelity`.
- **Two-branch failure attachment — inventory decides** (existing foundation
  behavior preserved: "a failed analysis aborts before a state exists",
  `docs/traceability.md:423`):
  1. **Inventory completed** (S known): the wrapper catches `ReconError`, maps
     class → stage (`NoSourcesFound | SourceLimitExceeded | RootEscape →
     discover`; `CompilationFailed | CompilerUnavailable → compile`; otherwise
     `analysis`), attributes per-target: entries named in structured
     `error.details.dropped[]` (live or in `CompilationFailed` details) ⇒
     `UNSUPPORTED`; the remaining on-disk E entries ⇒ `FAILED` with
     `run_error {stage, error_class, message}`; `EXCLUDED` / `NOT_FOUND` keep
     their pre-analysis statuses (a run-level failure never broadcasts to them);
     metrics computed over the full partition; **rethrows the original error
     with `details.scope_report` attached** — loud by design (INV-12), a
     complete S-partition even under failure.
  2. **Inventory failed** (root escape, I/O failure, or limits during the scope
     walk): rethrow **without** `scope_report` — an S-partition that was never
     observed is never fabricated (absence discipline applied to the accounting
     itself). Tests pin the absence.
- **Unattributable compiler failure:** `CompilationFailed` with empty/absent
  `dropped[]` (unlocated fatal errors) ⇒ no per-target content proof ⇒ **all**
  on-disk E entries `FAILED` (`error_class: CompilationFailed`), never
  `UNSUPPORTED`.
- **Accounting under failure:** a `FAILED` report accounts for every on-disk
  expected target as `UNSUPPORTED` (content-attributed) or `FAILED`
  (unattributed). `counts.failed = 0` is therefore valid exactly when all
  on-disk expected targets are `UNSUPPORTED` (e.g. `all-dropped`) or E has no
  on-disk target (e.g. `NoSourcesFound` with only literal-miss expectations);
  `FAILED ⇒ counts.analyzed = counts.unresolved = 0` (INV-9, INV-12). Run
  failure, target failure, and content refusal stay three distinct signals
  (`run_status`, entry `FAILED`, entry `UNSUPPORTED`) — never collapsed.
  **Orthogonality (normative, §5.1):** `run_status` describes the
  pipeline/run outcome; `ScopeEntry.status` describes target-level accounting;
  neither may be inferred from the other — hence `FAILED` + `failed = 0`
  (all-on-disk attributed `UNSUPPORTED`, e.g. `all-dropped`) and `COMPLETED`
  with `UNSUPPORTED`/`UNRESOLVED` entries (target evidence-backed) are both
  legitimate, and both are test-pinned.
- Scope of loudness: catchable errors; an uncatchable process death (OOM,
  SIGKILL) cannot carry a report — documented honesty limit (§7).

### 8.3 ReconState integration (read-only)

- Dependency direction: `src/scope → {recon, recon-state, traceability, util}`;
  nothing under `src/` imports `src/scope`.
- Building/validating scope **never mutates** state, issues, or ids —
  `serializeReconState` output hash identical before and after (INV-8).
- No `scope` key inside `ReconStateSchema` (OD-1) ⇒ foundation hashes and
  `output_hash` semantics are untouched.

## 9. Invariants

1. **Partition:** every target in S has exactly one status ∈ the six; the six
   `counts` sum to `|S| = entries.length`; `counts.expected = |S| − counts.excluded`;
   entries unique by `(target_type, path)`.
2. **Denominator:** `E = S ∖ EXCLUDED`; `NOT_FOUND ⊆ E`; metrics use only E/S (§10).
3. **Evidence:** every entry carries ≥1 evidence record of the kind required by
   its status (§5.1 table), each record attributable to that exact entry
   (INV-13); allowed extras are explicit (`ANALYZED` may carry a fallback marker;
   `UNRESOLVED` may carry `analysis`); contradictory combinations (e.g.
   `ANALYZED` + `run_error`, `ANALYZED` + attributable UNKNOWN evidence,
   `UNRESOLVED` whose only evidence is a fallback marker) are rejected.
4. **Absence discipline:** status derivation never uses issue-absence or
   empty-extraction output as proof of absence; `NOT_FOUND` requires literal
   expectation + completed walk; failed/partial walk ⇒ `FAILED`.
5. **No-collapse:** the six statuses are mutually distinct and distinct from the
   §22 classes; scope never emits `UNKNOWN`; findings (`severity UNSUPPORTED`,
   RECOVERABLE) are status-irrelevant — they live in the issues artifact and
   never flip an analyzed file; `syntactic_fallback` alone never flips a status
   (fidelity evidence only, §5.3).
6. **Precedence determinism:** winner selection is pure and matches §5.2 for any
   evidence combination.
7. **Determinism:** identical root bytes + config ⇒ byte-identical COMPLETED
   report; all ordering code-unit; zero timestamps/random/absolute paths (§7);
   classification reads structured artifacts only and never parses
   human-readable error-message text (content-caused classes are stable
   cross-environment for a pinned compiler).
8. **Non-mutation:** scope build/validate leaves ReconState byte-identical.
9. **Run binding and orthogonality:** `run_status` and entry statuses are
   orthogonal — neither may be inferred from the other (§5.1): a FAILED run may
   carry `counts.failed = 0` when every on-disk expected entry has independently
   attributable `UNSUPPORTED` status; a COMPLETED run may carry `UNSUPPORTED`,
   `UNRESOLVED`, or other target statuses backed by target-level evidence.
   COMPLETED ⇒ `run` equals the state's current run identity,
   `run_fidelity` present, `counts.failed = 0`; FAILED ⇒ `run: null`,
   `failed_stage` present, `counts.analyzed = 0`, `counts.unresolved = 0`
   (neither completion nor a semantic-resolution verdict survives an abort; so
   INV-1 + INV-9 imply every on-disk expected entry is `UNSUPPORTED` or
   `FAILED`); the report is attached to the rethrown error **iff inventory
   completed** (§8.2); `counts.failed = 0` is valid when every on-disk expected
   entry is `UNSUPPORTED` or E has no on-disk target.
10. **Root containment:** every reported path is root-relative posix; escape
    attempts rejected (`RootEscape`), never reported; `..`/absolute paths rejected
    by validation.
11. **Cross-consistency (with ctx):** `meta.fileCount = counts.analyzed +
    counts.unresolved + counts.unsupported + counts.failed`; provenance span files
    ⊆ {`ANALYZED`, `UNRESOLVED`} entries; rollups recomputed from entries.
12. **Loudness:** a failed analysis never yields a success return; when inventory
    completed, the rethrown error carries `details.scope_report`; when inventory
    failed, it carries none (no fabricated partition); a FAILED report never
    leaves an on-disk expected target unaccounted (as `ANALYZED`/`UNRESOLVED`) —
    `counts.failed = 0` requires full `UNSUPPORTED` attribution or no on-disk
    target (INV-9); run outcome and target accounting stay orthogonal (§5.1) —
    loudness never fabricates target failures to mirror `run_status`, nor the
    reverse; applies to catchable errors (uncatchable death cannot carry
    reports — §7).
13. **Target-attribution:** target-status evidence is target-attributable. For
    every `ScopeEntry`: `UNRESOLVED` requires ≥1 UNKNOWN issue attributable to
    that exact target (`issue.file === entry.path`); `UNSUPPORTED` requires
    structured attribution naming that exact target (`dropped[]` contains
    `entry.path`, or a `compilation_failed` issue with `issue.file ===
    entry.path`); `FAILED` requires failure evidence applicable to that target
    (on-disk, in E, lacking per-target attribution); `ANALYZED` must not contain
    target-attributable UNKNOWN evidence. Run-level evidence alone is never
    broadcast to unrelated targets: file-less UNKNOWN issues flip no entry;
    run-level `run_error` marks only on-disk E entries (never
    `EXCLUDED`/`NOT_FOUND`); inventory failure fabricates nothing (INV-12).
14. **Companion-lock:** every serialized report carries the complete metric/
    count/fidelity context together — full `ScopeMetrics` (all seven fields),
    six-way `counts`, `run_fidelity` on COMPLETED reports — `clean_coverage`
    never exists as an orphan metric; schema-strict validation rejects partial
    metric objects (the required companion set and docs wording are pinned in
    §10 and §13).

## 10. Metrics

Stored as integer `{n, d}` pairs (no floats in the report; presentation layers
round later):

- **`clean_coverage = |ANALYZED| / |E|`** — canonical interpretation: **gap-free
  processing share / pipeline reach without known target-level gaps**: the share
  of expected targets processed end-to-end with no known gaps (not declined,
  refused, failed, or carrying attributable unresolved evidence). If `|E| = 0`
  then `1/1` (vacuous, documented). Interpret together with `run_status`.
  - **MUST NOT be described as:** recon completeness, semantic completeness,
    security coverage, audit coverage, understanding percentage, or risk
    reduction — anywhere in code, docs, tests, or commits (forbidden aliases).
  - Required docs wording (phrase-pinned by test): *"`clean_coverage` measures
    pipeline reach without known target-level gaps. It is not a measure of
    semantic completeness, security coverage, recon soundness, audit coverage,
    or risk reduction."*
- `resolution_completeness = |ANALYZED| / (|ANALYZED| + |UNRESOLVED|)`.
- `unsupported_rate`, `failed_rate`, `not_found_rate` — each over `|E|`.
- `excluded_by_rule` — absolute counts per exact rule string; excluded targets
  never penalize `clean_coverage` (they were never "supposed to be analyzed").
- `fallback_count` — entries whose evidence includes a `syntactic_fallback` issue
  (fidelity disclosure, never a status input); `run_fidelity` reported at run
  level (per-file fidelity is not reconstructable from pipeline output and must
  not be fabricated).
- **Companion set (mandatory together, INV-14):** `{clean_coverage,
  resolution_completeness, unsupported_rate, failed_rate, not_found_rate,
  excluded_by_rule, fallback_count}` + six-way `counts` + `run_fidelity` —
  schema-strict; a report serialized without these companions cannot validate,
  so `clean_coverage` can never exist as an orphan metric.
- Per-file/per-target = the entry itself; per-project = recomputed rollup.
- **Forbidden:** percentages over entity sets that cannot be enumerated without a
  complete AST; `clean_coverage` derived from findings; denominators inferred
  from globs; any metric under a "recon/security/audit coverage" alias label.

## 11. Security constraints

Mirrors TRACEABILITY_SPEC §21/§27 for the scope layer:

- the walk enforces root containment (realpath + `RootEscape`, shared with
  discovery), visited-set cycle guard for symlinks, bounded by `limits`;
- read-only filesystem access + sha256 only; **no code execution, no eval, no
  network, no LLM** (static import gate over `src/scope/**`);
- no repository-provided string trusted as an id; config globs are trusted
  operator input (same trust level as discovery today);
- reports embed root-relative posix paths only (INV-10, test-pinned);
- over-`maxFiles` matches follow existing behavior (`SourceLimitExceeded` abort ⇒
  wrapper marks stage `discover`, FAILED).

## 12. Architecture impact

**New files**

| File | Responsibility |
|---|---|
| `src/scope/model.ts` | types + zod strict schema (`ScopeReportSchema`) |
| `src/scope/inventory.ts` | `buildInventory(config): ScopeInventory` |
| `src/scope/evidence.ts` | issue → per-file evidence classification |
| `src/scope/derive.ts` | pure status derivation + precedence |
| `src/scope/metrics.ts` | `computeMetrics(entries): ScopeMetrics` |
| `src/scope/validate.ts` | invariants + optional cross-checks, `InvalidScopeReport` |
| `src/scope/report.ts` | `serializeScopeReport`, `computeScopeHash` |
| `src/scope/analyze.ts` | `analyzeProjectScoped`, `mapErrorToStage` |
| `src/scope/index.ts` | barrel |
| `tests/scope/*.test.ts` | suites per §13 |
| `docs/scope-accounting.md` | user-facing system-of-record for the model |

**Existing files touched (additive only, OD-6):**

- `src/recon/discover.ts` — export `globToRegExp`, `ALWAYS_EXCLUDED_DIRS`,
  `assertInsideRoot`, `sortPaths` (no behavior change);
- `src/errors/errors.ts` — add one union member `InvalidScopeReport`.

**Zero edits (foundation freeze):** `src/recon-state/**`, `src/traceability/**`,
`src/util/canonical.ts`, `src/ids/**`, `src/relationships/graph.ts`,
`src/recon/issues.ts`, `src/recon/build.ts`, `src/recon/index.ts`,
`src/repository/**`.

**Risks and mitigations:** wrapper parity drift (the wrapper calls
`analyzeProject` as one call — no pipeline re-implementation; parity test pins it);
inventory/discovery glob drift (shared exported primitives + parity test);
"scope" naming vs TRACEABILITY_SPEC §27 (docs disambiguation, §2).

## 13. Test and evaluation requirements

**Layer A — derivation truth table:** one fixture per status; full precedence
matrix (`UNSUPPORTED > FAILED > UNRESOLVED > ANALYZED`); both `derive` outcome
kinds (`completed`, `failed`).

**Layer B — absence pins:** zero-findings file ⇒ `ANALYZED`; empty extraction
output ⇒ `ANALYZED`; glob matching nothing ⇒ no entry; partial/failed walk ⇒
`FAILED` never `NOT_FOUND`; `unsupported_*`-only file ⇒ `ANALYZED` + issues;
`syntactic_fallback` without attributable UNKNOWN issues ⇒ `ANALYZED` +
fidelity evidence; `syntactic_fallback` with attributable UNKNOWN issues ⇒
`UNRESOLVED`; run-level (file-less) UNKNOWN issue ⇒ no entry flips.

**Layer C — validation:** corrupted reports rejected (missing evidence,
status/evidence mismatch, counts not summing, non-relative path, `ANALYZED` on a
FAILED report, unknown keys, `ANALYZED` carrying attributable UNKNOWN evidence,
`UNRESOLVED` whose only evidence is a fallback marker, `UNRESOLVED` whose UNKNOWN
evidence belongs to another file, `UNSUPPORTED` without structured attribution,
partial metric objects without companions); non-mutation (state hash before ==
after).

**Layer D — determinism:** double build ⇒ byte-identical
`serializeScopeReport` + equal `scope_hash`; strict schema rejects undeclared keys
(any timestamp-shaped field); `clean_coverage` keys stable across runs.

**Layer E — integration:** wrapper success parity (state byte-equal to plain
`analyzeProject`); run binding fields equal the state's current run;
provenance cross-check; `meta.fileCount` equation; dropped attribution from a real
`CompilationFailed` fixture; unattributable `CompilationFailed` (empty `dropped`)
⇒ on-disk E entries `FAILED` not `UNSUPPORTED`; failure path throws with
`details.scope_report` holding a complete S-partition; inventory-failure path
rethrows **without** a fabricated `scope_report`; FAILED report with
`counts.failed = 0` accepted when every on-disk expected target is
`UNSUPPORTED` (all-dropped) or E has no on-disk target; FAILED report carrying
an `UNRESOLVED` or `ANALYZED` entry rejected.

**Layer F — security:** no absolute path in serialized output; `RootEscape`
fixture rejected; symlink-cycle termination; `maxFileBytes` boundary (at-limit
eligible, limit+1 ⇒ `EXCLUDED` + `limit:maxFileBytes`); static import gate over
`src/scope/**` (only `node:fs`, `node:path`, `node:crypto`, `zod`, `src/**` —
zod added because §12 mandates zod strict schemas and it is already a project
dependency; no other module reaches `src/scope/**`).

**Layer G — evaluation corpus (frozen golden reports):** `clean-vault`,
`mixed-excludes`, `literal-missing`, `all-dropped`, `syntactic-fallback`,
`run-abort`, `only-excluded` (`|E| = 0` ⇒ `clean_coverage` `1/1`); each re-run
twice for byte-identity. The `syntactic-fallback` corpus pins the OD-4 rule:
fallback files classified by their attributable UNKNOWN evidence (fallback
marker preserved; a site-less fallback file ⇒ `ANALYZED`), all goldens carry
the full companion metric set with `clean_coverage` keys.

**Regression gate (every task):** `npx vitest run` green (399 baseline + new),
`npx tsc --noEmit` clean; final gate adds `git diff --name-only` ⊆ allowed set
(`src/scope/**`, `tests/scope/**`, `src/recon/discover.ts`,
`src/errors/errors.ts`, `docs/**`).

**Review Focus (inputs most likely to break a user of this report):**
1. glob-matching-nothing falsely yielding `NOT_FOUND` — pinned in Task 3;
2. overclaim family: zero-findings read as not-analyzed, fallback read as
   unresolved, `clean_coverage` read as recon/semantic completeness — pinned in
   Tasks 3, 5, 6, 12;
3. `UNSUPPORTED` vs `FAILED` attribution boundary (structured vs unattributed,
   message-text parsing) — pinned in Tasks 5, 9;
4. absolute-path / timestamp leakage into reports — pinned in Tasks 8, 11;
5. wrapper parity drift vs `analyzeProject` — pinned in Task 10.

## 14. Non-goals

Evidence Graph; deployment/runtime identity (#2); temporal lifecycle/entity
versioning (#3); contract- or function-level percentage metrics; quality /
finding-density metrics; CLI; sqlite persistence (v1 returns the report
in-process); any foundation rewrite.

## 15. Open decisions (approval status)

Approved 2026-10-06. OD-3 and OD-4 approved **as revised** (attribution-based
classification; UNKNOWN-only `UNRESOLVED` trigger); OD-9 approved with the
`coverage → clean_coverage` rename; all others approved unchanged.

| # | Decision | Recommendation | Rationale / alternative cost | Ref |
|---|---|---|---|---|
| OD-1 | Where the model lives | Separate `ScopeReport` artifact bound by run identity | Zero foundation edits; in-state key would touch `schema.ts`/`state.ts`/`validate.ts` and change `output_hash` | §8.3 |
| OD-2 | Target granularity v1 | `source_file` only, `target_type` extensible | Contract-level denominators unenumerable for dropped/unparsed files (absence discipline) | §6 |
| OD-3 | `UNSUPPORTED` vs `FAILED` on unparseable content | **Approved revised:** attribution-based — structured per-target proof (`dropped[]`/`compilation_failed` with `file`) ⇒ `UNSUPPORTED`; unattributable batch/compiler failure ⇒ `FAILED`; never message-text parsing; inventory failure ⇒ no report | Per-target content failures are machine-reproducible; batch causes must not be laundered into per-file content blame | §5.1, §8.2 |
| OD-4 | `UNRESOLVED` trigger set | **Approved revised:** ≥1 `severity === 'UNKNOWN'` issue **attributable to that target** only; `syntactic_fallback` is fidelity evidence, never a status trigger; run-level UNKNOWN issues flip no entry | Matches §22 mapping; fallback undercounts vs UNKNOWN sites; attribution prevents evidence broadcasting | §5.1, §5.3 |
| OD-5 | Persistence v1 | In-process return only; no sqlite, no CLI | No CLI exists; a new table would edit frozen `sqlite.ts` | §14 |
| OD-6 | Foundation touch budget | Allow additive-only: `discover.ts` exports + `errors.ts` union member | Zero-touch alternative (glob copies, generic error code) risks drift and misleading errors | §12 |
| OD-7 | `file_too_large` status | `EXCLUDED` + rule `limit:maxFileBytes` | Policy decline, not failure; FAILED would inflate failure counts with policy outcomes | §4 |
| OD-8 | `NOT_FOUND` breadth v1 | Literal includes only | Globs cannot enumerate nonexistent members; no external expectation list exists | §4 |
| OD-9 | Coverage denominator | **Approved with rename:** metric named `clean_coverage`; E (policy-excluded targets removed) as denominator; gap-free-processing-share interpretation only (§10) | Exclusions are operator decisions; counting them hides real gaps behind policy noise; the rename prevents semantic-completeness overclaim | §10 |
| OD-10 | Document paths | `docs/scope-accounting-spec.md` + `docs/plans/2026-10-06-recon-phase3-scope-accounting.md` | Matches repo flat-docs + `docs/plans/` convention | — |
