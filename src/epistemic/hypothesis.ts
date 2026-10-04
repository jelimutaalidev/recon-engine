import { z } from 'zod';
import { parseOrThrow, timestampField } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';
import { confidenceSchema, resolveConfidence } from './confidence.js';
import { ASSUMPTION_OR_OBSERVATION_REF_PATTERN, ENTITY_REF_PATTERN } from './refs.js';
import { assertNonEmptyBasis } from './shared.js';

export const HYPOTHESIS_STATUSES = ['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED'] as const;
export const hypothesisStatusSchema = z.enum(HYPOTHESIS_STATUSES);
export type HypothesisStatus = z.infer<typeof hypothesisStatusSchema>;

const HypothesisInputSchema = z.strictObject({
  type: z.literal('HYPOTHESIS').optional(),
  statement: z.string().trim().min(1),
  based_on: z
    .array(z.string().regex(ASSUMPTION_OR_OBSERVATION_REF_PATTERN))
    .default([]),
  affected_entities: z.array(z.string().regex(ENTITY_REF_PATTERN)).default([]),
  required_conditions: z.array(z.string().trim().min(1)).default([]),
  status: hypothesisStatusSchema.default('OPEN'),
  confidence: confidenceSchema.optional(),
  created_at: timestampField.optional(),
});

export const HypothesisSchema = z.strictObject({
  type: z.literal('HYPOTHESIS'),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(ASSUMPTION_OR_OBSERVATION_REF_PATTERN)),
  affected_entities: z.array(z.string().regex(ENTITY_REF_PATTERN)),
  required_conditions: z.array(z.string().trim().min(1)),
  status: hypothesisStatusSchema,
  confidence: confidenceSchema,
  created_at: timestampField,
  id: z.string().regex(/^hyp:.+/),
});

export type HypothesisInput = z.input<typeof HypothesisInputSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export function hypothesisContentId(hypothesis: Omit<Hypothesis, 'id' | 'created_at'>): string {
  return contentId('hyp', {
    type: hypothesis.type,
    statement: hypothesis.statement,
    based_on: [...hypothesis.based_on].sort(),
    affected_entities: [...hypothesis.affected_entities].sort(),
    required_conditions: [...hypothesis.required_conditions].sort(),
    status: hypothesis.status,
    confidence: hypothesis.confidence,
  });
}

export function createHypothesis(input: HypothesisInput): Hypothesis {
  const parsed = parseOrThrow(HypothesisInputSchema, input, 'Hypothesis');
  assertNonEmptyBasis(parsed.based_on, 'Hypothesis');
  const confidence = resolveConfidence(parsed.confidence, 'SPECULATIVE', 'Hypothesis');
  const id = hypothesisContentId({
    type: 'HYPOTHESIS',
    statement: parsed.statement,
    based_on: parsed.based_on,
    affected_entities: parsed.affected_entities,
    required_conditions: parsed.required_conditions,
    status: parsed.status,
    confidence,
  });
  return parseOrThrow(
    HypothesisSchema,
    {
      ...parsed,
      type: 'HYPOTHESIS',
      confidence,
      created_at: parsed.created_at ?? new Date().toISOString(),
      id,
    },
    'Hypothesis',
  );
}
