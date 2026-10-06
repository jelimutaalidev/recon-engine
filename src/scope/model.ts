import { z } from 'zod';
import { issueSeveritySchema } from '../recon/issues.js';

export const stageSchema = z.enum(['discover', 'compile', 'analysis', 'ir', 'extract', 'build']);
export type Stage = z.infer<typeof stageSchema>;

export const scopeStatusSchema = z.enum([
  'ANALYZED',
  'EXCLUDED',
  'NOT_FOUND',
  'UNRESOLVED',
  'UNSUPPORTED',
  'FAILED',
]);
export type ScopeStatus = z.infer<typeof scopeStatusSchema>;

export const targetTypeSchema = z.literal('source_file');
export type TargetType = z.infer<typeof targetTypeSchema>;

export const embeddedIssueSchema = z.strictObject({
  code: z.string().min(1).refine((value) => value === value.trim(), {
    message: 'code must not have leading or trailing whitespace',
  }),
  severity: issueSeveritySchema,
  message: z.string().min(1).refine((value) => value === value.trim(), {
    message: 'message must not have leading or trailing whitespace',
  }),
  file: z.string().min(1).refine((value) => value === value.trim(), {
    message: 'file must not have leading or trailing whitespace',
  }),
  line_start: z.number().int().min(1).optional(),
  line_end: z.number().int().min(1).optional(),
  count: z.number().int().min(1),
});
export type EmbeddedIssue = z.infer<typeof embeddedIssueSchema>;

export const scopeEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('analysis'), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ kind: z.literal('exclude_rule'), rule: z.string().min(1) }),
  z.strictObject({ kind: z.literal('size_limit'), limit_bytes: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal('walk_miss'), include: z.string().min(1) }),
  z.strictObject({ kind: z.literal('issue'), issue: embeddedIssueSchema }),
  z.strictObject({
    kind: z.literal('run_error'),
    stage: stageSchema,
    error_class: z.string().min(1),
    message: z.string(),
  }),
]);
export type ScopeEvidence = z.infer<typeof scopeEvidenceSchema>;

export const scopeEntrySchema = z.strictObject({
  target_type: targetTypeSchema,
  path: z.string().min(1),
  status: scopeStatusSchema,
  evidence: z.array(scopeEvidenceSchema).min(1),
});
export type ScopeEntry = z.infer<typeof scopeEntrySchema>;

export const ratioSchema = z.strictObject({
  n: z.number().int().min(0),
  d: z.number().int().min(1),
});
export type Ratio = z.infer<typeof ratioSchema>;

export const scopeMetricsSchema = z.strictObject({
  clean_coverage: ratioSchema,
  resolution_completeness: ratioSchema,
  unsupported_rate: ratioSchema,
  failed_rate: ratioSchema,
  not_found_rate: ratioSchema,
  excluded_by_rule: z.array(
    z.strictObject({ rule: z.string().min(1), count: z.number().int().min(1) }),
  ),
  fallback_count: z.number().int().min(0),
});
export type ScopeMetrics = z.infer<typeof scopeMetricsSchema>;

export const scopeRunSchema = z.strictObject({
  run_id: z.string().min(1),
  input_manifest_hash: z.string().min(1),
  output_hash: z.string().min(1),
});
export type RunBinding = z.infer<typeof scopeRunSchema>;

export const countsSchema = z.strictObject({
  expected: z.number().int().min(0),
  analyzed: z.number().int().min(0),
  excluded: z.number().int().min(0),
  not_found: z.number().int().min(0),
  unresolved: z.number().int().min(0),
  unsupported: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type ScopeCounts = z.infer<typeof countsSchema>;

// Cross-field rules (INV-9 conditionals: run/run_fidelity/failed_stage vs
// run_status, counts under failure) live in validate.ts — not in this schema.
export const scopeReportSchema = z.strictObject({
  schema_version: z.literal('scope-report/v1'),
  run: z.union([scopeRunSchema, z.null()]),
  run_status: z.enum(['COMPLETED', 'FAILED']),
  run_fidelity: z.enum(['semantic', 'syntactic']).optional(),
  failed_stage: stageSchema.optional(),
  counts: countsSchema,
  entries: z.array(scopeEntrySchema),
  metrics: scopeMetricsSchema,
  scope_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ScopeReport = z.infer<typeof scopeReportSchema>;
