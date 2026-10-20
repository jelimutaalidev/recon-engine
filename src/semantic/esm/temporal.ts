import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import type { UnknownRecord } from './unknown.js';

const TEMPORAL_ID_PREFIX: EsmIdPrefix = 'seme:';

const UNKNOWN_KIND = 'UNKNOWN-kind' as const;

const BUILTIN_ISSUE_CODE = 'unsupported_builtin';

const SOURCE_SPAN_PATTERN = /^(.+):(\d+)-(\d+)$/;

const UNKNOWN_PLACEHOLDER = 'unknown' as const;

export const TemporalSourceSchema = z.strictObject({
  id: z.string().regex(/^seme:.+/),
  kind: z.literal(UNKNOWN_KIND),
  consumers: z.array(z.string().min(1)),
  basis: z.array(z.string().min(1)).min(1),
});

export type TemporalSource = z.infer<typeof TemporalSourceSchema>;

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

interface BuiltinOccurrence {
  file: string | undefined;
  lineStart: number | undefined;
  lineEnd: number | undefined;
  descriptor: string;
}

function occurrenceOf(issue: {
  code: string;
  message: string;
  file?: string;
  line_start?: number;
  line_end?: number;
}): BuiltinOccurrence {
  const file = issue.file;
  const lineStart = issue.line_start;
  const lineEnd = issue.line_end;
  const filePart = file ?? UNKNOWN_PLACEHOLDER;
  const linePart =
    lineStart !== undefined && lineEnd !== undefined
      ? `${lineStart}-${lineEnd}`
      : UNKNOWN_PLACEHOLDER;
  return {
    file,
    lineStart,
    lineEnd,
    descriptor: `${issue.code}@${filePart}:${linePart}:${issue.message}`,
  };
}

function attributeConsumers(
  occurrence: BuiltinOccurrence,
  index: EvidenceIndex,
): string[] {
  const { file, lineStart, lineEnd } = occurrence;
  if (file === undefined || lineStart === undefined || lineEnd === undefined) return [];
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineEnd < lineStart) {
    return [];
  }
  const containers: string[] = [];
  const candidates = [...index.functionsById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  for (const fn of candidates) {
    const span = parseFunctionSpan(fn.source);
    if (span === undefined) continue;
    if (span.file !== file) continue;
    if (span.lineStart <= lineStart && lineEnd <= span.lineEnd) containers.push(fn.id);
  }
  if (containers.length === 1) return [containers[0] as string];
  return [];
}

export function deriveTemporals(index: EvidenceIndex): {
  temporals: TemporalSource[];
  unknowns: UnknownRecord[];
} {
  const occurrences: BuiltinOccurrence[] = [];
  for (const bucket of index.issuesByFile.values()) {
    for (const issue of bucket) {
      if (issue.code !== BUILTIN_ISSUE_CODE) continue;
      occurrences.push(occurrenceOf(issue));
    }
  }
  occurrences.sort((a, b) => compareCodeUnits(a.descriptor, b.descriptor));

  const groups = new Map<string, { consumers: string[]; descriptors: Set<string> }>();
  for (const occurrence of occurrences) {
    const consumers = attributeConsumers(occurrence, index);
    const key = JSON.stringify(consumers);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { consumers, descriptors: new Set([occurrence.descriptor]) });
    } else {
      group.descriptors.add(occurrence.descriptor);
    }
  }

  const temporals: TemporalSource[] = [];
  for (const group of groups.values()) {
    const consumers = [...group.consumers].sort(compareCodeUnits);
    const basis = [...group.descriptors, ...group.consumers].sort(compareCodeUnits);
    const id = esmContentId(TEMPORAL_ID_PREFIX, { kind: UNKNOWN_KIND, consumers });
    temporals.push(
      TemporalSourceSchema.parse({
        id,
        kind: UNKNOWN_KIND,
        consumers,
        basis,
      }),
    );
  }
  temporals.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { temporals, unknowns: [] };
}
