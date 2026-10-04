# Deterministic Recon Layer — Design (Phase 2, APPROVED)

Status: **APPROVED** (D1 = YES, D2 = YES, D3 = YES). Scope frozen to this document.
Supersedes: chat proposal of 2026-10-03. Guardrails below are binding.

## 1. Architectural principle

```
Solidity source -> compiler evidence -> normalized IR -> deterministic extraction -> ReconState facts/relationships/provenance
```

Explicitly NOT in Phase 2: vulnerability detection, exploit discovery, PoC generation,
severity, economic analysis, attack-path validation, LLM reasoning, autonomous security
judgment, OpenCode integration, RAG, vector DB, fuzzing, symbolic execution,
Event/Modifier/TypeDef entities, new RelationshipType vocabulary.

If implementation reveals a genuine need for any of these: STOP and document as a
schema/design decision instead of silently implementing it.

## 2. Parser recommendation (decided)

Primary backend: **solc standard-JSON AST via `solc-js` (npm, in-process WASM)**.

- Semantic evidence: `referencedDeclaration`, `linearizedBaseContracts`,
  `storageLayout`, `evm.methodIdentifiers`, `src` byte ranges.
- Multi-version: bundled version (npm `solc`) used directly; other pinned versions via
  `loadRemoteVersion` from `https://binaries.soliditylang.org` with sha256 verification
  against official `list.json`, cached under `.recon-cache/solc/`.
- Degraded mode: `settings.stopAfter: "parsing"` for files that fail full compilation.
- No shell: WASM in-process only.

Rejected alternatives (with reasons):

| Alternative | Reason |
|---|---|
| `@solidity-parser/parser` | no semantic resolution (types, linearization, referencedDeclaration) => name-inference = fabrication risk. Kept as future fallback backend behind the same interface; not implemented in Phase 2. |
| `tree-sitter-solidity` + `tree-sitter` | native node-gyp build (machine has no VS C++ toolset); CST, not semantic AST; grammar lag risk. |
| native `solc.exe` via `child_process` | single local version, shell spawn, portability/CI dependency. |
| Sourcify/Etherscan downloads | third-party trust, non-deterministic network scope. |

## 3. Pipeline & module structure

```
src/recon/
  index.ts                analyzeProject(config): Promise<AnalysisResult>
  config.ts               ReconConfig (zod): root, include/exclude, solcVersion?,
                          compilerSource 'auto'|'cache-only', remappings, timestamp?,
                          recordGit, limits {maxFileBytes, maxFiles, timeoutMs}
  issues.ts               ReconIssue {severity, code, message, file?, line_start?, line_end?, count?}
  discover.ts             source walk (excludes .git/node_modules), size/count caps, sha256
  backend/types.ts        ParserBackend, ParseResult, NormalizedProject contract
  backend/solc/versions.ts pragma parse, deterministic version selection, download+verify+cache
  backend/solc/compile.ts standard-JSON input/output, stopAfter fallback
  backend/solc/index.ts   SolcBackend implements ParserBackend
  ir/types.ts             NormalizedProject, ContractIR, FunctionIR, StateVarIR, CallSite, StorageAccess, Span
  ir/build.ts             AST -> IR; byte offset -> line (UTF-8 byte-accurate); fidelity flag
  extract/index.ts        ordered extractor registry, state-patch merge, edge dedupe
  extract/contracts.ts  extract/functions.ts  extract/state-variables.ts
  extract/inheritance.ts  extract/calls.ts     extract/storage-access.ts
  extract/modifiers.ts    extract/event-error-facts.ts  extract/provenance.ts
  build.ts                IR + issues -> ReconState via Phase-1 factories -> sort -> validateReconState
tests/recon/**            unit, integration, determinism, security
fixtures/solidity/**      Solidity fixture repos
```

Data flow: `config -> discover -> version-plan -> ParserBackend.parse -> IR ->
extractors -> Phase-1 factories -> sort by id -> validateReconState ->
AnalysisResult { state, issues }`.

- Never parser -> SQLite. Repository persistence stays a Phase-1 concern.
- Deterministic ordering everywhere: sorted file discovery, AST nodes by byte start,
  fixed extractor order, edge dedupe before id computation, arrays sorted by id
  (serializeReconState already sorts).

## 4. Normalized IR

```
NormalizedProject { fidelity: 'semantic'|'syntactic', compiler?: {longVersion, sourceHash},
                    files: SourceFile[], issues: ReconIssue[] }
SourceFile  { path, sha256, pragmas[] }
ContractIR  { kind: 'contract'|'interface'|'library', abstract, name, fqn, span,
              bases: {fqn, kind}[] (linearized, self first), stateVars[], functions[], events[], customErrors[] }
FunctionIR  { kind: 'function'|'constructor'|'fallback'|'receive', name, params/returns {name?, type}[],
              visibility, stateMutability, modifiers {name, argsText}[], canonicalSignature, selector?,
              declaredIn, span, implemented, callSites[], storageAccesses[] }
StateVarIR  { name, type, visibility, mutability 'mutable'|'constant'|'immutable', slot?, declaredIn, span }
CallSite    { kind: 'internal'|'external'|'super'|'self-external'|'new'|'delegatecall'|'staticcall'|'lowlevel',
              resolvedRef? {fqn, signature, nodeType}, span }
StorageAccess { op: 'read'|'write'|'readwrite', resolvedRef? {fqn, name}, span }
Span        { file, byteStart, byteEnd, lineStart, lineEnd }
```

IR is parser-faithful (what solc states). Extractors decide ReconState semantics.
`fidelity: 'syntactic'` (stopAfter parsing) means referencedDeclaration may be absent.

## 5. Guardrails (binding)

### 5.1 Evidence over inference
Only compiler/parser evidence creates relationships. Never infer from name similarity,
address-like values, or signature-looking strings. If the compiler cannot establish the
target: **UNKNOWN is the correct output**. No fuzzy matching, ever.

### 5.2 Syntactic fallback must not fabricate
In `syntactic` mode, never convert a name match into a CALLS/READS/WRITES relationship.
Unresolvable sites become UNKNOWN (fact marker + provenance + ReconIssue). A syntactic
parser may recover syntax, but must not manufacture semantic certainty.

### 5.3 Call kinds are preserved
CALLS relationships carry `metadata.call_kind`:
`internal | external | super | self-external | new`.
Unresolvable call families carry the kind in deterministic fact markers
(`unresolved-delegatecall`, `unresolved-staticcall`, `unresolved-lowlevel-call`,
`unresolved-indirect-call`) plus UNKNOWN issues. Distinguishing examples that must hold:
`foo()` = internal; `this.foo()` = self-external; `super.foo()` = super;
`someContract.foo()` = external; `new X(args)` = new (target = constructor function entity);
`addr.delegatecall/staticcall/call` = unresolved family (kind in marker value).

### 5.4 READS/WRITES scope
Deterministic storage-access extraction from AST/compiler declaration identity only
(assignment -> write; compound assign / ++/-- -> read+write; other references -> read;
root state variable of index/member chains). NOT data-flow analysis: no alias analysis,
taint propagation, interprocedural flow, symbolic execution, value ranges, economics.

### 5.5 Contract classification
Structural only: `interface` -> `interface`, `library` -> `library`, everything else
`contract_type: 'unknown'`. Semantic classification (vault/token/...) is future work.

### 5.6 Provenance mandatory, never fabricated
Every generated FACT and RELATIONSHIP has >=1 `source_code` provenance with file and
line range where available (repository/commit only when git root == analyzed root;
compiler version where known). Never invent line numbers, commits, repository identity,
or compiler metadata. Unavailable info stays absent per schema rules.

### 5.7 UNKNOWN vs UNSUPPORTED
- UNKNOWN: construct exists, target/value not determinable (dynamic external call).
- UNSUPPORTED: analyzer explicitly does not model the construct (Yul/assembly, enum/struct
  definitions, builtins).
Neither is silently converted into an apparently valid fact. Both surface as ReconIssues.

### 5.8 Determinism
Byte-identical `serializeReconState` for identical inputs. No hidden `new Date()`
(config.timestamp -> git committer time -> fixed epoch fallback), no random ids,
no iteration-order dependence, deterministic issue ordering.

### 5.9 Security (untrusted repositories)
Never execute target repo code, `hardhat.config.js`, `foundry.toml`, project scripts,
`npm install`, or build hooks. Root/path jail (realpath + prefix, block `../`, absolute
escapes, symlink escape), file size and file count caps, compile timeout. Compiler
downloads only from `https://binaries.soliditylang.org` with sha256 verification;
`cache-only` mode supported; no unnecessary native dependencies.

## 6. Approved schema changes (D1-D3)

- **D1**: `Contract.is_abstract?: boolean` — direct from AST `ContractDefinition.abstract`.
  Never inferred from missing implementations, naming, comments, or inheritance alone.
- **D2**: `StateVariable.mutability?: 'mutable'|'constant'|'immutable'` — direct from AST
  `VariableDeclaration.mutability`. Never inferred from usage.
- **D3**: stable source contract identity: `sourceContractId(sourceFile, name)` ->
  `contract:<normalized-source-file>:<contract-name>` (e.g. `contract:src__vault_sol:vault`).
  Normalization: posix relative path, lowercase, `/` -> `__`, `.` -> `_`, other chars ->
  `_`. Used for contracts with `source_file` and no address. No unstable suffixes
  (`vault#2`), no merging duplicates. Function/StateVariable/Relationship ids derive from
  `contract_id` and stay stable while file+name stay unchanged. `contractId()` (Phase 1)
  is unchanged. Duplicate normalized ids at build time = FATAL.

No other schema expansion (Event/Modifier/TypeDef entities, new relationship types, new
predicates) without explicit approval.

## 7. Extraction rules

- **Contracts**: kind from `ContractDefinition`; `is_abstract` from `abstract`;
  `source_file` set; `compiler_version` = longVersion actually used;
  `source` = `file:startLine-endLine`. No `address`, `source_verified`, `is_proxy` (never fabricated).
- **Functions**: all kinds (function/constructor/fallback/receive). Signature/selector
  only from `evm.methodIdentifiers` for public/external; internal/private signature from
  typeDescriptions with documented normalization (strip `contract `/`struct `/`enum `
  prefixes). Constructor/fallback/receive: selector omitted (no official selector exists).
  `modifiers[]` = canonical invocation text (name + source args slice, whitespace-collapsed;
  argument values not resolved).
- **State variables**: type/visibility from AST; mutability per D2; slot from
  `storageLayout` by astId (omitted when absent, e.g. constants/immutables).
- **Inheritance**: from `linearizedBaseContracts`; base kind `interface` -> `IMPLEMENTS`,
  else `INHERITS`. Bases outside the source set -> UNKNOWN issue, no fabricated edge.
- **Calls**: see 5.3. Builtin/precompile identifiers (`require`, `assert`, `revert`,
  `keccak256`, `ecrecover`, `blockhash`, ...) are skipped (not repo entities).
  Function-pointer/indirect calls -> UNKNOWN, no guessing.
- **Reads/Writes**: see 5.4. One relationship per (type, source, target) with merged
  multi-span provenance.
- **Events**: no Event entity. `Fact {subject: emitting function, predicate: EMITS,
  value: canonical event signature}` + provenance. Intentionally LOSSY.
- **Custom errors**: `Fact {predicate: USES, value: 'custom-error:<canonical signature>'}`.
  `require/revert` string messages skipped (reasoning material, not structure).
- **Modifiers**: invocation text only. No Modifier entity, no USES-to-modifier edge,
  no security semantics. `onlyOwner` is a structural fact, not a trust conclusion.
- **Out of model** (UNSUPPORTED issues): enum/struct/UDVT definitions,
  Yul/assembly bodies, try/catch, msg./block. builtins.

## 8. Error model

| Class | Behavior | Examples |
|---|---|---|
| FATAL | throw ReconError, abort | invalid config, root escape, 0 sources, compiler checksum mismatch, duplicate normalized id, validateReconState failure |
| RECOVERABLE | continue + issue | unreadable/oversized file skipped, compile failure -> stopAfter retry -> still failing file dropped, git unavailable |
| UNKNOWN | fact marker + issue | unresolved dynamic/low-level/indirect calls, base outside source set, missing referencedDeclaration |
| UNSUPPORTED | issue only | Yul, enum/struct definitions, out-of-model constructs |

`ReconIssue` leaves via `AnalysisResult.issues` (tool diagnostics are not epistemic items;
no schema change).

## 9. Idempotency & determinism

Same repo + commit + config + tool version -> byte-identical serialization.
`created_at` for Fact/Relationship is injected from `config.timestamp`
(explicit -> git HEAD committer time -> fixed epoch). Re-run -> same contentIds ->
`saveState` upserts -> row counts unchanged. Source sha256 recorded for future
incremental use (not implemented in Phase 2).

## 10. Testing strategy

TDD (failing test first). Vitest, coverage >= 80% on `src/recon/**`.

- Unit: pragma parsing, version selection, UTF-8 byte->line mapping, IR builder on
  recorded AST, per-extractor on IR fixtures.
- Integration: full `analyzeProject` over fixture Solidity repos (bundled compiler,
  offline after install).
- Determinism: two runs byte-identical; randomized discovery order identical.
- Idempotency: saveState twice -> unchanged row counts.
- Error matrix: >=1 test per class.
- Fidelity: syntactic fallback produces no semantic relationships.
- Security: `../` traversal, absolute escape, symlink escape, oversized file, file count
  cap, checksum mismatch (tampered), cache-only mode, malformed Solidity,
  partial compilation failure.
- Fixture categories: contract/interface/library/abstract, duplicate names, constructor/
  fallback/receive, visibility matrix, overloads, selectors, inheritance diamond,
  interface implementation, internal/external/this/super/new calls, delegatecall/
  staticcall/low-level, unresolved dynamic call, direct/compound/mapping/inherited
  storage reads+writes, constant/immutable, slots, modifiers with args, events, custom
  errors, structs/enums/UDVTs, multi-file imports, broken syntax file, empty contract.

## 11. Phase 2 DoD

1. `analyzeProject(config)` works; state passes `validateReconState`.
2. D1-D3 implemented exactly as approved.
3. Extraction coverage: contracts (incl. interface/library/abstract), all function kinds,
   selectors from compiler evidence, state vars + slots, INHERITS/IMPLEMENTS, calls with
   preserved call kinds, READS/WRITES aggregated, modifier invocations.
4. Provenance complete for every generated fact/relationship (file+lines; never fabricated).
5. UNKNOWN handled conservatively; syntactic fallback cannot fabricate semantics.
6. All four error classes tested; untrusted-repo security suite passes.
7. Determinism (byte-identical) and persistence idempotency pass.
8. Phase 1 tests stay green; `npx tsc --noEmit` clean; coverage target met; Vault E2E passes.
9. Documentation reflects the actual implementation and its limitations.

## 12. Known limitations (documented, intentional)

- Events/custom errors are LOSSY facts (no entities).
- Modifier definitions/bodies out of scope (invocations only).
- Enum/struct/UDVT definitions not modeled (IR-level only).
- Single solc version per analysis run (multi-version batches future work).
- Entity line ranges are string-encoded (`file:lines`), structured lines only on
  facts/relationships; no column precision.
- `require/revert` messages, msg./block. builtins, assembly: out of model.
- Incremental (per-file cache) not implemented; sha256 recorded as groundwork.
- Semantic contract classification (vault/token/proxy...) deferred to future analyzers.
