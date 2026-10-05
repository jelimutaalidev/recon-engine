# Deterministic Recon Layer (Phase 2) — Definition of Done → evidence

Implementation of `docs/plans/2026-10-03-recon-layer.md` against the binding
design in `docs/recon-layer-design.md`. This document records the evidence for
the Phase 2 DoD (design §11), the verification results, and the fabrication
review. Read it next to the design — the design is the intent, this file is
the contract of the code.

## Scope

In scope: normalized IR from solc AST, entity/call/storage/event extraction
with UNKNOWN discipline, UNSUPPORTED surfacing, `analyzeProject(config)`
end-to-end entry, security + error-matrix suites, persistence idempotency,
determinism, docs.

Out of scope (unchanged from design): LLM agents, vulnerability detection,
exploit generation, crawling, vector search, incremental per-file caching,
multi-version compiler batches.

## Layout

```
src/recon/
  index.ts        analyzeProject entry (resolve timestamp/git -> buildState)
  build.ts        resolveGitContext/resolveProjectRepository/buildState
  timestamp.ts    timestamp priority (config > git > epoch), git root matching
  config.ts       AnalysisConfig (root, limits, cache-only, recordGit, ...)
  issues.ts       ReconIssue model, severity classes, sortIssues
  discover.ts     source discovery (traversal/symlink/size/count guards)
  backend/solc/   versions (pragma parse/pin/cache), compile (ladder), solc.d.ts
  ir/             build.ts (AST -> NormalizedProject), line-map, types, raw ast
  extract/        contracts, functions, state-variables, inheritance, modifiers,
                  calls, storage-access, event-error-facts
fixtures/solidity/ vault/ (5 files), unsupported/, broken/
tests/recon/      per-task suites + vault-e2e, security, error-matrix,
                  idempotency, analyze
migrations/       001_initial.sql, 002_phase2_extraction_fields.sql
```

## Definition of Done (design §11) → evidence

| # | Requirement | Evidence |
|---|---|---|
| 1 | `analyzeProject(config)` works; state passes `validateReconState` | `src/recon/index.ts`, `tests/recon/analyze.test.ts` (5), `tests/recon/vault-e2e.test.ts` (9) |
| 2 | D1-D3 implemented exactly as approved | `tests/recon/schema-d1-d2.test.ts` (9), `tests/recon/ids-d3.test.ts` (12) |
| 3 | Extraction coverage (contracts, function kinds, selectors, state vars + slots, INHERITS/IMPLEMENTS, calls, READS/WRITES, modifier invocations) | `tests/recon/ir-build.test.ts` (9), `tests/recon/extract-entities.test.ts` (15), `tests/recon/extract-calls.test.ts` (6), `tests/recon/extract-unknown.test.ts` (3), `tests/recon/vault-e2e.test.ts` |
| 4 | Provenance complete for every generated fact/relationship (never fabricated) | `createFact`/`createRelationship` enforce >=1 provenance structurally (`MissingProvenance`); every extractor passes `file`+`lines` spans; fabrication review below |
| 5 | UNKNOWN handled conservatively; syntactic fallback cannot fabricate semantics | `tests/recon/extract-unknown.test.ts`, `tests/recon/extract-calls.test.ts` (markers only, `fidelity='semantic'` asserted), `tests/recon/error-matrix.test.ts` |
| 6 | All four error classes tested; untrusted-repo security suite passes | `tests/recon/error-matrix.test.ts` (4: FATAL/RECOVERABLE/UNKNOWN/UNSUPPORTED), `tests/recon/security.test.ts` (8), `tests/recon/backend-versions.test.ts` (29) |
| 7 | Determinism (byte-identical) and persistence idempotency pass | `tests/recon/analyze.test.ts` (two runs -> identical `stateJson`), `tests/recon/idempotency.test.ts` (2: saveState twice, loadState round-trip byte-identical on a fresh sqlite file) |
| 8 | Phase 1 tests stay green; tsc clean; coverage target met; Vault E2E passes | 309/309 across 23 files; `npx tsc --noEmit` clean; `src/recon/**` statements 84.63% / lines 87.22% (target >= 80%); `tests/recon/vault-e2e.test.ts` (9) |
| 9 | Documentation reflects the actual implementation and its limitations | `docs/recon-layer-design.md` §12 updated to actual behavior; this document; `.superpowers/sdd/2026-10-03-recon-layer/progress.md` rulings log |

## Verification results (Task 12 run)

```
npm test           # 309 passed (23 files) — Phase 1: 169, Phase 2: 140
npx tsc --noEmit   # clean (strict, NodeNext)
npx vitest run --coverage
                   # src/recon/** statements 84.63% (1080/1276)
                   #                        lines    87.22% (983/1127)
                   #                        branches 70.66% (636/900)
                   #                        funcs    94.79% (182/192)
```

Determinism: `analyzeProject` over `fixtures/solidity/vault` run twice with a
pinned `config.timestamp` and `recordGit:false` produces byte-identical
`stableStringify` state JSON (project `created_at`/`updated_at` and every
fact/relationship `created_at` come from the injected timestamp; no entity
other than `Project` carries a timestamp; no wall clock is read in
`src/recon/**`).

Idempotency: `saveState` twice with identical content on a fresh sqlite file
raises no error; `loadState` of the saved state re-serializes byte-identically
(persisted by migration `002_phase2_extraction_fields.sql`, which adds the
Phase 2 `contracts.is_abstract`/`contracts.source` and
`state_variables.mutability` columns).

## Fabrication review

- `new Date(` / `Date.now(` / `Math.random` in `src/recon/**`: none. The only
  `new Date` uses parse/normalize `config.timestamp` (`timestamp.ts`). Wall
  clock `new Date()` exists only in Phase 1 factories as a *fallback* for
  optional `created_at`, and in migration bookkeeping rows — recon never
  triggers those paths with defaults.
- Name-matching heuristics: none claim identity. Two name *checks* exist and
  both are conservative guards: (a) syntactic fallback only records a storage
  access when the name matches a known state var and then produces no edge
  (no `resolvedRef` -> issue bucket); (b) `storage-access.ts` verifies the
  AST-resolved `resolvedRef` is declared in the target contract before
  creating an edge, otherwise it emits an issue.
- Unprovenanced facts/relationships: structurally impossible —
  `createFact`/`createRelationship` reject records with zero provenance
  (`MissingProvenance`), and every extractor provenance carries file+lines
  from the compiler AST.
- Solc evidence only: selectors, function kinds, visibility, mutability, slots,
  inheritance and call resolution all read from the solc AST/`storageLayout`/
  `methodIdentifiers` output; fixtures are compiled live (bundled solc 0.8.37).

## Running

```
npm test           # vitest, 309 tests across 23 files
npm run typecheck  # tsc --noEmit (strict, NodeNext)
npx vitest run --coverage   # src/recon/** scoped coverage
```

Node >= 20 (developed on Node 24). solc is the bundled npm package (WASM,
in-process, offline).
