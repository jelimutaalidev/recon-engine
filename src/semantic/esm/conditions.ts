import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import { makeEsmUnknown, type UnknownRecord } from './unknown.js';

const CONDITION_ID_PREFIX: EsmIdPrefix = 'seme:';

const SOURCE_SPAN_PATTERN = /^(.+):(\d+)-(\d+)$/;

const FLAGGED_CONSTRUCT_PREFIX = 'unsupported_';
const BUILTIN_CODE = 'unsupported_builtin';

const CUSTOM_ERROR_PREFIX = 'custom-error:';

const MISSING_MODIFIER_SCOPE = 'modifier-gate';

export const ConditionSchema = z.strictObject({
  id: z.string().regex(/^seme:.+/),
  kind: z.enum(['modifier-gate', 'visibility-gate', 'mutability-gate', 'unresolved-branch']),
  function: z.string().min(1),
  descriptor: z.string().min(1),
  basis: z.array(z.string().min(1)).min(1),
});

export type Condition = z.infer<typeof ConditionSchema>;

type ConditionKind = Condition['kind'];

interface FunctionSpan {
  file: string;
  lineStart: number;
  lineEnd: number;
}

function parseFunctionSpan(source: string | undefined): FunctionSpan | undefined {
  if (source === undefined) return undefined;
  const parsed = SOURCE_SPAN_PATTERN.exec(source);
  if (
    parsed === null ||
    parsed[1] === undefined ||
    parsed[2] === undefined ||
    parsed[3] === undefined
  ) {
    return undefined;
  }
  const lineStart = Number(parsed[2]);
  const lineEnd = Number(parsed[3]);
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return undefined;
  return { file: parsed[1], lineStart, lineEnd };
}

interface ConstructOccurrence {
  file: string;
  lineStart: number;
  lineEnd: number;
  descriptor: string;
}

function attributeContainer(
  occurrence: ConstructOccurrence,
  index: EvidenceIndex,
): string | undefined {
  const containers: string[] = [];
  const candidates = [...index.functionsById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  for (const fn of candidates) {
    const span = parseFunctionSpan(fn.source);
    if (span === undefined) continue;
    if (span.file !== occurrence.file) continue;
    if (span.lineStart <= occurrence.lineStart && occurrence.lineEnd <= span.lineEnd) {
      containers.push(fn.id);
    }
  }
  if (containers.length === 1) return containers[0] as string;
  return undefined;
}

export function deriveConditions(index: EvidenceIndex): {
  conditions: Condition[];
  unknowns: UnknownRecord[];
} {
  const byId = new Map<string, Condition>();
  const branchBasis = new Map<string, Set<string>>();

  const pushCondition = (
    kind: ConditionKind,
    functionId: string,
    descriptor: string,
    basis: string[],
  ): void => {
    const id = esmContentId(CONDITION_ID_PREFIX, { kind, function: functionId, descriptor });
    if (byId.has(id)) {
      const extra = branchBasis.get(id);
      if (extra !== undefined) {
        for (const entry of basis) extra.add(entry);
      }
      return;
    }
    byId.set(
      id,
      ConditionSchema.parse({ id, kind, function: functionId, descriptor, basis }),
    );
    if (kind === 'unresolved-branch') {
      branchBasis.set(id, new Set(basis));
    }
  };

  const functions = [...index.functionsById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );

  for (const fn of functions) {
    for (const modifier of fn.modifiers) {
      pushCondition('modifier-gate', fn.id, modifier, [fn.id]);
    }
    pushCondition('visibility-gate', fn.id, fn.visibility, [fn.id]);
    pushCondition('mutability-gate', fn.id, fn.mutability, [fn.id]);
  }

  const occurrences: Array<{ code: string; occurrence: ConstructOccurrence }> = [];
  for (const bucket of index.issuesByFile.values()) {
    for (const issue of bucket) {
      if (!issue.code.startsWith(FLAGGED_CONSTRUCT_PREFIX)) continue;
      if (issue.code === BUILTIN_CODE) continue;
      if (issue.file === undefined) continue;
      if (
        issue.line_start === undefined ||
        issue.line_end === undefined ||
        !Number.isInteger(issue.line_start) ||
        !Number.isInteger(issue.line_end) ||
        issue.line_end < issue.line_start
      ) {
        continue;
      }
      occurrences.push({
        code: issue.code,
        occurrence: {
          file: issue.file,
          lineStart: issue.line_start,
          lineEnd: issue.line_end,
          descriptor: `${issue.code}@${issue.file}:${issue.line_start}-${issue.line_end}`,
        },
      });
    }
  }
  occurrences.sort((a, b) => compareCodeUnits(a.occurrence.descriptor, b.occurrence.descriptor));

  for (const { code, occurrence } of occurrences) {
    const functionId = attributeContainer(occurrence, index);
    if (functionId === undefined) continue;
    pushCondition('unresolved-branch', functionId, code, [functionId, occurrence.descriptor]);
  }

  const usesFacts = [...index.factsById.values()]
    .filter(
      (fact) =>
        fact.predicate === 'USES' &&
        typeof fact.value === 'string' &&
        fact.value.startsWith(CUSTOM_ERROR_PREFIX) &&
        fact.value.length > CUSTOM_ERROR_PREFIX.length,
    )
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  for (const fact of usesFacts) {
    if (!index.functionsById.has(fact.subject_id)) continue;
    pushCondition('unresolved-branch', fact.subject_id, fact.value as string, [
      fact.subject_id,
      fact.id,
    ]);
  }

  for (const [id, extra] of branchBasis) {
    const record = byId.get(id);
    if (record === undefined) continue;
    const basis = [...extra].sort(compareCodeUnits);
    byId.set(id, ConditionSchema.parse({ ...record, basis }));
  }

  const unknowns: UnknownRecord[] = [];
  for (const fn of functions) {
    if (fn.modifiers.length === 0) {
      unknowns.push(makeEsmUnknown(MISSING_MODIFIER_SCOPE, 'no_evidence', [fn.id]));
    }
  }

  const conditions = [...byId.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { conditions, unknowns };
}
