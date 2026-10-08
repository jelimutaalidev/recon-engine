import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import { makeEsmUnknown, type UnknownRecord } from './unknown.js';

const ACCESS_ID_PREFIX: EsmIdPrefix = 'seme:';

const UNKNOWN_LOCATION = 'unknown' as const;
const UNKNOWN_LOCATION_SCOPE = 'state-access-location';

export const StateAccessSchema = z
  .strictObject({
    id: z.string().regex(/^seme:.+/),
    location: z.union([z.literal('unknown'), z.string().regex(/^state:.+/)]),
    op: z.enum(['read', 'write', 'readwrite']),
    span: z
      .strictObject({
        file: z.string().min(1),
        line_start: z.number().int().min(1),
        line_end: z.number().int().min(1),
      })
      .refine((span) => span.line_end >= span.line_start, {
        message: 'line_end must be >= line_start',
      }),
    slot: z.string().min(1).optional(),
    subPath: z.literal('unknown'),
    scope: z.string().min(1),
    basis: z.array(z.string().min(1)).min(1),
  });

export type StateAccess = z.infer<typeof StateAccessSchema>;

interface SpanKey {
  file: string;
  line_start: number;
  line_end: number;
}

interface AccessGroup {
  location: string;
  span: SpanKey;
  reads: boolean;
  writes: boolean;
  edgeIds: Set<string>;
  scope: string;
  slot: string | undefined;
}

function groupKey(location: string, span: SpanKey): string {
  return JSON.stringify([location, span.file, span.line_start, span.line_end]);
}

export function deriveAccesses(index: EvidenceIndex): {
  accesses: StateAccess[];
  unknowns: UnknownRecord[];
} {
  const groups = new Map<string, AccessGroup>();
  const edges = [...index.relationshipsById.values()]
    .filter((edge) => edge.type === 'READS' || edge.type === 'WRITES')
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  for (const edge of edges) {
    const writes = edge.type === 'WRITES';
    const stateVar = index.stateVariablesById.get(edge.target_id);
    const fn = index.functionsById.get(edge.source_id);
    for (const record of edge.provenance) {
      if (record.file === undefined || record.line_start === undefined || record.line_end === undefined) {
        continue;
      }
      const span: SpanKey = {
        file: record.file,
        line_start: record.line_start,
        line_end: record.line_end,
      };
      const location = stateVar !== undefined ? stateVar.id : UNKNOWN_LOCATION;
      const key = groupKey(location, span);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          location,
          span,
          reads: false,
          writes: false,
          edgeIds: new Set<string>(),
          scope: stateVar?.contract_id ?? fn?.contract_id ?? UNKNOWN_LOCATION,
          slot: stateVar?.slot,
        };
        groups.set(key, group);
      }
      if (writes) group.writes = true;
      else group.reads = true;
      group.edgeIds.add(edge.id);
    }
  }

  const accesses: StateAccess[] = [];
  const unknowns: UnknownRecord[] = [];
  const seenUnknowns = new Set<string>();

  for (const group of groups.values()) {
    const op: StateAccess['op'] =
      group.reads && group.writes ? 'readwrite' : group.writes ? 'write' : 'read';
    const basis = [...group.edgeIds];
    if (group.location !== UNKNOWN_LOCATION) basis.push(group.location);
    basis.sort(compareCodeUnits);
    const id = esmContentId(ACCESS_ID_PREFIX, {
      location: group.location,
      op,
      span: group.span,
    });
    accesses.push(
      StateAccessSchema.parse({
        id,
        location: group.location,
        op,
        span: group.span,
        ...(group.slot !== undefined ? { slot: group.slot } : {}),
        subPath: UNKNOWN_LOCATION,
        scope: group.scope,
        basis,
      }),
    );
    if (group.location === UNKNOWN_LOCATION) {
      const unknown = makeEsmUnknown(
        UNKNOWN_LOCATION_SCOPE,
        'location-unidentified',
        [...group.edgeIds].sort(compareCodeUnits),
      );
      if (!seenUnknowns.has(unknown.id)) {
        seenUnknowns.add(unknown.id);
        unknowns.push(unknown);
      }
    }
  }

  accesses.sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { accesses, unknowns };
}
