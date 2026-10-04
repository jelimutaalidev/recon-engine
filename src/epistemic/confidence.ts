import { z } from 'zod';
import { ReconError } from '../errors/errors.js';

export const CONFIDENCE_LEVELS = [
  'VERIFIED',
  'DERIVED',
  'INFERRED',
  'SPECULATIVE',
] as const;

export const confidenceSchema = z.strictObject({
  level: z.enum(CONFIDENCE_LEVELS),
  score: z.number().min(0).max(1).optional(),
});

export type Confidence = z.infer<typeof confidenceSchema>;
export type ConfidenceLevel = z.infer<typeof confidenceSchema>['level'];

export function resolveConfidence(
  raw: Confidence | undefined,
  expected: ConfidenceLevel,
  entity: string,
): Confidence {
  if (raw === undefined) {
    return { level: expected };
  }
  if (raw.level !== expected) {
    throw new ReconError(
      'InvalidConfidence',
      `${entity} confidence level must be ${expected}; numeric confidence never overrides epistemic type`,
      { entity, expected, received: raw.level },
    );
  }
  return raw;
}
