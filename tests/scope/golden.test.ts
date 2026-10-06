import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isReconError, ReconError, type ReconErrorCode } from '../../src/errors/errors.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { analyzeProjectScoped, type AnalyzeScopedDeps } from '../../src/scope/analyze.js';
import type { ScopeReport } from '../../src/scope/model.js';
import { serializeScopeReport } from '../../src/scope/report.js';

const TIMESTAMP = '2026-01-01T00:00:00Z';
const PROJECT_NAME = 'scope-golden';
const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TMP = tmpdir();
// Environment requirement (golden byte-identity): these tests are pinned to hosts
// where os.tmpdir() resolves to a real directory literally at /tmp (Linux CI and the
// blessing host). renameSync(fresh, FIXTURE_ROOT) above throws EXDEV across
// filesystems, and macOS reports os.tmpdir() as /var/folders/... whose realpath is
// /private/var/folders/... — different manifest bytes, so scope_hash/input_manifest_hash
// would not match the frozen goldens. A TMPDIR override breaks Linux the same way.
// Treat a run failing ONLY in these goldens with hash/scope_hash drift on a
// non-blessed host as an environment mismatch, not a regression.
const FIXTURE_ROOT = join(tmpdir(), 'recon-engine-scope-golden');
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';
const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const TIMESTAMP_KEY = /timestamp|generated_at|date/i;
const GOLDEN_TIMEOUT = 120_000;
const SHORT_TIMEOUT = 60_000;

const CORPUS_NAMES = [
  'clean-vault',
  'mixed-excludes',
  'literal-missing',
  'all-dropped',
  'syntactic-fallback',
  'run-abort',
  'only-excluded',
] as const;
type CorpusName = (typeof CORPUS_NAMES)[number];

const ALPHA_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Alpha {
  uint256 public total;
}
`;

const BETA_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Beta {
  function add(uint256 a, uint256 b) internal pure returns (uint256) {
    return a + b;
  }
}
`;

const OK_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Ok {
  uint256 public value;
}
`;

const BIG_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// ${'pad'.repeat(300)}
contract Big {
  uint256 public big;
}
`;

const LIB_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

library Lib {
  function double(uint256 v) internal pure returns (uint256) {
    return v * 2;
  }
}
`;

const DEP_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Dep {}
`;

const IRRECOVERABLE_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract {{{
`;

const FALLBACK_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Fallback {
  uint256 public counter;

  function bump() external {
    counter += 1;
    undeclared();
  }
}
`;

const A_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract A {}
`;

const B_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract B {}
`;

const C_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract C {}
`;

const VENDOR_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Vendor {}
`;

const INJECTED_ABORT_MESSAGE = 'solidity compilation failed: B.sol: unexpected token';
const INJECTED_ABORT_EVIDENCE_MESSAGE = `[CompilationFailed] ${INJECTED_ABORT_MESSAGE}`;
const INJECTED_ABORT_ISSUE = {
  severity: 'RECOVERABLE',
  code: 'compilation_failed',
  message: 'dropping B.sol: syntax errors prevent parsing',
  file: 'B.sol',
  count: 1,
};

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(files: Record<string, string>): string {
  // Brief calls for fixtures built inline (mkdtempSync + writeFileSync). The fresh
  // mkdtemp dir is renamed to a FIXED temp path because computeManifestHash folds
  // DiscoveredFile.absolute (the fixture's absolute path) into the manifest payload,
  // hence into input_manifest_hash/run_id/scope_hash of every COMPLETED report: with
  // a random mkdtemp root the frozen goldens could never match a later run. The docs
  // document that payload as {path, sha256, bytes} and promise input_manifest_hash is
  // unaffected by the directory portion of root (docs/traceability.md manifest hash),
  // so this workaround pins the root instead of weakening any golden assertion.
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const fresh = mkdtempSync(join(tmpdir(), 'recon-engine-scope-golden-'));
  renameSync(fresh, FIXTURE_ROOT);
  roots.push(FIXTURE_ROOT);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(FIXTURE_ROOT, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return FIXTURE_ROOT;
}

function fixtureConfig(
  files: Record<string, string>,
  overrides: Record<string, unknown> = {},
): ReconConfig {
  return parseReconConfig({
    root: writeFixture(files),
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: PROJECT_NAME,
    ...overrides,
  });
}

interface CorpusSetup {
  config: ReconConfig;
  deps?: AnalyzeScopedDeps;
}

function setupCorpus(name: CorpusName): CorpusSetup {
  switch (name) {
    case 'clean-vault':
      return { config: fixtureConfig({ 'Alpha.sol': ALPHA_SOURCE, 'Beta.sol': BETA_SOURCE }) };
    case 'mixed-excludes':
      return {
        config: fixtureConfig(
          {
            'contracts/Ok.sol': OK_SOURCE,
            'lib/Lib.sol': LIB_SOURCE,
            'big/Big.sol': BIG_SOURCE,
            'node_modules/dep/Dep.sol': DEP_SOURCE,
          },
          { excludes: ['lib/**'], limits: { maxFileBytes: 512 } },
        ),
      };
    case 'literal-missing':
      return {
        config: fixtureConfig(
          { 'contracts/Ok.sol': OK_SOURCE },
          { includes: ['**/*.sol', 'contracts/Ghost.sol'] },
        ),
      };
    case 'all-dropped':
      return { config: fixtureConfig({ 'Broken.sol': IRRECOVERABLE_SOURCE }) };
    case 'syntactic-fallback':
      return { config: fixtureConfig({ 'Fallback.sol': FALLBACK_SOURCE }) };
    case 'run-abort':
      // Only seam-using corpus: no environment-independent real abort exists — which
      // sources a local compiler refuses to parse depends on the installed compiler
      // and environment, so the structured CompilationFailed abort is injected here.
      return {
        config: fixtureConfig(
          { 'A.sol': A_SOURCE, 'B.sol': B_SOURCE, 'C.sol': C_SOURCE },
          { includes: ['**/*.sol', 'Ghost.sol'], excludes: ['C.sol'] },
        ),
        deps: {
          analyze: async () => {
            throw new ReconError('CompilationFailed', INJECTED_ABORT_MESSAGE, {
              issues: [INJECTED_ABORT_ISSUE],
              dropped: ['B.sol'],
            });
          },
        },
      };
    case 'only-excluded':
      return {
        config: fixtureConfig({ 'vendor/V.sol': VENDOR_SOURCE }, { excludes: ['vendor/**'] }),
      };
  }
}

interface CorpusRun {
  report: ScopeReport;
  serialized: string;
  errorCode?: ReconErrorCode;
  errorMessage?: string;
}

async function runCorpus(name: CorpusName): Promise<CorpusRun> {
  const { config, deps } = setupCorpus(name);
  try {
    const { report } = await analyzeProjectScoped(config, deps);
    return { report, serialized: serializeScopeReport(report) };
  } catch (error) {
    if (!isReconError(error)) throw error;
    const scopeReport = error.details.scope_report;
    if (scopeReport === undefined) throw error;
    const report = scopeReport as ScopeReport;
    return {
      report,
      serialized: serializeScopeReport(report),
      errorCode: error.code,
      errorMessage: error.message,
    };
  }
}

function goldenPath(name: CorpusName): string {
  return join(GOLDEN_DIR, `${name}.json`);
}

function missingGolden(name: CorpusName): Error {
  return new Error(
    `missing golden for corpus "${name}" at ${goldenPath(name)} — run UPDATE_GOLDEN=1 to freeze it`,
  );
}

function statuses(report: ScopeReport): [string, string][] {
  return report.entries.map((entry) => [entry.path, entry.status]);
}

function entryOf(report: ScopeReport, path: string) {
  const entry = report.entries.find((item) => item.path === path);
  if (entry === undefined) throw new Error(`no scope entry for ${path}`);
  return entry;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

describe('golden corpus (spec §13 Layer G)', () => {
  it(
    'each corpus matches its frozen golden byte-for-byte',
    async () => {
      for (const name of CORPUS_NAMES) {
        const { serialized } = await runCorpus(name);
        const path = goldenPath(name);
        if (UPDATE_GOLDEN) {
          mkdirSync(GOLDEN_DIR, { recursive: true });
          writeFileSync(path, serialized, 'utf8');
          continue;
        }
        if (!existsSync(path)) throw missingGolden(name);
        const frozen = readFileSync(path, 'utf8').replace(/\r/g, '');
        expect(serialized, `corpus "${name}" drifted from its frozen golden`).toBe(frozen);
      }
    },
    GOLDEN_TIMEOUT,
  );

  it(
    'each corpus serializes byte-identically on a second run',
    async () => {
      for (const name of CORPUS_NAMES) {
        const first = await runCorpus(name);
        const second = await runCorpus(name);
        expect(second.serialized, `corpus "${name}" is not byte-stable across runs`).toBe(
          first.serialized,
        );
      }
    },
    GOLDEN_TIMEOUT,
  );

  it(
    'no golden contains an absolute path or ISO timestamp',
    () => {
      for (const name of CORPUS_NAMES) {
        const path = goldenPath(name);
        if (!existsSync(path)) throw missingGolden(name);
        const raw = readFileSync(path, 'utf8');
        expect(raw, `golden "${name}" must not carry an ISO timestamp`).not.toMatch(ISO_DATE);
        expect(raw, `golden "${name}" must not contain the temp dir`).not.toContain(TMP);
        expect(raw, `golden "${name}" must not contain the fixture root`).not.toContain(
          FIXTURE_ROOT,
        );
        expect(raw, `golden "${name}" must not contain the repository root`).not.toContain(REPO_ROOT);
        const report = JSON.parse(raw) as ScopeReport;
        for (const key of collectKeys(report)) {
          expect(key, `golden "${name}" key ${key} looks timestamp-shaped`).not.toMatch(
            TIMESTAMP_KEY,
          );
        }
        for (const value of collectStrings(report)) {
          expect(value.startsWith('/'), `golden "${name}" value ${value} is absolute`).toBe(false);
          expect(value.includes('\\'), `golden "${name}" value ${value} contains a backslash`).toBe(
            false,
          );
        }
      }
    },
    SHORT_TIMEOUT,
  );

  it(
    'explicit partition assertions',
    async () => {
      const clean = await runCorpus('clean-vault');
      expect(clean.errorCode).toBeUndefined();
      expect(clean.report.run_status).toBe('COMPLETED');
      expect(clean.report.run_fidelity).toBe('semantic');
      expect(clean.report.failed_stage).toBeUndefined();
      expect(clean.report.run).not.toBeNull();
      expect(statuses(clean.report)).toEqual([
        ['Alpha.sol', 'ANALYZED'],
        ['Beta.sol', 'ANALYZED'],
      ]);
      expect(clean.report.counts).toEqual({
        expected: 2,
        analyzed: 2,
        excluded: 0,
        not_found: 0,
        unresolved: 0,
        unsupported: 0,
        failed: 0,
      });
      expect(clean.report.metrics).toEqual({
        clean_coverage: { n: 2, d: 2 },
        resolution_completeness: { n: 2, d: 2 },
        unsupported_rate: { n: 0, d: 2 },
        failed_rate: { n: 0, d: 2 },
        not_found_rate: { n: 0, d: 2 },
        excluded_by_rule: [],
        fallback_count: 0,
      });

      const mixed = await runCorpus('mixed-excludes');
      expect(mixed.errorCode).toBeUndefined();
      expect(mixed.report.run_status).toBe('COMPLETED');
      expect(mixed.report.run_fidelity).toBe('semantic');
      expect(mixed.report.failed_stage).toBeUndefined();
      expect(mixed.report.run).not.toBeNull();
      expect(statuses(mixed.report)).toEqual([
        ['big/Big.sol', 'EXCLUDED'],
        ['contracts/Ok.sol', 'ANALYZED'],
        ['lib/Lib.sol', 'EXCLUDED'],
        ['node_modules', 'EXCLUDED'],
      ]);
      expect(entryOf(mixed.report, 'big/Big.sol').evidence).toEqual([
        { kind: 'size_limit', limit_bytes: 512 },
      ]);
      expect(entryOf(mixed.report, 'lib/Lib.sol').evidence).toEqual([
        { kind: 'exclude_rule', rule: 'config:excludes:lib/**' },
      ]);
      expect(entryOf(mixed.report, 'node_modules').evidence).toEqual([
        { kind: 'exclude_rule', rule: 'always:node_modules' },
      ]);
      expect(mixed.report.counts).toEqual({
        expected: 1,
        analyzed: 1,
        excluded: 3,
        not_found: 0,
        unresolved: 0,
        unsupported: 0,
        failed: 0,
      });
      expect(mixed.report.metrics).toEqual({
        clean_coverage: { n: 1, d: 1 },
        resolution_completeness: { n: 1, d: 1 },
        unsupported_rate: { n: 0, d: 1 },
        failed_rate: { n: 0, d: 1 },
        not_found_rate: { n: 0, d: 1 },
        excluded_by_rule: [
          { rule: 'always:node_modules', count: 1 },
          { rule: 'config:excludes:lib/**', count: 1 },
          { rule: 'limit:maxFileBytes', count: 1 },
        ],
        fallback_count: 0,
      });

      const missing = await runCorpus('literal-missing');
      expect(missing.errorCode).toBeUndefined();
      expect(missing.report.run_status).toBe('COMPLETED');
      expect(missing.report.run_fidelity).toBe('semantic');
      expect(missing.report.failed_stage).toBeUndefined();
      expect(missing.report.run).not.toBeNull();
      expect(statuses(missing.report)).toEqual([
        ['contracts/Ghost.sol', 'NOT_FOUND'],
        ['contracts/Ok.sol', 'ANALYZED'],
      ]);
      expect(entryOf(missing.report, 'contracts/Ghost.sol').evidence).toEqual([
        { kind: 'walk_miss', include: 'contracts/Ghost.sol' },
      ]);
      expect(missing.report.counts).toEqual({
        expected: 2,
        analyzed: 1,
        excluded: 0,
        not_found: 1,
        unresolved: 0,
        unsupported: 0,
        failed: 0,
      });
      expect(missing.report.metrics.clean_coverage).toEqual({ n: 1, d: 2 });
      expect(missing.report.metrics.not_found_rate).toEqual({ n: 1, d: 2 });
      expect(missing.report.metrics.fallback_count).toBe(0);
      expect(missing.report.metrics.excluded_by_rule).toEqual([]);

      const dropped = await runCorpus('all-dropped');
      expect(dropped.errorCode).toBe('CompilationFailed');
      expect(dropped.errorMessage).toContain('no source survived');
      expect(dropped.report.run_status).toBe('FAILED');
      expect(dropped.report.run).toBeNull();
      expect(dropped.report.failed_stage).toBe('compile');
      expect(dropped.report.run_fidelity).toBeUndefined();
      expect(statuses(dropped.report)).toEqual([['Broken.sol', 'UNSUPPORTED']]);
      expect(dropped.report.counts).toEqual({
        expected: 1,
        analyzed: 0,
        excluded: 0,
        not_found: 0,
        unresolved: 0,
        unsupported: 1,
        failed: 0,
      });
      expect(dropped.report.metrics.clean_coverage).toEqual({ n: 0, d: 1 });
      expect(dropped.report.metrics.unsupported_rate).toEqual({ n: 1, d: 1 });
      expect(dropped.report.metrics.failed_rate).toEqual({ n: 0, d: 1 });
      expect(dropped.report.metrics.fallback_count).toBe(1);

      const fallback = await runCorpus('syntactic-fallback');
      expect(fallback.errorCode).toBeUndefined();
      expect(fallback.report.run_status).toBe('COMPLETED');
      expect(fallback.report.run_fidelity).toBe('syntactic');
      expect(fallback.report.failed_stage).toBeUndefined();
      expect(fallback.report.run).not.toBeNull();
      expect(statuses(fallback.report)).toEqual([['Fallback.sol', 'UNRESOLVED']]);
      expect(fallback.report.counts).toEqual({
        expected: 1,
        analyzed: 0,
        excluded: 0,
        not_found: 0,
        unresolved: 1,
        unsupported: 0,
        failed: 0,
      });
      expect(fallback.report.metrics.fallback_count).toBe(1);
      expect(fallback.report.metrics.clean_coverage).toEqual({ n: 0, d: 1 });
      expect(fallback.report.metrics.resolution_completeness).toEqual({ n: 0, d: 1 });
      const fallbackEvidence = entryOf(fallback.report, 'Fallback.sol').evidence;
      expect(fallbackEvidence.some((item) => item.kind === 'analysis')).toBe(true);
      const fallbackIssues = fallbackEvidence.filter(
        (item) => item.kind === 'issue' && item.issue.code === 'syntactic_fallback',
      );
      expect(fallbackIssues).toHaveLength(1);
      const unknownIssues = fallbackEvidence.filter(
        (item) => item.kind === 'issue' && item.issue.severity === 'UNKNOWN',
      );
      expect(unknownIssues.length).toBeGreaterThan(0);

      const aborted = await runCorpus('run-abort');
      expect(aborted.errorCode).toBe('CompilationFailed');
      expect(aborted.report.run_status).toBe('FAILED');
      expect(aborted.report.run).toBeNull();
      expect(aborted.report.failed_stage).toBe('compile');
      expect(aborted.report.run_fidelity).toBeUndefined();
      expect(statuses(aborted.report)).toEqual([
        ['A.sol', 'FAILED'],
        ['B.sol', 'UNSUPPORTED'],
        ['C.sol', 'EXCLUDED'],
        ['Ghost.sol', 'NOT_FOUND'],
      ]);
      expect(entryOf(aborted.report, 'A.sol').evidence).toEqual([
        {
          kind: 'run_error',
          stage: 'compile',
          error_class: 'CompilationFailed',
          message: INJECTED_ABORT_EVIDENCE_MESSAGE,
        },
      ]);
      expect(entryOf(aborted.report, 'B.sol').evidence).toEqual([
        { kind: 'issue', issue: INJECTED_ABORT_ISSUE },
      ]);
      expect(entryOf(aborted.report, 'C.sol').evidence).toEqual([
        { kind: 'exclude_rule', rule: 'config:excludes:C.sol' },
      ]);
      expect(entryOf(aborted.report, 'Ghost.sol').evidence).toEqual([
        { kind: 'walk_miss', include: 'Ghost.sol' },
      ]);
      expect(aborted.report.counts).toEqual({
        expected: 3,
        analyzed: 0,
        excluded: 1,
        not_found: 1,
        unresolved: 0,
        unsupported: 1,
        failed: 1,
      });
      expect(aborted.report.metrics).toEqual({
        clean_coverage: { n: 0, d: 3 },
        resolution_completeness: { n: 1, d: 1 },
        unsupported_rate: { n: 1, d: 3 },
        failed_rate: { n: 1, d: 3 },
        not_found_rate: { n: 1, d: 3 },
        excluded_by_rule: [{ rule: 'config:excludes:C.sol', count: 1 }],
        fallback_count: 0,
      });

      const only = await runCorpus('only-excluded');
      expect(only.errorCode).toBe('NoSourcesFound');
      expect(only.report.run_status).toBe('FAILED');
      expect(only.report.run).toBeNull();
      expect(only.report.failed_stage).toBe('discover');
      expect(only.report.run_fidelity).toBeUndefined();
      expect(statuses(only.report)).toEqual([['vendor/V.sol', 'EXCLUDED']]);
      expect(entryOf(only.report, 'vendor/V.sol').evidence).toEqual([
        { kind: 'exclude_rule', rule: 'config:excludes:vendor/**' },
      ]);
      expect(only.report.counts).toEqual({
        expected: 0,
        analyzed: 0,
        excluded: 1,
        not_found: 0,
        unresolved: 0,
        unsupported: 0,
        failed: 0,
      });
      expect(only.report.metrics).toEqual({
        clean_coverage: { n: 1, d: 1 },
        resolution_completeness: { n: 1, d: 1 },
        unsupported_rate: { n: 0, d: 1 },
        failed_rate: { n: 0, d: 1 },
        not_found_rate: { n: 0, d: 1 },
        excluded_by_rule: [{ rule: 'config:excludes:vendor/**', count: 1 }],
        fallback_count: 0,
      });
    },
    GOLDEN_TIMEOUT,
  );

  it(
    'run_status and entry status are orthogonal',
    async () => {
      const dropped = await runCorpus('all-dropped');
      expect(dropped.report.run_status).toBe('FAILED');
      expect(dropped.report.counts.failed).toBe(0);
      expect(dropped.report.counts.unsupported).toBe(1);

      const aborted = await runCorpus('run-abort');
      expect(aborted.report.run_status).toBe('FAILED');
      expect(aborted.report.counts.failed).toBe(1);
      expect(aborted.report.counts.unsupported).toBe(1);

      const clean = await runCorpus('clean-vault');
      expect(clean.report.run_status).toBe('COMPLETED');
      expect(clean.report.run).not.toBeNull();
      expect(clean.report.counts.failed).toBe(0);
      expect(statuses(clean.report)).toEqual([
        ['Alpha.sol', 'ANALYZED'],
        ['Beta.sol', 'ANALYZED'],
      ]);
    },
    SHORT_TIMEOUT,
  );
});
