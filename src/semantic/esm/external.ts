import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import { createUnknownCollector, makeEsmUnknown, type UnknownRecord } from './unknown.js';

const BOUNDARY_ID_PREFIX: EsmIdPrefix = 'seme:';

const INTERNAL_KIND = 'internal';

const UNKNOWN_TARGET = 'unknown' as const;
const UNKNOWN_RETURN_LINK = 'unknown' as const;
const UNKNOWN_RESULT = 'unknown' as const;

const BOUNDARY_SCOPE = 'external-boundary';
const TARGET_SCOPE = 'external-target';
const RETURN_LINK_SCOPE = 'external-return-linkage';
const RESULT_SCOPE = 'external-result';

const MARKER_VALUES: ReadonlySet<string> = new Set<string>([
  'unresolved-delegatecall',
  'unresolved-staticcall',
  'unresolved-lowlevel-call',
  'unresolved-indirect-call',
]);

export const ExternalResultSchema = z.strictObject({
  id: z.string().regex(/^seme:.+/),
  site: z.string().min(1),
  kind: z.string().min(1),
  target: z.string().min(1),
  returnLink: z.literal(UNKNOWN_RETURN_LINK),
  result: z.literal(UNKNOWN_RESULT),
  basis: z.array(z.string().min(1)).min(1),
});

export type ExternalResult = z.infer<typeof ExternalResultSchema>;

export function deriveBoundaries(index: EvidenceIndex): {
  boundaries: ExternalResult[];
  unknowns: UnknownRecord[];
} {
  const boundaries: ExternalResult[] = [];
  const collector = createUnknownCollector();
  const unknowns = collector.unknowns;
  const pushUnknown = collector.pushRecord.bind(collector);

  const pushReturnUnknowns = (siteId: string): void => {
    pushUnknown(makeEsmUnknown(RETURN_LINK_SCOPE, 'no-return-linkage', [siteId]));
    pushUnknown(makeEsmUnknown(RESULT_SCOPE, 'no-return-linkage', [siteId]));
  };

  const pushBoundary = (site: string, kind: string, target: string, basis: string[]): void => {
    const id = esmContentId(BOUNDARY_ID_PREFIX, { site, kind, target });
    boundaries.push(
      ExternalResultSchema.parse({
        id,
        site,
        kind,
        target,
        returnLink: UNKNOWN_RETURN_LINK,
        result: UNKNOWN_RESULT,
        basis,
      }),
    );
  };

  const edges = [...index.relationshipsById.values()]
    .filter((edge) => edge.type === 'CALLS')
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  for (const edge of edges) {
    const rawKind = edge.metadata?.call_kind;
    if (typeof rawKind !== 'string' || rawKind.length === 0) {
      pushUnknown(makeEsmUnknown(BOUNDARY_SCOPE, 'no_evidence', [edge.id]));
      continue;
    }
    if (rawKind === INTERNAL_KIND) continue;
    const resolved = index.functionsById.has(edge.target_id);
    const target = resolved ? edge.target_id : UNKNOWN_TARGET;
    pushBoundary(edge.id, rawKind, target, [edge.id]);
    if (!resolved) {
      pushUnknown(makeEsmUnknown(TARGET_SCOPE, 'out_of_scope_target', [edge.id]));
    }
    pushReturnUnknowns(edge.id);
  }

  const markers = [...index.factsById.values()]
    .filter(
      (fact) =>
        (fact.predicate === 'CALLS' || fact.predicate === 'DELEGATES_TO') &&
        typeof fact.value === 'string' &&
        MARKER_VALUES.has(fact.value),
    )
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  for (const fact of markers) {
    const kind = fact.value as string;
    pushBoundary(fact.id, kind, fact.id, [fact.id]);
    pushUnknown(makeEsmUnknown(TARGET_SCOPE, 'unresolved_call', [fact.id]));
    pushReturnUnknowns(fact.id);
  }

  boundaries.sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { boundaries, unknowns };
}
