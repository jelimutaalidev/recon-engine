import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isReconError, ReconError, type ReconErrorCode } from '../../src/errors/errors.js';
import { analyzeProjectScoped, mapErrorToStage } from '../../src/scope/analyze.js';
import type { ScopeReport } from '../../src/scope/model.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import { validateScopeReport } from '../../src/scope/validate.js';

const TIMESTAMP = '2026-01-01T00:00:00Z';
const PROJECT_NAME = 'scoped-fixture';

const SIMPLE_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Simple {
  uint256 public counter;
}
`;

const roots: string[] = [];

function fixtureConfig(
  files: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
): ReconConfig {
  const root = mkdtempSync(join(tmpdir(), 'recon-analyze-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return parseReconConfig({
    root,
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: PROJECT_NAME,
    ...overrides,
  });
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

async function reconRejectionOf(promise: Promise<unknown>): Promise<ReconError> {
  const error = await rejectionOf(promise);
  if (!isReconError(error)) {
    throw new Error(`expected a ReconError, got ${String(error)}`);
  }
  return error;
}

function scopeReportOf(error: ReconError): ScopeReport {
  const report = error.details.scope_report;
  if (report === undefined) {
    throw new Error('expected details.scope_report to be attached');
  }
  expect(validateScopeReport(report)).toEqual(report);
  return report as ScopeReport;
}

function reconIssue(over: Partial<ReconIssue> = {}): ReconIssue {
  return { severity: 'RECOVERABLE', code: 'note', message: 'issue message', ...over };
}

function statuses(report: ScopeReport): [string, string][] {
  return report.entries.map((entry) => [entry.path, entry.status]);
}

describe('mapErrorToStage', () => {
  it('maps discover codes', () => {
    for (const code of ['NoSourcesFound', 'SourceLimitExceeded', 'RootEscape'] as const) {
      expect(mapErrorToStage(new ReconError(code, 'boom'))).toBe('discover');
    }
  });

  it('maps compile codes', () => {
    for (const code of ['CompilationFailed', 'CompilerUnavailable'] as const) {
      expect(mapErrorToStage(new ReconError(code, 'boom'))).toBe('compile');
    }
  });

  it('maps all other codes to analysis', () => {
    const discoverOrCompile: ReconErrorCode[] = [
      'NoSourcesFound',
      'SourceLimitExceeded',
      'RootEscape',
      'CompilationFailed',
      'CompilerUnavailable',
    ];
    const all: ReconErrorCode[] = [
      'SchemaValidationFailed',
      'InvalidIdentifier',
      'InvalidRelationshipSource',
      'InvalidRelationshipTarget',
      'UnsupportedRelationshipType',
      'MissingProvenance',
      'InvalidProvenance',
      'InvalidEpistemicDependency',
      'DuplicateCanonicalEntity',
      'UnsupportedSchemaVersion',
      'InvalidSourceReference',
      'InvalidEvidenceReference',
      'ConflictingEvidence',
      'InvalidConfidence',
      'EntityNotFound',
      'InvalidReconState',
      'MigrationError',
      'RootEscape',
      'SourceLimitExceeded',
      'NoSourcesFound',
      'CompilerUnavailable',
      'VersionConflict',
      'ChecksumMismatch',
      'CompilationFailed',
      'InvalidScopeReport',
    ];
    const others = all.filter((code) => !discoverOrCompile.includes(code));
    expect(others).toContain('InvalidReconState');
    expect(others).toContain('MigrationError');
    expect(
      Object.fromEntries(
        others.map((code) => [code, mapErrorToStage(new ReconError(code, 'boom'))]),
      ),
    ).toEqual(Object.fromEntries(others.map((code) => [code, 'analysis'])));
  });

  it('non-ReconError maps to analysis', () => {
    expect(mapErrorToStage(new TypeError('boom'))).toBe('analysis');
    expect(mapErrorToStage(new Error('boom'))).toBe('analysis');
    expect(mapErrorToStage('boom')).toBe('analysis');
    expect(mapErrorToStage(undefined)).toBe('analysis');
  });
});

describe('analyzeProjectScoped — branch 1 (inventory completed, analysis failed)', () => {
  it('unattributable CompilationFailed marks on-disk entries FAILED, not UNSUPPORTED', async () => {
    const config = fixtureConfig(
      {
        'src/A.sol': 'contract A {}',
        'src/B.sol': 'contract B {}',
        'src/C.sol': 'contract C {}',
      },
      { includes: ['**/*.sol', 'src/Ghost.sol'], excludes: ['src/C.sol'] },
    );
    const original = new ReconError(
      'CompilationFailed',
      'solidity compilation failed: src/B.sol: unexpected token',
      {
        issues: [
          reconIssue({
            code: 'compilation_failed',
            message: 'dropping src/Other.sol: syntax errors prevent parsing',
            file: 'src/Other.sol',
            count: 1,
          }),
        ],
        dropped: [],
      },
    );

    const error = await reconRejectionOf(
      analyzeProjectScoped(config, {
        analyze: async () => {
          throw original;
        },
      }),
    );

    expect(error).not.toBe(original);
    expect(error.code).toBe('CompilationFailed');
    expect(error.message).toBe(original.message);
    expect(error.details.dropped).toEqual([]);
    expect(error.details.issues).toEqual(original.details.issues);

    const report = scopeReportOf(error);
    expect(report.run_status).toBe('FAILED');
    expect(report.run).toBeNull();
    expect(report.failed_stage).toBe('compile');
    expect(statuses(report)).toEqual([
      ['src/A.sol', 'FAILED'],
      ['src/B.sol', 'FAILED'],
      ['src/C.sol', 'EXCLUDED'],
      ['src/Ghost.sol', 'NOT_FOUND'],
    ]);
    expect(report.entries.some((entry) => entry.status === 'UNSUPPORTED')).toBe(false);
    expect(report.counts).toEqual({
      expected: 3,
      analyzed: 0,
      excluded: 1,
      not_found: 1,
      unresolved: 0,
      unsupported: 0,
      failed: 2,
    });

    const entryB = report.entries.find((entry) => entry.path === 'src/B.sol');
    expect(entryB?.evidence).toEqual([
      {
        kind: 'run_error',
        stage: 'compile',
        error_class: 'CompilationFailed',
        message: original.message,
      },
    ]);
  });

  it('dropped path derives UNSUPPORTED under structured attribution', async () => {
    const config = fixtureConfig({
      'src/A.sol': 'contract A {}',
      'src/B.sol': 'contract B {}',
    });
    const original = new ReconError('CompilationFailed', 'no source survived compilation', {
      issues: [
        reconIssue({
          code: 'compilation_failed',
          message: 'dropping src/B.sol: syntax errors prevent parsing',
          file: 'src/B.sol',
          count: 1,
        }),
      ],
      dropped: ['src/B.sol'],
    });

    const error = await reconRejectionOf(
      analyzeProjectScoped(config, {
        analyze: async () => {
          throw original;
        },
      }),
    );

    const report = scopeReportOf(error);
    expect(statuses(report)).toEqual([
      ['src/A.sol', 'FAILED'],
      ['src/B.sol', 'UNSUPPORTED'],
    ]);
    expect(report.counts.unsupported).toBe(1);
    expect(report.counts.failed).toBe(1);

    const entryB = report.entries.find((entry) => entry.path === 'src/B.sol');
    expect(entryB?.evidence).toEqual([
      {
        kind: 'issue',
        issue: {
          code: 'compilation_failed',
          severity: 'RECOVERABLE',
          message: 'dropping src/B.sol: syntax errors prevent parsing',
          file: 'src/B.sol',
          count: 1,
        },
      },
    ]);
  });

  it('CompilerUnavailable yields failed_stage compile with all on-disk entries FAILED', async () => {
    const config = fixtureConfig({
      'A.sol': 'contract A {}',
      'B.sol': 'contract B {}',
    });
    const original = new ReconError('CompilerUnavailable', 'no solidity compiler available', {
      version: '0.8.20',
    });

    const error = await reconRejectionOf(
      analyzeProjectScoped(config, {
        analyze: async () => {
          throw original;
        },
      }),
    );

    expect(error.code).toBe('CompilerUnavailable');
    expect(error.message).toBe(original.message);
    expect(error.details.version).toBe('0.8.20');

    const report = scopeReportOf(error);
    expect(report.run_status).toBe('FAILED');
    expect(report.failed_stage).toBe('compile');
    expect(report.run).toBeNull();
    expect(statuses(report)).toEqual([
      ['A.sol', 'FAILED'],
      ['B.sol', 'FAILED'],
    ]);
    expect(report.counts.failed).toBe(2);
    expect(report.counts.analyzed).toBe(0);
    expect(report.counts.unresolved).toBe(0);
    for (const entry of report.entries) {
      expect(entry.evidence).toEqual([
        {
          kind: 'run_error',
          stage: 'compile',
          error_class: 'CompilerUnavailable',
          message: original.message,
        },
      ]);
    }
  });

  it('NoSourcesFound real fixture yields valid failed=0 report', async () => {
    const config = fixtureConfig({}, { includes: ['**/*.sol', 'Ghost.sol'] });

    const error = await reconRejectionOf(analyzeProjectScoped(config));
    expect(error.code).toBe('NoSourcesFound');
    expect(error.message.startsWith('[NoSourcesFound] ')).toBe(true);
    expect(error.message.slice('[NoSourcesFound] '.length).startsWith('[NoSourcesFound] ')).toBe(
      false,
    );

    const report = scopeReportOf(error);
    expect(report.run_status).toBe('FAILED');
    expect(report.run).toBeNull();
    expect(report.failed_stage).toBe('discover');
    expect(report.counts.failed).toBe(0);
    expect(report.counts.expected).toBe(1);
    expect(report.counts.not_found).toBe(report.counts.expected);
    expect(report.entries).toEqual([
      {
        target_type: 'source_file',
        path: 'Ghost.sol',
        status: 'NOT_FOUND',
        evidence: [{ kind: 'walk_miss', include: 'Ghost.sol' }],
      },
    ]);
  });

  it('non-ReconError propagates without a report', async () => {
    const config = fixtureConfig({ 'A.sol': 'contract A {}' });
    const boom = new TypeError('boom');

    const error = await rejectionOf(
      analyzeProjectScoped(config, {
        analyze: async () => {
          throw boom;
        },
      }),
    );

    expect(error).toBe(boom);
    expect(isReconError(error)).toBe(false);
    expect((error as TypeError & { details?: unknown }).details).toBeUndefined();
  });
});

describe('analyzeProjectScoped — branch 2 (inventory failed)', () => {
  it('inventory failure rethrows without a fabricated scope_report', async () => {
    const limited = fixtureConfig(
      { 'A.sol': 'contract A {}', 'B.sol': 'contract B {}' },
      { limits: { maxFiles: 1 } },
    );
    const limitError = await reconRejectionOf(analyzeProjectScoped(limited));
    expect(limitError.code).toBe('SourceLimitExceeded');
    expect(limitError.details.scope_report).toBeUndefined();
    expect('scope_report' in limitError.details).toBe(false);

    const escapeConfig = fixtureConfig();
    const outside = mkdtempSync(join(tmpdir(), 'recon-analyze-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'Evil.sol'), 'contract Evil {}');
    symlinkSync(outside, join(escapeConfig.root, 'linkdir'), 'junction');
    const escapeError = await reconRejectionOf(analyzeProjectScoped(escapeConfig));
    expect(escapeError.code).toBe('RootEscape');
    expect(escapeError.details.scope_report).toBeUndefined();
    expect('scope_report' in escapeError.details).toBe(false);
  });
});

describe('analyzeProjectScoped — success', () => {
  it('success smoke: structurally valid report with run bound', async () => {
    const config = fixtureConfig({ 'Simple.sol': SIMPLE_SOURCE });

    const { result, report } = await analyzeProjectScoped(config);

    expect(result.meta.fileCount).toBe(1);
    expect(result.meta.fidelity).toBe('semantic');
    expect(result.state.project?.name).toBe(PROJECT_NAME);

    expect(report.run_status).toBe('COMPLETED');
    expect(report.run_fidelity).toBe(result.meta.fidelity);
    expect(report.failed_stage).toBeUndefined();
    expect(report.counts.failed).toBe(0);
    expect(report.counts.analyzed + report.counts.unresolved).toBe(1);
    expect(report.entries.map((entry) => entry.path)).toEqual(['Simple.sol']);
    expect(['ANALYZED', 'UNRESOLVED']).toContain(report.entries[0]?.status);

    const outputHash = computeOutputIdentity(result.state).output_hash;
    const currentRun = result.state.traceability?.runs.find(
      (run) => run.output_identity?.output_hash === outputHash,
    );
    expect(currentRun).toBeDefined();
    if (currentRun === undefined || currentRun.output_identity === undefined) {
      throw new Error('expected a current run on the state');
    }
    expect(report.run).toEqual({
      run_id: currentRun.id,
      input_manifest_hash: currentRun.input_manifest_hash,
      output_hash: currentRun.output_identity.output_hash,
    });

    expect(validateScopeReport(report)).toEqual(report);
    expect(report.scope_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
