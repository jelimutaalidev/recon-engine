import { z } from 'zod';
import { ProvenanceSchema, type Provenance } from '../../epistemic/provenance.js';
import { compareCodeUnits } from '../../util/canonical.js';
import { ReconError } from '../../errors/errors.js';
import { esmContentId } from './ids.js';

export const ESM_UNKNOWN_REASONS = [
  'no_evidence',
  'unresolved_call',
  'unsupported_assembly',
  'out_of_scope_target',
  'syntactic_fidelity',
  'dropped_file',
  'no-return-linkage',
  'no-branch-evidence',
  'sub-path-unobservable',
  'location-unidentified',
  'alias-possible',
  'value-unobservable',
  'ordering-unobservable',
  'ambiguous-source-kind',
  'runtime-unobservable',
  'context-shift',
  'bound-hit',
  'cyclic',
] as const;

export type UnknownReason = (typeof ESM_UNKNOWN_REASONS)[number];

export const esmUnknownReasonSchema = z.enum(ESM_UNKNOWN_REASONS);

export const EsmUnknownInputSchema = z.strictObject({
  scope: z.string().min(1),
  reason: esmUnknownReasonSchema,
  basis: z.array(z.string().min(1)).min(1),
  provenance: z.array(ProvenanceSchema).optional(),
});
export type UnknownRecordInput = z.infer<typeof EsmUnknownInputSchema>;

export const EsmUnknownRecordSchema = EsmUnknownInputSchema.extend({
  id: z.string().regex(/^seme:.+/),
});
export type UnknownRecord = z.infer<typeof EsmUnknownRecordSchema>;

export function makeEsmUnknown(
  scope: string,
  reason: UnknownReason,
  basis: string[],
  provenance?: Provenance[],
): UnknownRecord {
  if (basis.length === 0) {
    throw new ReconError('InvalidSemanticModel', 'ESM unknown record requires basis >= 1', {
      scope,
      reason,
    });
  }
  const sortedBasis = [...basis].sort(compareCodeUnits);
  const id = esmContentId('seme:', { scope, reason, basis: sortedBasis });
  const candidate =
    provenance === undefined
      ? { id, scope, reason, basis: sortedBasis }
      : { id, scope, reason, basis: sortedBasis, provenance };
  const parsed = EsmUnknownRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ReconError('InvalidSemanticModel', 'ESM unknown record failed schema validation', {
      scope,
      reason,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
