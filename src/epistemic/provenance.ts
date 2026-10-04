import { z } from 'zod';
import { ReconError } from '../errors/errors.js';
import { addressField, parseOrThrow } from '../domain/helpers.js';
import { contentId } from '../ids/ids.js';

export const PROVENANCE_SOURCE_TYPES = [
  'source_code',
  'bytecode',
  'abi',
  'deployment',
  'documentation',
  'configuration',
  'git_history',
  'audit',
  'issue',
  'onchain',
  'generated',
  'llm_inference',
] as const;

export const provenanceSourceTypeSchema = z.enum(PROVENANCE_SOURCE_TYPES);
export type ProvenanceSourceType = z.infer<typeof provenanceSourceTypeSchema>;

const ProvenanceShape = {
  source_type: provenanceSourceTypeSchema,
  location: z.string().trim().min(1).optional(),
  repository: z.string().trim().min(1).optional(),
  commit: z.string().trim().min(1).optional(),
  file: z.string().trim().min(1).optional(),
  line_start: z.number().int().min(1).optional(),
  line_end: z.number().int().min(1).optional(),
  chain_id: z.string().trim().toLowerCase().min(1).optional(),
  address: addressField.optional(),
  block_number: z.number().int().min(0).optional(),
  description: z.string().trim().min(1).optional(),
  unavailable: z.boolean().optional(),
} as const;

const lineOrderRule = {
  message: 'line_end must be >= line_start',
} as const;

function lineEndAfterStart(value: {
  line_start?: number | undefined;
  line_end?: number | undefined;
}): boolean {
  return (
    value.line_end === undefined ||
    value.line_start === undefined ||
    value.line_end >= value.line_start
  );
}

export const ProvenanceInputSchema = z.strictObject(ProvenanceShape).refine(lineEndAfterStart, lineOrderRule);

export const ProvenanceSchema = z
  .strictObject({
    ...ProvenanceShape,
    id: z.string().regex(/^prov:.+/),
  })
  .refine(lineEndAfterStart, lineOrderRule);

export type ProvenanceInput = z.input<typeof ProvenanceInputSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;

function assertSourceReference(
  provenance: Omit<Provenance, 'id'>,
  sourceType: ProvenanceSourceType,
): void {
  if (provenance.unavailable === true) {
    if (provenance.description === undefined) {
      throw new ReconError(
        'InvalidSourceReference',
        'explicitly unavailable provenance must state why it is unavailable',
        { source_type: sourceType, field: 'description' },
      );
    }
    return;
  }
  switch (sourceType) {
    case 'source_code':
      if (provenance.file === undefined && provenance.location === undefined) {
        throw new ReconError(
          'InvalidSourceReference',
          'source_code provenance requires file or location',
          { source_type: sourceType },
        );
      }
      return;
    case 'onchain':
      if (
        provenance.chain_id === undefined ||
        (provenance.address === undefined && provenance.location === undefined)
      ) {
        throw new ReconError(
          'InvalidSourceReference',
          'onchain provenance requires chain_id and address or location',
          { source_type: sourceType },
        );
      }
      return;
    case 'deployment':
      if (provenance.chain_id === undefined || provenance.address === undefined) {
        throw new ReconError(
          'InvalidSourceReference',
          'deployment provenance requires chain_id and address',
          { source_type: sourceType },
        );
      }
      return;
    case 'git_history':
      if (provenance.commit === undefined) {
        throw new ReconError(
          'InvalidSourceReference',
          'git_history provenance requires commit',
          { source_type: sourceType },
        );
      }
      return;
    default:
      return;
  }
}

function computeProvenanceId(provenance: Omit<Provenance, 'id'>): string {
  const { source_type, location, repository, commit, file, line_start, line_end, chain_id, address, block_number, description, unavailable } =
    provenance;
  return contentId('prov', {
    source_type,
    location,
    repository,
    commit,
    file,
    line_start,
    line_end,
    chain_id,
    address,
    block_number,
    description,
    unavailable,
  });
}

export function createProvenance(input: ProvenanceInput): Provenance {
  const parsed = parseOrThrow(ProvenanceInputSchema, input, 'Provenance');
  assertSourceReference(parsed, parsed.source_type);
  return parseOrThrow(ProvenanceSchema, { ...parsed, id: computeProvenanceId(parsed) }, 'Provenance');
}
