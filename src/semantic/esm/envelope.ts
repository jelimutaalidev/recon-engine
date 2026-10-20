import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ReconError } from '../../errors/errors.js';
import { compareCodeUnits, stableStringify } from '../../util/canonical.js';
import { StateAccessSchema } from './access.js';
import { ConditionSchema } from './conditions.js';
import { ExecutionContextSchema } from './context.js';
import { ExternalResultSchema } from './external.js';
import { InfluenceEdgeSchema } from './influence.js';
import { SemPathSchema } from './path.js';
import { TemporalSourceSchema } from './temporal.js';
import { EsmUnknownRecordSchema } from './unknown.js';

const HEX_64 = /^[0-9a-f]{64}$/;

export const EsmInputsSchema = z.strictObject({
  state_output_hash: z.string().regex(HEX_64),
  fidelity: z.enum(['semantic', 'syntactic']),
  scope_hash: z.string().min(1).optional(),
  file_count: z.number().int().min(0),
});
export type EsmInputs = z.infer<typeof EsmInputsSchema>;

export const EsmCountsSchema = z.strictObject({
  influences: z.number().int().min(0),
  conditions: z.number().int().min(0),
  paths: z.number().int().min(0),
  contexts: z.number().int().min(0),
  accesses: z.number().int().min(0),
  boundaries: z.number().int().min(0),
  temporals: z.number().int().min(0),
  unknowns: z.number().int().min(0),
});
export type EsmCounts = z.infer<typeof EsmCountsSchema>;

const draftShape = {
  schema_version: z.literal('esem-model/v1'),
  inputs: EsmInputsSchema,
  influences: z.array(InfluenceEdgeSchema),
  conditions: z.array(ConditionSchema),
  paths: z.array(SemPathSchema),
  contexts: z.array(ExecutionContextSchema),
  accesses: z.array(StateAccessSchema),
  boundaries: z.array(ExternalResultSchema),
  temporals: z.array(TemporalSourceSchema),
  unknowns: z.array(EsmUnknownRecordSchema),
} as const;

export const EsmDraftSchema = z.strictObject(draftShape);
export type EsmDraft = z.infer<typeof EsmDraftSchema>;

export const EsmArtifactSchema = z.strictObject({
  ...draftShape,
  counts: EsmCountsSchema,
  esem_hash: z.string().regex(HEX_64),
});
export type EsmArtifact = z.infer<typeof EsmArtifactSchema>;

type UnhashedEsm = Omit<EsmArtifact, 'esem_hash'>;

function parseDraft(draft: EsmDraft): EsmDraft {
  const parsed = EsmDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ReconError('InvalidSemanticModel', `ESM draft failed schema validation: ${detail}`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function collectIdLists(draft: EsmDraft): Array<{ name: string; ids: string[] }> {
  return [
    { name: 'influences', ids: draft.influences.map((record) => record.id) },
    { name: 'conditions', ids: draft.conditions.map((record) => record.id) },
    { name: 'paths', ids: draft.paths.map((record) => record.id) },
    { name: 'contexts', ids: draft.contexts.map((record) => record.id) },
    { name: 'accesses', ids: draft.accesses.map((record) => record.id) },
    { name: 'boundaries', ids: draft.boundaries.map((record) => record.id) },
    { name: 'temporals', ids: draft.temporals.map((record) => record.id) },
    { name: 'unknowns', ids: draft.unknowns.map((record) => record.id) },
  ];
}

function assertUniqueIds(draft: EsmDraft): void {
  const seen = new Set<string>();
  for (const { name, ids } of collectIdLists(draft)) {
    for (const id of ids) {
      if (seen.has(id)) {
        throw new ReconError('InvalidSemanticModel', `duplicate id '${id}' in ${name}`, {
          id,
          array: name,
        });
      }
      seen.add(id);
    }
  }
}

function sortById<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function hashCanonical(value: UnhashedEsm): string {
  const { inputs, ...rest } = value;
  const { scope_hash: _scope, ...inputsRest } = inputs;
  void _scope;
  const payload = { ...rest, inputs: inputsRest };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function computeEsmHash(model: EsmArtifact): string {
  const { esem_hash: _stripped, ...unhashed } = model;
  void _stripped;
  return hashCanonical(unhashed as UnhashedEsm);
}

export function finalizeEsm(draft: EsmDraft): EsmArtifact {
  const parsed = parseDraft(draft);
  assertUniqueIds(parsed);
  const unhashed: UnhashedEsm = {
    schema_version: parsed.schema_version,
    inputs: { ...parsed.inputs },
    influences: sortById(parsed.influences),
    conditions: sortById(parsed.conditions),
    paths: sortById(parsed.paths),
    contexts: sortById(parsed.contexts),
    accesses: sortById(parsed.accesses),
    boundaries: sortById(parsed.boundaries),
    temporals: sortById(parsed.temporals),
    unknowns: sortById(parsed.unknowns),
    counts: {
      influences: parsed.influences.length,
      conditions: parsed.conditions.length,
      paths: parsed.paths.length,
      contexts: parsed.contexts.length,
      accesses: parsed.accesses.length,
      boundaries: parsed.boundaries.length,
      temporals: parsed.temporals.length,
      unknowns: parsed.unknowns.length,
    },
  };
  const esem_hash = hashCanonical(unhashed);
  const reparsed = EsmArtifactSchema.safeParse({ ...unhashed, esem_hash });
  if (!reparsed.success) {
    const detail = reparsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ReconError(
      'InvalidSemanticModel',
      `finalized ESM artifact failed schema validation: ${detail}`,
      {
        issues: reparsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return reparsed.data;
}

export function serializeEsm(model: EsmArtifact): string {
  return stableStringify(model);
}
