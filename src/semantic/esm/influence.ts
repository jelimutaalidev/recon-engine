import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import { createUnknownCollector, makeEsmUnknown, type UnknownRecord } from './unknown.js';
import type { StateAccess } from './access.js';
import type { Condition } from './conditions.js';
import type { ExternalResult } from './external.js';

const INFLUENCE_ID_PREFIX: EsmIdPrefix = 'seme:';

export const INFLUENCE_DECLARATION =
  'capable under stated evidence; materialization UNKNOWN' as const;

const UNKNOWN_LOCATION = 'unknown' as const;
const UNKNOWN_TARGET = 'unknown' as const;

const ARG_PARAM_SCOPE = 'influence-arg-param';

const FROM_PATTERN = /^(gate|state-version|call-site|external-boundary|ambient-source):.+/;
const TO_PATTERN = /^state-version:.+/;

export const InfluenceEdgeSchema = z.strictObject({
  id: z.string().regex(/^seme:.+/),
  kind: z.enum(['data-supported', 'control-supported', 'call-supported']),
  from: z.string().regex(FROM_PATTERN),
  to: z.string().regex(TO_PATTERN),
  evidence: z.array(z.string().min(1)).min(1),
  eclass: z.enum(['E1', 'E2', 'E3']),
  declaration: z.literal(INFLUENCE_DECLARATION),
  basis: z.array(z.string().min(1)).min(1),
});

export type InfluenceEdge = z.infer<typeof InfluenceEdgeSchema>;

export interface InfluenceParts {
  accesses: StateAccess[];
  conditions: Condition[];
  boundaries: ExternalResult[];
}

interface AccessOwners {
  owners: string[];
  writeIds: string[];
  readIds: string[];
  effectIds: string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function attributeAccess(index: EvidenceIndex, access: StateAccess): AccessOwners {
  const owners = new Set<string>();
  const writeIds = new Set<string>();
  const readIds = new Set<string>();
  for (const entry of access.basis) {
    if (!entry.startsWith('rel:')) continue;
    const edge = index.relationshipsById.get(entry);
    if (edge === undefined) continue;
    if (edge.type !== 'READS' && edge.type !== 'WRITES') continue;
    if (!index.functionsById.has(edge.source_id)) continue;
    owners.add(edge.source_id);
    if (edge.type === 'WRITES') writeIds.add(edge.id);
    else readIds.add(edge.id);
  }
  return {
    owners: [...owners].sort(compareCodeUnits),
    writeIds: [...writeIds].sort(compareCodeUnits),
    readIds: [...readIds].sort(compareCodeUnits),
    effectIds: [...writeIds, ...readIds].sort(compareCodeUnits),
  };
}

function stateVersion(location: string, functionId: string): string {
  return `state-version:${location}@${functionId}`;
}

export function deriveInfluence(
  index: EvidenceIndex,
  parts: InfluenceParts,
): { influence: InfluenceEdge[]; unknowns: UnknownRecord[] } {
  const byId = new Map<string, InfluenceEdge>();
  const collector = createUnknownCollector();
  const unknowns = collector.unknowns;

  const pushEdge = (
    kind: InfluenceEdge['kind'],
    from: string,
    to: string,
    evidence: string[],
    basis: string[],
  ): void => {
    const sortedEvidence = [...evidence].sort(compareCodeUnits);
    const id = esmContentId(INFLUENCE_ID_PREFIX, { kind, from, to, evidence: sortedEvidence });
    if (byId.has(id)) return;
    byId.set(
      id,
      InfluenceEdgeSchema.parse({
        id,
        kind,
        from,
        to,
        evidence: sortedEvidence,
        eclass: 'E2',
        declaration: INFLUENCE_DECLARATION,
        basis: sortedUnique(basis),
      }),
    );
  };

  const pushUnknown = collector.pushRecord.bind(collector);

  const knownAccesses = parts.accesses
    .filter((access) => access.location !== UNKNOWN_LOCATION)
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  const attribution = new Map<string, AccessOwners>();
  for (const access of knownAccesses) {
    attribution.set(access.id, attributeAccess(index, access));
  }

  const unknownTargetSites = new Set<string>();
  for (const boundary of parts.boundaries) {
    if (boundary.target === UNKNOWN_TARGET) unknownTargetSites.add(boundary.site);
  }

  const resolvedCalls = [...index.relationshipsById.values()]
    .filter(
      (edge) =>
        edge.type === 'CALLS' &&
        index.functionsById.has(edge.source_id) &&
        index.functionsById.has(edge.target_id) &&
        !unknownTargetSites.has(edge.id),
    )
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  const callsByPair = new Map<string, { id: string }[]>();
  for (const edge of resolvedCalls) {
    const key = JSON.stringify([edge.source_id, edge.target_id]);
    const bucket = callsByPair.get(key);
    if (bucket === undefined) callsByPair.set(key, [{ id: edge.id }]);
    else bucket.push({ id: edge.id });
  }

  const effectsByFunction = new Map<string, { access: StateAccess; owners: AccessOwners }[]>();
  for (const access of knownAccesses) {
    const owners = attribution.get(access.id) as AccessOwners;
    if (owners.effectIds.length === 0 || owners.owners.length === 0) continue;
    for (const owner of owners.owners) {
      const bucket = effectsByFunction.get(owner);
      const entry = { access, owners };
      if (bucket === undefined) effectsByFunction.set(owner, [entry]);
      else bucket.push(entry);
    }
  }

  const conditions = [...parts.conditions].sort((a, b) => compareCodeUnits(a.id, b.id));

  for (const writeAccess of knownAccesses) {
    const writeOwners = attribution.get(writeAccess.id) as AccessOwners;
    if (writeAccess.op !== 'write' && writeAccess.op !== 'readwrite') continue;
    if (writeOwners.writeIds.length === 0) continue;
    for (const readAccess of knownAccesses) {
      const readOwners = attribution.get(readAccess.id) as AccessOwners;
      if (readAccess.op !== 'read' && readAccess.op !== 'readwrite') continue;
      if (readOwners.readIds.length === 0) continue;
      if (writeAccess.location !== readAccess.location) continue;
      for (const writer of writeOwners.owners) {
        for (const reader of readOwners.owners) {
          if (writer === reader) continue;
          const hops = callsByPair.get(JSON.stringify([writer, reader])) ?? [];
          for (const hop of hops) {
            pushEdge(
              'data-supported',
              stateVersion(writeAccess.location, writer),
              stateVersion(readAccess.location, reader),
              [...writeOwners.writeIds, ...readOwners.readIds, hop.id],
              [
                ...writeOwners.writeIds,
                ...readOwners.readIds,
                hop.id,
                writeAccess.location,
                writer,
                reader,
              ],
            );
          }
        }
      }
    }
  }

  for (const condition of conditions) {
    const effects = effectsByFunction.get(condition.function) ?? [];
    for (const { access, owners } of effects) {
      pushEdge(
        'control-supported',
        `gate:${condition.id}`,
        stateVersion(access.location, condition.function),
        [condition.id, ...owners.effectIds],
        [...owners.effectIds, ...condition.basis, access.location],
      );
    }
  }

  for (const edge of resolvedCalls) {
    const effects = effectsByFunction.get(edge.target_id) ?? [];
    for (const { access, owners } of effects) {
      pushEdge(
        'call-supported',
        `call-site:${edge.id}`,
        stateVersion(access.location, edge.target_id),
        [edge.id, ...owners.effectIds],
        [edge.id, ...owners.effectIds, access.location, edge.source_id, edge.target_id],
      );
    }
  }

  for (const edge of resolvedCalls) {
    const effects = effectsByFunction.get(edge.target_id) ?? [];
    if (effects.length === 0) {
      pushUnknown(makeEsmUnknown(ARG_PARAM_SCOPE, 'no_evidence', [edge.id]));
    }
  }

  const influence = [...byId.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { influence, unknowns };
}
