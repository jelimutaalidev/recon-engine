import { describe, expect, it } from 'vitest';
import { scopeReportSchema, scopeStatusSchema, stageSchema } from '../../src/scope/model.js';

const SHA = 'a'.repeat(64);

const minimalReport = {
  schema_version: 'scope-report/v1' as const,
  run: { run_id: 'run:1', input_manifest_hash: 'b'.repeat(64), output_hash: 'c'.repeat(64) },
  run_status: 'COMPLETED' as const,
  run_fidelity: 'semantic' as const,
  counts: { expected: 1, analyzed: 1, excluded: 0, not_found: 0, unresolved: 0, unsupported: 0, failed: 0 },
  entries: [
    {
      target_type: 'source_file' as const,
      path: 'src/A.sol',
      status: 'ANALYZED' as const,
      evidence: [{ kind: 'analysis' as const, sha256: SHA }],
    },
  ],
  metrics: {
    clean_coverage: { n: 1, d: 1 },
    resolution_completeness: { n: 1, d: 1 },
    unsupported_rate: { n: 0, d: 1 },
    failed_rate: { n: 0, d: 1 },
    not_found_rate: { n: 0, d: 1 },
    excluded_by_rule: [] as { rule: string; count: number }[],
    fallback_count: 0,
  },
  scope_hash: SHA,
};

describe('scope report model', () => {
  it('valid minimal report parses', () => {
    expect(scopeReportSchema.parse(minimalReport)).toEqual(minimalReport);
  });

  it('unknown keys rejected', () => {
    expect(() => scopeReportSchema.parse({ ...minimalReport, generated_at: 'x' })).toThrow();
  });

  it('missing clean_coverage rejected', () => {
    const { clean_coverage: _omitted, ...metricsWithoutCoverage } = minimalReport.metrics;
    expect(() => scopeReportSchema.parse({ ...minimalReport, metrics: metricsWithoutCoverage })).toThrow();
  });

  it('invalid scope_hash rejected', () => {
    expect(() => scopeReportSchema.parse({ ...minimalReport, scope_hash: 'zz' })).toThrow();
  });

  it('status and stage vocabularies are pinned', () => {
    expect([...scopeStatusSchema.options].sort()).toEqual([
      'ANALYZED',
      'EXCLUDED',
      'FAILED',
      'NOT_FOUND',
      'UNRESOLVED',
      'UNSUPPORTED',
    ]);
    expect(scopeStatusSchema.options).toHaveLength(6);
    expect(scopeStatusSchema.options).not.toContain('UNKNOWN');
    expect([...stageSchema.options].sort()).toEqual(['analysis', 'build', 'compile', 'discover', 'extract', 'ir']);
    expect(stageSchema.options).toContain('analysis');
  });
});
