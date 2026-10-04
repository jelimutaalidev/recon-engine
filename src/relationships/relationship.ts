import { z } from 'zod';
import { ReconError } from '../errors/errors.js';
import { parseOrThrow, timestampField } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';
import { RELATIONSHIP_TYPES, type RelationshipType } from './types.js';
import {
  ProvenanceInputSchema,
  ProvenanceSchema,
  createProvenance,
  type Provenance,
} from '../epistemic/provenance.js';
import { ENTITY_REF_PATTERN } from '../epistemic/refs.js';

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const RelationshipInputSchema = z.strictObject({
  type: z.string().trim().min(1),
  source_id: z.string().trim().min(1),
  target_id: z.string().trim().min(1),
  metadata: z.record(z.string(), metadataValueSchema).optional(),
  provenance: z.array(ProvenanceInputSchema),
  created_at: timestampField.optional(),
});

export const RelationshipSchema = z.strictObject({
  type: z.string().trim().min(1),
  source_id: z.string().regex(ENTITY_REF_PATTERN),
  target_id: z.string().regex(ENTITY_REF_PATTERN),
  metadata: z.record(z.string(), metadataValueSchema).optional(),
  provenance: z.array(ProvenanceSchema),
  created_at: timestampField,
  id: z.string().regex(/^rel:.+/),
});

export type RelationshipInput = z.input<typeof RelationshipInputSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;

export function relationshipContentId(
  relationship: Omit<Relationship, 'id' | 'created_at'>,
): string {
  return contentId('rel', {
    type: relationship.type,
    source_id: relationship.source_id,
    target_id: relationship.target_id,
    metadata: relationship.metadata,
    provenance: relationship.provenance.map((record) => record.id).sort(),
  });
}

export function createRelationship(input: RelationshipInput): Relationship {
  const parsed = parseOrThrow(RelationshipInputSchema, input, 'Relationship');
  if (!(RELATIONSHIP_TYPES as readonly string[]).includes(parsed.type)) {
    throw new ReconError(
      'UnsupportedRelationshipType',
      `Relationship type ${parsed.type} is not a supported relationship`,
      { type: parsed.type },
    );
  }
  if (!ENTITY_REF_PATTERN.test(parsed.source_id)) {
    throw new ReconError(
      'InvalidRelationshipSource',
      'Relationship source_id must be an entity reference',
      { source_id: parsed.source_id },
    );
  }
  if (!ENTITY_REF_PATTERN.test(parsed.target_id)) {
    throw new ReconError(
      'InvalidRelationshipTarget',
      'Relationship target_id must be an entity reference',
      { target_id: parsed.target_id },
    );
  }
  if (parsed.provenance.length === 0) {
    throw new ReconError('MissingProvenance', 'Relationship requires at least one provenance record', {
      entity: 'Relationship',
      source_id: parsed.source_id,
      target_id: parsed.target_id,
    });
  }
  const provenance: Provenance[] = parsed.provenance.map(createProvenance);
  const id = relationshipContentId({
    type: parsed.type,
    source_id: parsed.source_id,
    target_id: parsed.target_id,
    metadata: parsed.metadata,
    provenance,
  });
  return parseOrThrow(
    RelationshipSchema,
    {
      ...parsed,
      provenance,
      created_at: parsed.created_at ?? new Date().toISOString(),
      id,
    },
    'Relationship',
  );
}

export type { RelationshipType };
