import { z } from 'zod';
import { ReconError } from '../errors/errors.js';
import { parseOrThrow, timestampField } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';
import { confidenceSchema, resolveConfidence } from './confidence.js';
import {
  ProvenanceInputSchema,
  ProvenanceSchema,
  createProvenance,
  type Provenance,
} from './provenance.js';
import { FACT_REF_PATTERN } from './refs.js';

const ObservationInputSchema = z.strictObject({
  type: z.literal('OBSERVATION').optional(),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(FACT_REF_PATTERN)).default([]),
  provenance: z.array(ProvenanceInputSchema).default([]),
  confidence: confidenceSchema.optional(),
  created_at: timestampField.optional(),
});

export const ObservationSchema = z.strictObject({
  type: z.literal('OBSERVATION'),
  statement: z.string().trim().min(1),
  based_on: z.array(z.string().regex(FACT_REF_PATTERN)),
  provenance: z.array(ProvenanceSchema),
  confidence: confidenceSchema,
  created_at: timestampField,
  id: z.string().regex(/^obs:.+/),
});

export type ObservationInput = z.input<typeof ObservationInputSchema>;
export type Observation = z.infer<typeof ObservationSchema>;

export function observationContentId(
  observation: Omit<Observation, 'id' | 'created_at'>,
): string {
  return contentId('obs', {
    type: observation.type,
    statement: observation.statement,
    based_on: [...observation.based_on].sort(),
    provenance: observation.provenance.map((record) => record.id).sort(),
    confidence: observation.confidence,
  });
}

export function createObservation(input: ObservationInput): Observation {
  const parsed = parseOrThrow(ObservationInputSchema, input, 'Observation');
  if (parsed.based_on.length === 0 && parsed.provenance.length === 0) {
    throw new ReconError(
      'InvalidEpistemicDependency',
      'Observation requires supporting facts or explicit source provenance stating why no fact exists',
      { entity: 'Observation', statement: parsed.statement },
    );
  }
  const provenance: Provenance[] = parsed.provenance.map(createProvenance);
  const confidence = resolveConfidence(parsed.confidence, 'DERIVED', 'Observation');
  const id = observationContentId({
    type: 'OBSERVATION',
    statement: parsed.statement,
    based_on: parsed.based_on,
    provenance,
    confidence,
  });
  return parseOrThrow(
    ObservationSchema,
    {
      ...parsed,
      type: 'OBSERVATION',
      provenance,
      confidence,
      created_at: parsed.created_at ?? new Date().toISOString(),
      id,
    },
    'Observation',
  );
}
