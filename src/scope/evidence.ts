import type { ReconIssue } from '../recon/issues.js';
import { compareCodeUnits } from '../util/canonical.js';
import type { EmbeddedIssue } from './model.js';

export const FALLBACK_CODE = 'syntactic_fallback';
export const COMPILATION_FAILED_CODE = 'compilation_failed';

export function attributableIssues(
  issues: readonly ReconIssue[],
  path: string,
): EmbeddedIssue[] {
  return issues
    .filter((issue) => issue.file === path)
    .map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      file: path,
      line_start: issue.line_start,
      line_end: issue.line_end,
      count: issue.count ?? 1,
    }))
    .sort(
      (a, b) =>
        compareCodeUnits(a.code, b.code) ||
        compareCodeUnits(a.file, b.file) ||
        (a.line_start ?? 0) - (b.line_start ?? 0),
    );
}

export function hasUnknown(issues: readonly EmbeddedIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'UNKNOWN');
}

export function hasFallback(issues: readonly EmbeddedIssue[]): boolean {
  return issues.some((issue) => issue.code === FALLBACK_CODE);
}

export function hasCompilationFailed(issues: readonly EmbeddedIssue[]): boolean {
  return issues.some((issue) => issue.code === COMPILATION_FAILED_CODE);
}
