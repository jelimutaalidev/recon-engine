import { z } from 'zod';

export const RELATIONSHIP_TYPES = [
  'CALLS',
  'READS',
  'WRITES',
  'EMITS',
  'INHERITS',
  'IMPLEMENTS',
  'USES',
  'DEPENDS_ON',
  'DELEGATES_TO',
  'UPGRADES',
  'CONTROLS',
  'PROTECTS',
  'MINTS',
  'BURNS',
  'TRANSFERS',
  'PRICES',
  'CUSTODIES',
  'INITIALIZES',
] as const;

export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;
