import { z } from 'zod';
import { ReconError } from '../errors/errors.js';
import { parseOrThrow, timestampField } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';
import { relationshipTypeSchema } from '../relationships/types.js';
import { confidenceSchema, resolveConfidence } from './confidence.js';
import {
  ProvenanceInputSchema,
  ProvenanceSchema,
  createProvenance,
  type Provenance,
  type ProvenanceInput,
} from './provenance.js';
import { ENTITY_REF_PATTERN } from './refs.js';

const valueField = z.union([z.string().trim().min(1), z.number(), z.boolean()]);

const FactBody = {
  subject_id: z.string().regex(ENTITY_REF_PATTERN),
  predicate: relationshipTypeSchema,
  object_id: z.string().regex(ENTITY_REF_PATTERN).optional(),
  value: valueField.optional(),
} as const;

function factHasObject(value: {
  object_id?: string | undefined;
  value?: string | number | boolean | undefined;
}): boolean {
  return value.object_id !== undefined || value.value !== undefined;
}

const objectRule = { message: 'fact requires object_id or value' } as const;

const FactInputSchema = z
  .strictObject({
    type: z.literal('FACT').optional(),
    ...FactBody,
    provenance: z.array(ProvenanceInputSchema),
    confidence: confidenceSchema.optional(),
    created_at: timestampField.optional(),
  })
  .refine(factHasObject, objectRule);

export const FactSchema = z
  .strictObject({
    ...FactBody,
    type: z.literal('FACT'),
    provenance: z.array(ProvenanceSchema),
    confidence: confidenceSchema,
    created_at: timestampField,
    id: z.string().regex(/^fact:.+/),
  })
  .refine(factHasObject, objectRule);

export type FactInput = z.input<typeof FactInputSchema>;
export type Fact = z.infer<typeof FactSchema>;

export function factContentId(fact: Omit<Fact, 'id' | 'created_at'>): string {
  return contentId('fact', {
    type: fact.type,
    subject_id: fact.subject_id,
    predicate: fact.predicate,
    object_id: fact.object_id,
    value: fact.value,
    confidence: fact.confidence,
    provenance: fact.provenance.map((record) => record.id).sort(),
  });
}

export function createFact(input: FactInput): Fact {
  const parsed = parseOrThrow(FactInputSchema, input, 'Fact');
  if (parsed.provenance.length === 0) {
    throw new ReconError('MissingProvenance', 'Fact requires at least one provenance record', {
      entity: 'Fact',
      subject_id: parsed.subject_id,
      predicate: parsed.predicate,
    });
  }
  const provenance: Provenance[] = parsed.provenance.map(createProvenance);
  const confidence = resolveConfidence(parsed.confidence, 'VERIFIED', 'Fact');
  const id = factContentId({
    type: 'FACT',
    subject_id: parsed.subject_id,
    predicate: parsed.predicate,
    object_id: parsed.object_id,
    value: parsed.value,
    confidence,
    provenance,
  });
  return parseOrThrow(
    FactSchema,
    {
      ...parsed,
      type: 'FACT',
      provenance,
      confidence,
      created_at: parsed.created_at ?? new Date().toISOString(),
      id,
    },
    'Fact',
  );
}
