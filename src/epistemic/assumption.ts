import { z } from 'zod';
import { parseOrThrow, timestampField } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';
import { confidenceSchema, resolveConfidence } from './confidence.js';
import { OBSERVATION_REF_PATTERN } from './refs.js';
import { assertNonEmptyBasis } from './shared.js';

export const ASSUMPTION_STATUSES = ['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED'] as const;
export const assumptionStatusSchema = z.enum(ASSUMPTION_STATUSES);
export type AssumptionStatus = z.infer<typeof assumptionStatusSchema>;

const AssumptionInputSchema = z.strictObject({
  type: z.literal('ASSUMPTION').optional(),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(OBSERVATION_REF_PATTERN)).default([]),
  confidence: confidenceSchema.optional(),
  status: assumptionStatusSchema.default('OPEN'),
  created_at: timestampField.optional(),
});

export const AssumptionSchema = z.strictObject({
  type: z.literal('ASSUMPTION'),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(OBSERVATION_REF_PATTERN)),
  confidence: confidenceSchema,
  status: assumptionStatusSchema,
  created_at: timestampField,
  id: z.string().regex(/^asm:.+/),
});

export type AssumptionInput = z.input<typeof AssumptionInputSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;

export function assumptionContentId(assumption: Omit<Assumption, 'id' | 'created_at'>): string {
  return contentId('asm', {
    type: assumption.type,
    statement: assumption.statement,
    based_on: [...assumption.based_on].sort(),
    status: assumption.status,
    confidence: assumption.confidence,
  });
}

export function createAssumption(input: AssumptionInput): Assumption {
  const parsed = parseOrThrow(AssumptionInputSchema, input, 'Assumption');
  assertNonEmptyBasis(parsed.based_on, 'Assumption');
  const confidence = resolveConfidence(parsed.confidence, 'INFERRED', 'Assumption');
  const id = assumptionContentId({
    type: 'ASSUMPTION',
    statement: parsed.statement,
    based_on: parsed.based_on,
    status: parsed.status,
    confidence,
  });
  return parseOrThrow(
    AssumptionSchema,
    {
      ...parsed,
      type: 'ASSUMPTION',
      confidence,
      created_at: parsed.created_at ?? new Date().toISOString(),
      id,
    },
    'Assumption',
  );
}
