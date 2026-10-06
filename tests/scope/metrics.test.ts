import { describe, expect, it } from 'vitest';
import { computeCounts, computeMetrics } from '../../src/scope/metrics.js';
import type { ScopeEntry, ScopeEvidence, ScopeStatus } from '../../src/scope/model.js';

const SHA = 'a'.repeat(64);

const analysisEvidence: ScopeEvidence = { kind: 'analysis', sha256: SHA };

function entry(
  status: ScopeStatus,
  evidence: readonly ScopeEvidence[] = [analysisEvidence],
  path = `src/${status}.sol`,
): ScopeEntry {
  return { target_type: 'source_file', path, status, evidence: [...evidence] };
}

function excludeRule(rule: string): ScopeEvidence {
  return { kind: 'exclude_rule', rule };
}

function fallbackIssue(code: string): ScopeEvidence {
  return {
    kind: 'issue',
    issue: {
      code,
      severity: 'RECOVERABLE',
      message: `issue ${code}`,
      file: 'src/A.sol',
      count: 1,
    },
  };
}

describe('computeCounts', () => {
  it('all seven fields always present, zero for empty input', () => {
    expect(computeCounts([])).toEqual({
      expected: 0,
      analyzed: 0,
      excluded: 0,
      not_found: 0,
      unresolved: 0,
      unsupported: 0,
      failed: 0,
    });
  });

  it('counts sum to |S| and expected excludes only EXCLUDED', () => {
    const entries: ScopeEntry[] = [
      entry('ANALYZED'),
      entry('ANALYZED'),
      entry('EXCLUDED', [excludeRule('vendor/**')]),
      entry('NOT_FOUND', [{ kind: 'walk_miss', include: '*.sol' }]),
      entry('UNRESOLVED'),
      entry('UNSUPPORTED'),
      entry('FAILED', [
        { kind: 'run_error', stage: 'analysis', error_class: 'Boom', message: 'kaboom' },
      ]),
    ];
    const counts = computeCounts(entries);

    expect(counts).toEqual({
      expected: 6,
      analyzed: 2,
      excluded: 1,
      not_found: 1,
      unresolved: 1,
      unsupported: 1,
      failed: 1,
    });
    const statusTotal =
      counts.analyzed +
      counts.excluded +
      counts.not_found +
      counts.unresolved +
      counts.unsupported +
      counts.failed;
    expect(statusTotal).toBe(entries.length);
    expect(counts.expected).toBe(entries.length - counts.excluded);
  });

  it('expected counts non-EXCLUDED statuses only', () => {
    const entries: ScopeEntry[] = [
      entry('ANALYZED'),
      entry('NOT_FOUND'),
      entry('UNRESOLVED'),
      entry('UNSUPPORTED'),
      entry('FAILED'),
      entry('EXCLUDED', [excludeRule('gen/**')]),
      entry('EXCLUDED', [{ kind: 'size_limit', limit_bytes: 1_000_000 }]),
    ];
    const counts = computeCounts(entries);
    expect(counts.expected).toBe(5);
    expect(counts.excluded).toBe(2);
    expect(counts.analyzed).toBe(1);
    expect(counts.not_found).toBe(1);
    expect(counts.unresolved).toBe(1);
    expect(counts.unsupported).toBe(1);
    expect(counts.failed).toBe(1);
  });
});

describe('computeMetrics', () => {
  it('clean_coverage = analyzed over expected', () => {
    const entries: ScopeEntry[] = [
      entry('ANALYZED'),
      entry('UNSUPPORTED'),
      entry('EXCLUDED', [excludeRule('vendor/**')]),
      entry('NOT_FOUND'),
    ];
    expect(computeMetrics(entries).clean_coverage).toEqual({ n: 1, d: 3 });
  });

  it('clean_coverage vacuous 1/1 at |E| = 0, rates {0,1} there', () => {
    const onlyExcluded: ScopeEntry[] = [
      entry('EXCLUDED', [excludeRule('vendor/**')]),
      entry('EXCLUDED', [{ kind: 'size_limit', limit_bytes: 10 }]),
    ];
    const metrics = computeMetrics(onlyExcluded);
    expect(metrics.clean_coverage).toEqual({ n: 1, d: 1 });
    expect(metrics.unsupported_rate).toEqual({ n: 0, d: 1 });
    expect(metrics.failed_rate).toEqual({ n: 0, d: 1 });
    expect(metrics.not_found_rate).toEqual({ n: 0, d: 1 });

    const empty = computeMetrics([]);
    expect(empty.clean_coverage).toEqual({ n: 1, d: 1 });
    expect(empty.unsupported_rate).toEqual({ n: 0, d: 1 });
    expect(empty.failed_rate).toEqual({ n: 0, d: 1 });
    expect(empty.not_found_rate).toEqual({ n: 0, d: 1 });
  });

  it('rates are over |E| with integer ratio pairs, no floats', () => {
    const entries: ScopeEntry[] = [
      entry('ANALYZED'),
      entry('ANALYZED'),
      entry('UNSUPPORTED'),
      entry('FAILED'),
      entry('NOT_FOUND'),
      entry('NOT_FOUND'),
      entry('EXCLUDED', [excludeRule('vendor/**')]),
    ];
    const metrics = computeMetrics(entries);
    expect(metrics.unsupported_rate).toEqual({ n: 1, d: 6 });
    expect(metrics.failed_rate).toEqual({ n: 1, d: 6 });
    expect(metrics.not_found_rate).toEqual({ n: 2, d: 6 });
    for (const ratio of [
      metrics.clean_coverage,
      metrics.resolution_completeness,
      metrics.unsupported_rate,
      metrics.failed_rate,
      metrics.not_found_rate,
    ]) {
      expect(Number.isInteger(ratio.n)).toBe(true);
      expect(Number.isInteger(ratio.d)).toBe(true);
      expect(ratio.d).toBeGreaterThanOrEqual(1);
    }
  });

  it('resolution_completeness uses analyzed over analyzed+unresolved', () => {
    const entries: ScopeEntry[] = [
      entry('ANALYZED'),
      entry('ANALYZED'),
      entry('UNRESOLVED'),
      entry('EXCLUDED', [excludeRule('vendor/**')]),
      entry('FAILED'),
    ];
    expect(computeMetrics(entries).resolution_completeness).toEqual({ n: 2, d: 3 });
  });

  it('resolution_completeness vacuous 1/1 when analyzed+unresolved = 0', () => {
    const entries: ScopeEntry[] = [
      entry('EXCLUDED', [excludeRule('vendor/**')]),
      entry('UNSUPPORTED'),
    ];
    expect(computeMetrics(entries).resolution_completeness).toEqual({ n: 1, d: 1 });
  });

  it('excluded_by_rule aggregates exact rule strings sorted code-unit', () => {
    const entries: ScopeEntry[] = [
      entry('EXCLUDED', [excludeRule('zeta/**')]),
      entry('EXCLUDED', [excludeRule('alpha/**')]),
      entry('EXCLUDED', [excludeRule('zeta/**')]),
      entry('EXCLUDED', [excludeRule('Alpha/**')]),
      entry('EXCLUDED', [{ kind: 'size_limit', limit_bytes: 1_000_000 }]),
      entry('EXCLUDED', [excludeRule('zeta/**')]),
      entry('ANALYZED', [excludeRule('not-counted/**')]),
      entry('NOT_FOUND', [{ kind: 'size_limit', limit_bytes: 10 }]),
    ];
    expect(computeMetrics(entries).excluded_by_rule).toEqual([
      { rule: 'Alpha/**', count: 1 },
      { rule: 'alpha/**', count: 1 },
      { rule: 'limit:maxFileBytes', count: 1 },
      { rule: 'zeta/**', count: 3 },
    ]);
  });

  it('excluded_by_rule empty when nothing excluded', () => {
    expect(computeMetrics([entry('ANALYZED')]).excluded_by_rule).toEqual([]);
    expect(computeMetrics([]).excluded_by_rule).toEqual([]);
  });

  it('fallback_count counts entries regardless of status', () => {
    const entries: ScopeEntry[] = [
      entry('ANALYZED', [analysisEvidence, fallbackIssue('syntactic_fallback')]),
      entry('EXCLUDED', [excludeRule('vendor/**'), fallbackIssue('syntactic_fallback')]),
      entry('FAILED', [fallbackIssue('syntactic_fallback')]),
      entry('UNRESOLVED', [fallbackIssue('other_code')]),
      entry('UNSUPPORTED', [analysisEvidence]),
    ];
    const metrics = computeMetrics(entries);
    expect(metrics.fallback_count).toBe(3);
  });

  it('fallback_count zero without fallback issues', () => {
    expect(computeMetrics([]).fallback_count).toBe(0);
    expect(computeMetrics([entry('ANALYZED')]).fallback_count).toBe(0);
  });

  it('metrics object has exactly the seven fields', () => {
    expect(Object.keys(computeMetrics([])).sort()).toEqual([
      'clean_coverage',
      'excluded_by_rule',
      'failed_rate',
      'fallback_count',
      'not_found_rate',
      'resolution_completeness',
      'unsupported_rate',
    ]);
  });
});
