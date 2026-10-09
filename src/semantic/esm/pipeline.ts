import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { deriveAccesses } from './access.js';
import { deriveBoundaries } from './external.js';
import { deriveTemporals } from './temporal.js';
import { deriveConditions } from './conditions.js';
import { deriveContexts } from './context.js';
import { deriveInfluence } from './influence.js';
import { derivePaths } from './path.js';
import { composeFunction } from './compose.js';
import { finalizeEsm, type EsmArtifact, type EsmDraft } from './envelope.js';
import type { UnknownRecord } from './unknown.js';

export function deriveEsm(index: EvidenceIndex): EsmArtifact {
  const accesses = deriveAccesses(index);
  const boundaries = deriveBoundaries(index);
  const temporals = deriveTemporals(index);
  const conditions = deriveConditions(index);
  const contexts = deriveContexts(index);
  const influence = deriveInfluence(index, {
    accesses: accesses.accesses,
    conditions: conditions.conditions,
    boundaries: boundaries.boundaries,
  });
  const paths = derivePaths(index, {
    influence: influence.influence,
    conditions: conditions.conditions,
  });
  const composeParts = {
    accesses: accesses.accesses,
    conditions: conditions.conditions,
    boundaries: boundaries.boundaries,
    temporals: temporals.temporals,
    contexts: contexts.contexts,
    influence: influence.influence,
    paths: paths.paths,
  };
  const functionIds = [...index.functionsById.keys()].sort(compareCodeUnits);
  const composedUnknowns: UnknownRecord[] = [];
  for (const functionId of functionIds) {
    const composed = composeFunction(index, functionId, composeParts);
    for (const unknown of composed.unknowns) composedUnknowns.push(unknown);
  }
  const unknownsById = new Map<string, UnknownRecord>();
  for (const unknown of [
    ...accesses.unknowns,
    ...boundaries.unknowns,
    ...temporals.unknowns,
    ...conditions.unknowns,
    ...contexts.unknowns,
    ...influence.unknowns,
    ...paths.unknowns,
    ...composedUnknowns,
  ]) {
    if (!unknownsById.has(unknown.id)) unknownsById.set(unknown.id, unknown);
  }
  const draft: EsmDraft = {
    schema_version: 'esem-model/v1',
    inputs: {
      state_output_hash: index.stateHash,
      fidelity: index.input.meta.fidelity,
      file_count: index.input.meta.fileCount,
    },
    influences: influence.influence,
    conditions: conditions.conditions,
    paths: paths.paths,
    contexts: contexts.contexts,
    accesses: accesses.accesses,
    boundaries: boundaries.boundaries,
    temporals: temporals.temporals,
    unknowns: [...unknownsById.values()],
  };
  return finalizeEsm(draft);
}
