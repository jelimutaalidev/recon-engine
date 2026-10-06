import { describe, expect, it } from 'vitest';
import type { ReconIssue } from '../../src/recon/issues.js';
import {
  attributableIssues,
  hasCompilationFailed,
  hasFallback,
  hasUnknown,
  COMPILATION_FAILED_CODE,
  FALLBACK_CODE,
} from '../../src/scope/evidence.js';

const issue = (over: Partial<ReconIssue> = {}): ReconIssue => ({
  severity: 'RECOVERABLE',
  code: 'X',
  message: 'msg',
  ...over,
});

describe('attributableIssues', () => {
  it('only issues whose file equals the path are embedded', () => {
    const issues = [
      issue({ file: 'a.sol', code: 'KEEP' }),
      issue({ file: 'b.sol', code: 'OTHER' }),
      issue({ code: 'FILELESS' }),
    ];
    const embedded = attributableIssues(issues, 'a.sol');
    expect(embedded).toHaveLength(1);
    expect(embedded[0]?.code).toBe('KEEP');
    expect(embedded.every((e) => e.file === 'a.sol')).toBe(true);
  });

  it('embedded count defaults to 1 and explicit count is preserved', () => {
    const embedded = attributableIssues(
      [
        issue({ file: 'a.sol', code: 'NO_COUNT' }),
        issue({ file: 'a.sol', code: 'HAS_COUNT', count: 7 }),
      ],
      'a.sol',
    );
    expect(embedded.find((e) => e.code === 'NO_COUNT')?.count).toBe(1);
    expect(embedded.find((e) => e.code === 'HAS_COUNT')?.count).toBe(7);
  });

  it('evidence sorted by code then line_start', () => {
    const embedded = attributableIssues(
      [
        issue({ file: 'a.sol', code: 'B', line_start: 10 }),
        issue({ file: 'a.sol', code: 'A', line_start: 50 }),
        issue({ file: 'a.sol', code: 'A', line_start: 5 }),
        issue({ file: 'a.sol', code: 'A' }),
      ],
      'a.sol',
    );
    expect(embedded.map((e) => [e.code, e.line_start ?? 0])).toEqual([
      ['A', 0],
      ['A', 5],
      ['A', 50],
      ['B', 10],
    ]);
  });
});

describe('flag helpers', () => {
  it('hasUnknown is true for UNKNOWN severity and false for RECOVERABLE', () => {
    const unknown = attributableIssues(
      [{ ...issue({ file: 'a.sol' }), severity: 'UNKNOWN' }],
      'a.sol',
    );
    const recoverable = attributableIssues([issue({ file: 'a.sol' })], 'a.sol');
    expect(hasUnknown(unknown)).toBe(true);
    expect(hasUnknown(recoverable)).toBe(false);
    expect(hasUnknown([])).toBe(false);
  });

  it('hasFallback is true only for the syntactic_fallback code', () => {
    const fallback = attributableIssues(
      [issue({ file: 'a.sol', code: FALLBACK_CODE })],
      'a.sol',
    );
    const other = attributableIssues([issue({ file: 'a.sol', code: 'nope' })], 'a.sol');
    expect(hasFallback(fallback)).toBe(true);
    expect(hasFallback(other)).toBe(false);
    expect(hasFallback([])).toBe(false);
  });

  it('hasCompilationFailed is true only for the compilation_failed code', () => {
    const failed = attributableIssues(
      [issue({ file: 'a.sol', code: COMPILATION_FAILED_CODE })],
      'a.sol',
    );
    const other = attributableIssues([issue({ file: 'a.sol', code: 'nope' })], 'a.sol');
    expect(hasCompilationFailed(failed)).toBe(true);
    expect(hasCompilationFailed(other)).toBe(false);
    expect(hasCompilationFailed([])).toBe(false);
  });
});
