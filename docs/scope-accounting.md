# Scope Accounting

User-facing system-of-record for the Phase 3 scope accounting model. The
normative definition — domain model, invariants, and test requirements — lives
in [`docs/scope-accounting-spec.md`](./scope-accounting-spec.md); where this
document and the specification differ, the specification wins. The phrase-level
wording below is pinned by `tests/scope/docs-phrases.test.ts`.

Note on naming: "scope accounting" (this document) is unrelated to the
"scope exclusions" boundary (no-eval / no-LLM / no-network) described in
`docs/TRACEABILITY_SPEC.md` §27.

## Purpose: the critical question

Per run, the report answers: **what was supposed to be analyzed, what was
actually analyzed, and what prevented analysis?** — as a first-class,
deterministic, evidence-backed report.

Every accountable scope target receives exactly one status:

```
ANALYZED | EXCLUDED | NOT_FOUND | UNRESOLVED | UNSUPPORTED | FAILED
```

**Absence of evidence is never evidence of absence.** No status is derived from
missing output: `NOT_FOUND` requires positive proof from a completed walk, and
any claim that a target was processed incompletely requires positive,
per-target evidence.

## The six statuses

| Status | Meaning (attempt outcome) | Never triggered by |
|---|---|---|
| `ANALYZED` | Processing-outcome claim only: the target was expected (in `E`), read and digested, and completed every pipeline stage the run reached, at the run's recorded fidelity. | Issue absence, construct modeling, or any stronger claim about the result — it asserts none of them. |
| `EXCLUDED` | Policy declined analysis before it started. | Repository content. |
| `NOT_FOUND` | A specific named expectation provably does not exist: a literal include with zero filesystem matches, certified by a completed walk. | Globs matching nothing; empty extraction output; a failed or partial walk. |
| `UNRESOLVED` | Processed, with positive per-target semantic-incompleteness evidence: at least one `UNKNOWN`-severity issue whose `file` equals this entry's `path`. May additionally carry `analysis` evidence. | The fallback marker alone; run-level or other-file `UNKNOWN` issues; absence of relationships or facts. |
| `UNSUPPORTED` | Structured, per-target content attribution proves this file's bytes were refused (parse errors) and the file was dropped: a `compilation_failed` issue whose `file` equals this entry's `path`, or a structured `dropped[]` entry naming it. | Human-readable message-text inference; batch causes without per-target attribution; `unsupported_*` construct findings. |
| `FAILED` | Run failure prevented analysis and no per-target content attribution exists for this target. | Content problems proved for that target (those are `UNSUPPORTED`); `EXCLUDED` and `NOT_FOUND` entries. |

`ANALYZED` claims exactly one thing: the pipeline processed the target
successfully at the run's recorded fidelity. `severity UNSUPPORTED` findings
(`unsupported_*`) are findings, not target status — the file stays `ANALYZED`
with the findings recorded in the issues artifact.

## Precedence

1. Pre-analysis facts first: `EXCLUDED` and `NOT_FOUND` (disjoint from
   processing outcomes).
2. For attempted targets (on disk, in `E`), exactly one winner, in order:
   `UNSUPPORTED > FAILED > UNRESOLVED > ANALYZED`.

Precedence operates only over evidence already attributed to the target;
evidence that cannot be attributed to a target never enters the evaluation.
Derivation is a pure function of `(inventory, issues, meta, error-details)` —
no clock, no randomness, no environment reads, no message-text parsing.

## Inventory and the denominator

The inventory is built by an independent, read-only walk that reuses
discovery's glob and containment primitives (shared code, not a second
implementation).

**Accounting universe `S`:**

- files matching at least one `config.includes` pattern (default `**/*.sol`),
  enumerated *before* exclusion checks;
- **literal** (glob-magic-free) `config.includes` entries with zero filesystem
  match → `NOT_FOUND` expectations, provided the expectation's path lies in the
  enumerable, non-excluded scope (see the always-excluded rule below);
- always-excluded directories encountered during traversal (`.git`,
  `node_modules`, `.recon-cache`) → one directory-level exclusion marker each
  (contents never enumerated, so the walk stays bounded);
- files under the root that match no include pattern are outside the model and
  are never accounted (include globs define the universe; config is trusted
  operator input).

**Sets:** `E (expected) = S ∖ EXCLUDED`, and `counts.expected = |E|`.
`NOT_FOUND ⊆ E` — an expectation is what was supposed to exist. In-memory
inventory records may hold absolute paths for I/O; reports never do (every
reported path is root-relative posix, and root escape is rejected with
`RootEscape`).

**Exclusion rule strings (exact, stable API):**

| Rule | Trigger |
|---|---|
| `config:excludes:<pattern>` | file matches a user exclude glob |
| `always:<dirname>` | traversal hit an always-excluded directory |
| `limit:maxFileBytes` | matched file exceeds `limits.maxFileBytes` |
| `type:non-file` | directory, symlink-to-dir, or special entry, not a regular file |

Rule order is deterministic: a matched file's exclude pattern is checked before
the file is read (unread ⇒ size unknown ⇒ a file carries at most one exclusion
rule), and `limit:maxFileBytes` applies only to files that pass pattern
exclusion. `always:<dirname>` uses the directory basename (the always-set is
matched at any depth); the entry's `path` is the full root-relative directory
path with no trailing slash. Literal expectations are normalized root-relative
posix paths — duplicates collapse to one expectation, and a literal include
that escapes the root after normalization is rejected during inventory build;
absence is never claimed for paths outside the root. A literal include whose
path lies under an always-excluded directory disappears behind that boundary:
it receives no individual `ScopeEntry` (neither `EXCLUDED` nor `NOT_FOUND`) —
only the directory-level `always:<dirname>` marker accounts for it — and
literal `NOT_FOUND` requires a completed walk over an enumerable, non-excluded
scope.

The denominator for the rate metrics is `E`. Policy-excluded targets were never
supposed to be analyzed, so they never penalize the share below.

## Evidence and target attribution

Every `ScopeEntry` carries at least one evidence record of the kind its status
requires, and every record must be attributable to **that exact entry**
(`issue.file === entry.path`, or a `dropped[]` entry naming the path):

- `ANALYZED` → `analysis` (sha256), optionally plus fallback fidelity evidence;
- `EXCLUDED` → `exclude_rule` or `size_limit`;
- `NOT_FOUND` → `walk_miss` from a completed walk;
- `UNRESOLVED` → at least one `UNKNOWN`-severity issue attributable to this
  target, optionally plus `analysis`;
- `UNSUPPORTED` → structured per-target attribution (a `compilation_failed`
  issue with this `file`, or `dropped[]` containing this `path`);
- `FAILED` → `run_error {stage, error_class, message}` applicable because the
  target is on disk, in `E`, and lacks per-target attribution.

Run-level evidence is never broadcast to unrelated targets: a file-less
`UNKNOWN`-severity issue flips no entry, and a run-level `run_error` marks only
on-disk `E` entries — never `EXCLUDED` or `NOT_FOUND`. Contradictory evidence
combinations (for example `ANALYZED` together with `run_error`, or an
`UNRESOLVED` entry whose only evidence is the fallback marker) are rejected by
validation.

## Syntactic fallback is fidelity evidence, never a status

`syntactic_fallback` is **fidelity evidence**: the semantic compile failed for
the file, so only syntax-only analysis ran. It records fidelity degradation of
the analysis performed on the target — not that the target itself has
unresolved semantics.

- `syntactic_fallback` alone never produces `UNRESOLVED`.
- The marker is preserved on the entry as an embedded issue (allowed alongside
  `ANALYZED`), plus report-level `run_fidelity` and metric `fallback_count`;
  nothing is erased.
- In practice, fallback files often still become `UNRESOLVED`, because syntactic
  mode cannot resolve declarations and the extractors emit attributable
  `UNKNOWN`-severity issues. A fallback file with no attributable issues becomes
  `ANALYZED` plus fidelity evidence — correct, since no semantic site exists to
  be incomplete about.

## UNSUPPORTED vs FAILED: attribution, never message text

The classifier reads structured artifacts only — inventory, issues,
`details.dropped`, error class — and never parses human-readable error-message
text.

- Structured, per-target proof that content was refused (`dropped[]` naming the
  file, or a `compilation_failed` issue with this `file`) ⇒ `UNSUPPORTED`.
- Unattributable batch/compiler failure (for example an unlocated
  `CompilationFailed` with an empty `dropped[]`) ⇒ **all** on-disk `E` entries
  `FAILED`, never `UNSUPPORTED`. A batch cause without per-file proof must not
  be laundered into per-file content blame.
- Per-target-attributed content failures are machine-reproducible (pinned
  compiler, same diagnostics ⇒ same `dropped` list); environment failures are
  recorded verbatim as `run_error`, with stable `stage` and `error_class`.

## Run status and entry status are orthogonal

`run_status` describes the pipeline/run outcome; `ScopeEntry.status` describes
target-level accounting; neither is inferred from the other.

- A `FAILED` run may legitimately have `counts.failed = 0` when every expected
  on-disk target has independently attributable `UNSUPPORTED` status.
- A `COMPLETED` run may legitimately contain `UNSUPPORTED`, `UNRESOLVED`, or
  other target statuses when those statuses are backed by target-level evidence
  and the run itself completed.

Identical entry partitions may therefore carry different `run_status` values,
and identical `run_status` values may carry different entry partitions. Run
failure, target failure, and content refusal remain three distinct signals
(`run_status`, entry `FAILED`, entry `UNSUPPORTED`) and are never collapsed.
The report asserts both dimensions independently.

## Failure semantics: two branches, inventory decides

On success the report holds a complete `S` partition, `run_status: COMPLETED`,
a bound `run` identity, and `run_fidelity` from the pipeline metadata.

When analysis fails, the wrapper branches on whether the inventory walk
finished:

1. **Inventory completed (`S` known):** the wrapper catches the `ReconError`,
   maps error class → stage (`NoSourcesFound | SourceLimitExceeded | RootEscape`
   → `discover`; `CompilationFailed | CompilerUnavailable` → `compile`;
   otherwise `analysis`), and attributes per target: entries named in structured
   `error.details.dropped[]` (live or in `CompilationFailed` details) ⇒
   `UNSUPPORTED`; the remaining on-disk `E` entries ⇒ `FAILED` with
   `run_error {stage, error_class, message}`. `EXCLUDED` and `NOT_FOUND` keep
   their pre-analysis statuses — a run-level failure never broadcasts to them.
   Metrics are computed over the full partition, and the original error is
   **rethrown with `details.scope_report` attached** — loud by design, a
   complete `S` partition even under failure.
2. **Inventory failed** (root escape, I/O failure, or limits during the scope
   walk): rethrow **without** `scope_report`. An `S` partition that was never
   observed is never fabricated.

Accounting under failure: every on-disk expected target is `UNSUPPORTED`
(content-attributed) or `FAILED` (unattributed). `counts.failed = 0` is valid
exactly when all on-disk expected targets are `UNSUPPORTED` (for example
`all-dropped`) or `E` has no on-disk target (for example `NoSourcesFound` with
only literal-miss expectations). A `FAILED` report never carries `ANALYZED` or
`UNRESOLVED` entries. Uncatchable process death (OOM, SIGKILL) cannot carry a
report — a documented honesty limit.

## Metrics

Stored as integer `{n, d}` pairs (no floats in the report; presentation layers
round later).

| Metric | Definition |
|---|---|
| `clean_coverage` | `ANALYZED` over `E` — the **gap-free processing share**: expected targets processed end-to-end with no known gaps (not declined, refused, failed, or carrying attributable unresolved evidence). An empty `E` yields `1/1` (vacuous, documented). Interpret together with `run_status`. |
| `resolution_completeness` | `ANALYZED` over (`ANALYZED` + `UNRESOLVED`). |
| `unsupported_rate` | `UNSUPPORTED` over `E`. |
| `failed_rate` | `FAILED` over `E`. |
| `not_found_rate` | `NOT_FOUND` over `E`. |
| `excluded_by_rule` | absolute counts per exact rule string, sorted by code unit. |
| `fallback_count` | entries whose evidence includes a `syntactic_fallback` issue (fidelity disclosure, never a status input). |

`clean_coverage` measures pipeline reach without known target-level gaps. It is not a measure of semantic completeness, security coverage, recon soundness, audit coverage, or risk reduction.

**Companion set (mandatory together, INV-14):** `{clean_coverage,
resolution_completeness, unsupported_rate, failed_rate, not_found_rate,
excluded_by_rule, fallback_count}` plus the six-way `counts` and `run_fidelity`
on `COMPLETED` reports serialize as one schema-strict unit. A report missing
any companion cannot validate, so `clean_coverage` never exists as an orphan
metric. Per-project values are recomputed from entries only, never stored
twice.

**Forbidden constructions:** percentages over entity sets that cannot be
enumerated without a complete AST; `clean_coverage` derived from findings;
denominators inferred from globs; any metric published under an alias label for
this number (see the next section).

**Frozen evaluation corpus (spec §13, Layer G):** `clean-vault`,
`mixed-excludes`, `literal-missing`, `all-dropped`, `syntactic-fallback`,
`run-abort`, and `only-excluded` (empty `E` ⇒ `clean_coverage` `1/1`), each run
twice for byte-identity, all carrying the full companion metric set.

## Forbidden alias labels

`clean_coverage` must never be restated under an alias label. Spec §10
enumerates the forbidden alias strings; this document deliberately does not
repeat them outside the one required sentence quoted above, because the phrase
test forbids them anywhere else in this file. In plain terms: the number says
how far the pipeline got without known target-level gaps, and nothing more. Do
not restate it as a claim about how completely the code was reconstructed, how
strong the analysis is, how much was reviewed, how much was understood, or how
much risk went away.

## Example report

Four targets: `|S| = 4`, `|E| = 3`, `clean_coverage = 1/3`.

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

Entries are sorted by code-unit order of their root-relative path; `counts` and
`metrics` are recomputed from the entries, so they can never drift from them.

## v1 limits and non-goals

- The report is returned **in-process** only: no CLI, no sqlite persistence.
- `target_type` is `source_file` only (the union is designed to be extended).
- Per-file fidelity is not reconstructable from pipeline output and is never
  fabricated: only run-level `run_fidelity` is reported.
- Reports contain no wall-clock time, randomness, absolute paths, or
  host/user/environment strings — except verbatim `run_error.message` on
  `FAILED` reports, where `stage` and `error_class` remain the stable parts.
- Non-goals for this phase: Evidence Graph; deployment/runtime identity;
  temporal lifecycle and entity versioning; contract- or function-level
  percentage metrics; quality and finding-density metrics; any foundation
  rewrite.

## Where to look next

- Normative specification: [`docs/scope-accounting-spec.md`](./scope-accounting-spec.md)
  — domain model (§3), inventory (§4), statuses and precedence (§5), integration
  and failure semantics (§8), invariants (§9), metrics (§10), tests (§13),
  non-goals (§14).
- Phrase pinning for this document: `tests/scope/docs-phrases.test.ts`.
