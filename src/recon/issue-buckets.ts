import type { Span } from './ir/types.js';
import { createReconIssue, type ReconIssue } from './issues.js';

export interface IssueBucket {
  code: string;
  message: string;
  file: string;
  count: number;
  lineStart: number;
  lineEnd: number;
}

export type IssueBuckets = Map<string, IssueBucket>;

export function bucketIssue(
  buckets: IssueBuckets,
  spec: { code: string; message: string },
  span: Span,
): void {
  const key = `${spec.code} ${span.file}`;
  const existing = buckets.get(key);
  if (existing === undefined) {
    buckets.set(key, {
      code: spec.code,
      message: spec.message,
      file: span.file,
      count: 1,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
    });
    return;
  }
  existing.count += 1;
  existing.lineStart = Math.min(existing.lineStart, span.lineStart);
  existing.lineEnd = Math.max(existing.lineEnd, span.lineEnd);
}

export function flushIssues(
  buckets: IssueBuckets,
  severity: ReconIssue['severity'],
): ReconIssue[] {
  return [...buckets.values()].map((bucket) =>
    createReconIssue({
      severity,
      code: bucket.code,
      message: bucket.message,
      file: bucket.file,
      line_start: bucket.lineStart,
      line_end: bucket.lineEnd,
      count: bucket.count,
    }),
  );
}
