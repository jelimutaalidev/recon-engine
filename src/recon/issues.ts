import { z } from 'zod';
import { parseOrThrow } from '../domain/helpers.js';
import { compareCodeUnits } from '../util/canonical.js';

export const issueSeveritySchema = z.enum(['FATAL', 'RECOVERABLE', 'UNKNOWN', 'UNSUPPORTED']);

const ReconIssueSchema = z.strictObject({
  severity: issueSeveritySchema,
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
  line_start: z.number().int().min(1).optional(),
  line_end: z.number().int().min(1).optional(),
  count: z.number().int().min(1).optional(),
});

export type ReconIssue = z.infer<typeof ReconIssueSchema>;

export function createReconIssue(raw: unknown): ReconIssue {
  return parseOrThrow(ReconIssueSchema, raw, 'ReconIssue');
}

const SEVERITY_ORDER: Record<ReconIssue['severity'], number> = {
  FATAL: 0,
  RECOVERABLE: 1,
  UNKNOWN: 2,
  UNSUPPORTED: 3,
};

export function sortIssues(issues: readonly ReconIssue[]): ReconIssue[] {
  return [...issues].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.file ?? '', b.file ?? '') ||
      (a.line_start ?? 0) - (b.line_start ?? 0) ||
      (a.line_end ?? 0) - (b.line_end ?? 0) ||
      (a.count ?? 0) - (b.count ?? 0) ||
      compareCodeUnits(a.message, b.message),
  );
}
