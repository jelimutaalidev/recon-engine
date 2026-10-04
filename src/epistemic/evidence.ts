import { z } from 'zod';
import { ReconError } from '../errors/errors.js';
import { parseOrThrow, timestampField } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';
import {
  ProvenanceInputSchema,
  ProvenanceSchema,
  createProvenance,
  type Provenance,
} from './provenance.js';
import { EPISTEMIC_REF_PATTERN } from './refs.js';

export const EVIDENCE_TYPES = [
  'static',
  'source',
  'onchain',
  'configuration',
  'historical',
  'documentation',
  'generated',
] as const;
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

const EvidenceInputSchema = z.strictObject({
  evidence_type: evidenceTypeSchema,
  description: z.string().trim().min(1),
  supports: z.array(z.string()).default([]),
  contradicts: z.array(z.string()).default([]),
  provenance: z.array(ProvenanceInputSchema).default([]),
  created_at: timestampField.optional(),
});

export const EvidenceSchema = z.strictObject({
  evidence_type: evidenceTypeSchema,
  description: z.string().trim().min(1),
  supports: z.array(z.string().regex(EPISTEMIC_REF_PATTERN)),
  contradicts: z.array(z.string().regex(EPISTEMIC_REF_PATTERN)),
  provenance: z.array(ProvenanceSchema),
  created_at: timestampField,
  id: z.string().regex(/^evidence:.+/),
});

export type EvidenceInput = z.input<typeof EvidenceInputSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;

export function evidenceContentId(evidence: Omit<Evidence, 'id' | 'created_at'>): string {
  return contentId('evidence', {
    evidence_type: evidence.evidence_type,
    description: evidence.description,
    supports: [...evidence.supports].sort(),
    contradicts: [...evidence.contradicts].sort(),
    provenance: evidence.provenance.map((record) => record.id).sort(),
  });
}

function assertEpistemicLinks(links: readonly string[], field: 'supports' | 'contradicts'): void {
  for (const link of links) {
    if (!EPISTEMIC_REF_PATTERN.test(link)) {
      throw new ReconError(
        'InvalidEvidenceReference',
        `Evidence ${field} must reference fact, observation, assumption, or hypothesis ids`,
        { field, reference: link },
      );
    }
  }
}

export function createEvidence(input: EvidenceInput): Evidence {
  const parsed = parseOrThrow(EvidenceInputSchema, input, 'Evidence');
  if (parsed.provenance.length === 0) {
    throw new ReconError('MissingProvenance', 'Evidence requires at least one provenance record', {
      entity: 'Evidence',
      description: parsed.description,
    });
  }
  assertEpistemicLinks(parsed.supports, 'supports');
  assertEpistemicLinks(parsed.contradicts, 'contradicts');
  const supportSet = new Set(parsed.supports);
  const conflict = parsed.contradicts.find((link) => supportSet.has(link));
  if (conflict !== undefined) {
    throw new ReconError(
      'ConflictingEvidence',
      'Evidence cannot support and contradict the same target',
      { target: conflict },
    );
  }
  if (parsed.supports.length === 0 && parsed.contradicts.length === 0) {
    throw new ReconError(
      'InvalidEvidenceReference',
      'Evidence must support or contradict at least one epistemic object',
      { entity: 'Evidence', description: parsed.description },
    );
  }
  const provenance: Provenance[] = parsed.provenance.map(createProvenance);
  const id = evidenceContentId({
    evidence_type: parsed.evidence_type,
    description: parsed.description,
    supports: parsed.supports,
    contradicts: parsed.contradicts,
    provenance,
  });
  return parseOrThrow(
    EvidenceSchema,
    {
      ...parsed,
      provenance,
      created_at: parsed.created_at ?? new Date().toISOString(),
      id,
    },
    'Evidence',
  );
}
