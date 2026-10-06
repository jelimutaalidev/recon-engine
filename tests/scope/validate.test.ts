import { describe, expect, it } from 'vitest';
import { ReconError } from '../../src/errors/errors.js';
import { computeCounts, computeMetrics } from '../../src/scope/metrics.js';
import type {
  EmbeddedIssue,
  ScopeCounts,
  ScopeEntry,
  ScopeEvidence,
  ScopeReport,
} from '../../src/scope/model.js';
import { validateScopeReport } from '../../src/scope/validate.js';

const SHA = 'a'.repeat(64);
const SCOPE_HASH = 'b'.repeat(64);

function issueEvidence(over: Partial<EmbeddedIssue> & { file: string }): ScopeEvidence {
  return {
    kind: 'issue',
    issue: { code: 'call_target_unresolved', severity: 'RECOVERABLE', message: 'msg', count: 1, ...over },
  };
}

function entry(
  status: ScopeEntry['status'],
  path: string,
  evidence: readonly ScopeEvidence[],
): ScopeEntry {
  return { target_type: 'source_file', path, status, evidence: [...evidence] };
}

const ANALYZED = entry('ANALYZED', 'contracts/A.sol', [{ kind: 'analysis', sha256: SHA }]);
const EXCLUDED = entry('EXCLUDED', 'vendor/V.sol', [
  { kind: 'exclude_rule', rule: 'config:excludes:vendor/**' },
]);
const NOT_FOUND = entry('NOT_FOUND', 'contracts/Ghost.sol', [
  { kind: 'walk_miss', include: 'contracts/Ghost.sol' },
]);
const UNRESOLVED = entry('UNRESOLVED', 'contracts/B.sol', [
  { kind: 'analysis', sha256: SHA },
  issueEvidence({ file: 'contracts/B.sol', severity: 'UNKNOWN' }),
]);
const UNSUPPORTED = entry('UNSUPPORTED', 'contracts/C.sol', [
  issueEvidence({ file: 'contracts/C.sol', code: 'compilation_failed', severity: 'RECOVERABLE' }),
]);
const FAILED = entry('FAILED', 'contracts/D.sol', [
  { kind: 'run_error', stage: 'compile', error_class: 'CompilationFailed', message: 'boom' },
]);

// INV-9-clean COMPLETED fixture: every rejected test using this base has exactly
// one violation class, so asserted `reason` values never depend on check order.
function fiveStatuses(): ScopeEntry[] {
  return [ANALYZED, UNRESOLVED, UNSUPPORTED, NOT_FOUND, EXCLUDED];
}

function report(entries: ScopeEntry[], over: Partial<ScopeReport> = {}): ScopeReport {
  return {
    schema_version: 'scope-report/v1',
    run: { run_id: 'run:1', input_manifest_hash: 'manifest', output_hash: 'output' },
    run_status: 'COMPLETED',
    run_fidelity: 'semantic',
    counts: computeCounts(entries),
    entries,
    metrics: computeMetrics(entries),
    scope_hash: SCOPE_HASH,
    ...over,
  };
}

function failedReport(entries: ScopeEntry[], over: Partial<ScopeReport> = {}): ScopeReport {
  const { run_fidelity: _omit, ...base } = report(entries, over);
  return { ...base, run: null, run_status: 'FAILED', failed_stage: 'compile', ...over };
}

function expectInvalid(value: unknown, reason: string): void {
  let caught: unknown;
  try {
    validateScopeReport(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReconError);
  const recon = caught as ReconError;
  expect(recon.code).toBe('InvalidScopeReport');
  expect(recon.details.reason).toBe(reason);
}

describe('validateScopeReport', () => {
  it('valid COMPLETED report round-trips with five target-accounting statuses', () => {
    const valid = report(fiveStatuses());
    expect(valid.counts.failed).toBe(0);
    expect(validateScopeReport(valid)).toEqual(valid);
  });

  it('valid FAILED report round-trips with failure statuses', () => {
    const valid = failedReport([UNSUPPORTED, FAILED, NOT_FOUND, EXCLUDED]);
    expect(valid.counts.analyzed).toBe(0);
    expect(valid.counts.unresolved).toBe(0);
    expect(valid.counts.failed).toBe(1);
    expect(validateScopeReport(valid)).toEqual(valid);
  });

  describe('rejected', () => {
    it('unknown keys', () => {
      expectInvalid({ ...report(fiveStatuses()), generated_at: '2026-01-01T00:00:00Z' }, 'schema');
    });

    it('counts not summing', () => {
      const entries = fiveStatuses();
      expectInvalid(
        report(entries, { counts: { ...computeCounts(entries), analyzed: 2 } }),
        'counts_inconsistent',
      );
      expectInvalid(
        report(entries, { counts: { ...computeCounts(entries), expected: 3 } }),
        'counts_inconsistent',
      );
    });

    it('duplicate entry', () => {
      expectInvalid(report([...fiveStatuses(), { ...ANALYZED }]), 'duplicate_entry');
    });

    it('ANALYZED with UNKNOWN evidence', () => {
      const entries = fiveStatuses();
      entries[0] = entry('ANALYZED', 'contracts/A.sol', [
        { kind: 'analysis', sha256: SHA },
        issueEvidence({ file: 'contracts/A.sol', severity: 'UNKNOWN' }),
      ]);
      expectInvalid(report(entries), 'evidence_contradicted');
    });

    it('ANALYZED with compilation_failed evidence', () => {
      const entries = fiveStatuses();
      entries[0] = entry('ANALYZED', 'contracts/A.sol', [
        { kind: 'analysis', sha256: SHA },
        issueEvidence({ file: 'contracts/A.sol', code: 'compilation_failed' }),
      ]);
      expectInvalid(report(entries), 'evidence_contradicted');
    });

    it('UNRESOLVED without attributable UNKNOWN', () => {
      const entries = fiveStatuses();
      entries[1] = entry('UNRESOLVED', 'contracts/B.sol', [
        { kind: 'analysis', sha256: SHA },
        issueEvidence({ file: 'contracts/B.sol', code: 'syntactic_fallback', severity: 'RECOVERABLE' }),
      ]);
      expectInvalid(report(entries), 'evidence_missing');
    });

    it('UNRESOLVED with other-file UNKNOWN evidence', () => {
      const entries = fiveStatuses();
      entries[1] = entry('UNRESOLVED', 'contracts/B.sol', [
        { kind: 'analysis', sha256: SHA },
        issueEvidence({ file: 'contracts/A.sol', severity: 'UNKNOWN' }),
      ]);
      expectInvalid(report(entries), 'issue_attribution');
    });

    it('UNSUPPORTED without compilation_failed', () => {
      const entries = fiveStatuses();
      entries[2] = entry('UNSUPPORTED', 'contracts/C.sol', [{ kind: 'analysis', sha256: SHA }]);
      expectInvalid(report(entries), 'evidence_missing');
    });

    it('FAILED without run_error', () => {
      const brokenFailed = entry('FAILED', 'contracts/D.sol', [{ kind: 'analysis', sha256: SHA }]);
      expectInvalid(
        failedReport([UNSUPPORTED, brokenFailed, NOT_FOUND, EXCLUDED]),
        'evidence_missing',
      );
    });

    it('non-relative path', () => {
      expectInvalid(
        report([entry('ANALYZED', '../outside/E.sol', [{ kind: 'analysis', sha256: SHA }])]),
        'path_not_root_relative',
      );
      expectInvalid(
        report([entry('ANALYZED', 'contracts\\E.sol', [{ kind: 'analysis', sha256: SHA }])]),
        'path_not_root_relative',
      );
    });

    it('absolute path', () => {
      expectInvalid(
        report([entry('ANALYZED', '/contracts/E.sol', [{ kind: 'analysis', sha256: SHA }])]),
        'path_not_root_relative',
      );
    });

    it('ANALYZED on FAILED report', () => {
      const entries = [ANALYZED, UNSUPPORTED, FAILED, NOT_FOUND, EXCLUDED];
      expectInvalid(failedReport(entries), 'run_binding');
    });

    it('UNRESOLVED on FAILED report', () => {
      const entries = [UNRESOLVED, UNSUPPORTED, FAILED, NOT_FOUND, EXCLUDED];
      expectInvalid(failedReport(entries), 'run_binding');
    });

    it('missing run_fidelity on COMPLETED', () => {
      const { run_fidelity: _omit, ...withoutFidelity } = report(fiveStatuses());
      expectInvalid(withoutFidelity, 'run_binding');
    });

    it('stale metric rollup', () => {
      const entries = fiveStatuses();
      expectInvalid(
        report(entries, {
          metrics: { ...computeMetrics(entries), clean_coverage: { n: 0, d: 1 } },
        }),
        'rollup_mismatch',
      );
      const counts: ScopeCounts = { ...computeCounts(entries) };
      counts.analyzed = 0;
      counts.unresolved = 2;
      expectInvalid(report(entries, { counts }), 'rollup_mismatch');
    });

    it('missing clean_coverage', () => {
      const valid = report(fiveStatuses());
      const { clean_coverage: _omit, ...metricsWithoutCoverage } = valid.metrics;
      expectInvalid({ ...valid, metrics: metricsWithoutCoverage }, 'schema');
    });

    it('unsorted entries rejected', () => {
      const sorted = fiveStatuses();
      const shuffled = [sorted[1]!, sorted[0]!, ...sorted.slice(2)];
      expectInvalid(report(shuffled), 'entries_unsorted');
    });

    it('EXCLUDED entry with two exclusion evidence items rejected', () => {
      const entries = fiveStatuses().map((e) =>
        e.path === 'vendor/V.sol'
          ? entry('EXCLUDED', 'vendor/V.sol', [
              { kind: 'exclude_rule', rule: 'config:excludes:vendor/**' },
              { kind: 'size_limit', limit_bytes: 512 },
            ])
          : e,
      );
      expectInvalid(report(entries), 'evidence_contradicted');
    });

    it('evidence kinds outside the status whitelist rejected', () => {
      const unsupportedWithAnalysis = fiveStatuses().map((e) =>
        e.path === 'contracts/C.sol'
          ? entry('UNSUPPORTED', 'contracts/C.sol', [
              issueEvidence({ file: 'contracts/C.sol', code: 'compilation_failed' }),
              { kind: 'analysis', sha256: SHA },
            ])
          : e,
      );
      expectInvalid(report(unsupportedWithAnalysis), 'evidence_contradicted');

      const unresolvedWithRunError = fiveStatuses().map((e) =>
        e.path === 'contracts/B.sol'
          ? entry('UNRESOLVED', 'contracts/B.sol', [
              { kind: 'analysis', sha256: SHA },
              issueEvidence({ file: 'contracts/B.sol', severity: 'UNKNOWN' }),
              { kind: 'run_error', stage: 'analysis', error_class: 'Boom', message: 'x' },
            ])
          : e,
      );
      expectInvalid(report(unresolvedWithRunError), 'evidence_contradicted');

      const excludedWithRunError = fiveStatuses().map((e) =>
        e.path === 'vendor/V.sol'
          ? entry('EXCLUDED', 'vendor/V.sol', [
              { kind: 'exclude_rule', rule: 'config:excludes:vendor/**' },
              { kind: 'run_error', stage: 'analysis', error_class: 'Boom', message: 'x' },
            ])
          : e,
      );
      expectInvalid(report(excludedWithRunError), 'evidence_contradicted');

      const analyzedWithWalkMiss = fiveStatuses().map((e) =>
        e.path === 'contracts/A.sol'
          ? entry('ANALYZED', 'contracts/A.sol', [
              { kind: 'analysis', sha256: SHA },
              { kind: 'walk_miss', include: 'contracts/A.sol' },
            ])
          : e,
      );
      expectInvalid(report(analyzedWithWalkMiss), 'evidence_contradicted');
    });

    it('ANALYZED entry with a non-syntactic_fallback issue rejected', () => {
      const entries = fiveStatuses().map((e) =>
        e.path === 'contracts/A.sol'
          ? entry('ANALYZED', 'contracts/A.sol', [
              { kind: 'analysis', sha256: SHA },
              issueEvidence({ file: 'contracts/A.sol' }),
            ])
          : e,
      );
      expectInvalid(report(entries), 'evidence_contradicted');
    });

    it('FAILED entry with a non-run_error extra rejected', () => {
      const failedWithIssue = failedReport([
        UNSUPPORTED,
        entry('FAILED', 'contracts/D.sol', [
          { kind: 'run_error', stage: 'compile', error_class: 'CompilationFailed', message: 'boom' },
          issueEvidence({ file: 'contracts/D.sol', code: 'compilation_failed' }),
        ]),
        NOT_FOUND,
        EXCLUDED,
      ]);
      expectInvalid(failedWithIssue, 'evidence_contradicted');
    });
  });

  describe('accepted', () => {
    it('all-unsupported FAILED report with failed = 0', () => {
      const entries = [
        entry('UNSUPPORTED', 'contracts/C.sol', [
          issueEvidence({ file: 'contracts/C.sol', code: 'compilation_failed' }),
        ]),
        entry('UNSUPPORTED', 'contracts/E.sol', [
          issueEvidence({ file: 'contracts/E.sol', code: 'compilation_failed' }),
        ]),
      ];
      const candidate = failedReport(entries);
      expect(candidate.counts.failed).toBe(0);
      expect(candidate.counts.unsupported).toBe(2);
      expect(validateScopeReport(candidate)).toEqual(candidate);
    });

    it('NoSourcesFound-shaped FAILED report with failed = 0', () => {
      const entries = [
        entry('NOT_FOUND', 'contracts/Ghost.sol', [
          { kind: 'walk_miss', include: 'contracts/Ghost.sol' },
        ]),
      ];
      const candidate = failedReport(entries, { failed_stage: 'discover' });
      expect(candidate.counts.failed).toBe(0);
      expect(candidate.counts.not_found).toBe(1);
      expect(validateScopeReport(candidate)).toEqual(candidate);
    });
  });
});
