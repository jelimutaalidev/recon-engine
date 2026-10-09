import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import { deriveAccesses } from './access.js';
import { deriveBoundaries } from './external.js';
import { deriveTemporals } from './temporal.js';
import { deriveConditions } from './conditions.js';
import { deriveContexts } from './context.js';
import { deriveInfluence } from './influence.js';
import { derivePaths } from './path.js';
import { composeFunction, type ComposedSummary } from './compose.js';
import { finalizeEsm, type EsmArtifact, type EsmDraft } from './envelope.js';
import type { UnknownRecord } from './unknown.js';
import { createUnknownCollector } from './unknown.js';

interface EsmDerivation {
  accesses: ReturnType<typeof deriveAccesses>['accesses'];
  boundaries: ReturnType<typeof deriveBoundaries>['boundaries'];
  temporals: ReturnType<typeof deriveTemporals>['temporals'];
  conditions: ReturnType<typeof deriveConditions>['conditions'];
  contexts: ReturnType<typeof deriveContexts>['contexts'];
  influence: ReturnType<typeof deriveInfluence>['influence'];
  paths: ReturnType<typeof derivePaths>['paths'];
  primitiveUnknowns: UnknownRecord[];
  summaries: ComposedSummary[];
  composedUnknowns: UnknownRecord[];
}

// Spec §12.8(1): one shared internal derivation pass. Both public APIs
// are thin projections of this helper's result: a single execution per
// function through the single composeFunction implementation. No cache,
// memoization, or shared mutable state — each call recomputes purely.
function deriveEsmDerivation(index: EvidenceIndex): EsmDerivation {
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
  const summaries: ComposedSummary[] = [];
  const collector = createUnknownCollector();
  const composedUnknowns = collector.unknowns;
  for (const functionId of functionIds) {
    const composed = composeFunction(index, functionId, composeParts);
    summaries.push(composed.summary);
    for (const unknown of composed.unknowns) {
      collector.pushRecord(unknown);
    }
  }
  summaries.sort(
    (a, b) =>
      compareCodeUnits(a.owner.function, b.owner.function) ||
      compareCodeUnits(a.owner.contract, b.owner.contract),
  );
  return {
    accesses: accesses.accesses,
    boundaries: boundaries.boundaries,
    temporals: temporals.temporals,
    conditions: conditions.conditions,
    contexts: contexts.contexts,
    influence: influence.influence,
    paths: paths.paths,
    primitiveUnknowns: [
      ...accesses.unknowns,
      ...boundaries.unknowns,
      ...temporals.unknowns,
      ...conditions.unknowns,
      ...contexts.unknowns,
      ...influence.unknowns,
      ...paths.unknowns,
    ],
    summaries,
    composedUnknowns,
  };
}

export function deriveEsm(index: EvidenceIndex): EsmArtifact {
  const derived = deriveEsmDerivation(index);
  const unknownsById = new Map<string, UnknownRecord>();
  for (const unknown of [...derived.primitiveUnknowns, ...derived.composedUnknowns]) {
    if (!unknownsById.has(unknown.id)) unknownsById.set(unknown.id, unknown);
  }
  const draft: EsmDraft = {
    schema_version: 'esem-model/v1',
    inputs: {
      state_output_hash: index.stateHash,
      fidelity: index.input.meta.fidelity,
      file_count: index.input.meta.fileCount,
    },
    influences: derived.influence,
    conditions: derived.conditions,
    paths: derived.paths,
    contexts: derived.contexts,
    accesses: derived.accesses,
    boundaries: derived.boundaries,
    temporals: derived.temporals,
    unknowns: [...unknownsById.values()],
  };
  return finalizeEsm(draft);
}

// Spec §12.8(1,3): deterministic transient projection. Summaries and
// unknowns only — never envelope, counts, or esem_hash. Same single
// pass as deriveEsm (unknown id-set equivalence holds by construction).
export function deriveCompositions(index: EvidenceIndex): {
  summaries: ComposedSummary[];
  unknowns: UnknownRecord[];
} {
  const derived = deriveEsmDerivation(index);
  const unknowns = [...derived.composedUnknowns].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  return { summaries: derived.summaries, unknowns };
}
