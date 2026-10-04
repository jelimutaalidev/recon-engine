import { ReconError } from '../errors/errors.js';
import { parseOrThrow } from '../domain/helpers.js';
import { ReconStateSchema, type ReconState, type ReconStateInput } from './schema.js';
import { validateReconState } from './validate.js';

export function createReconState(input: ReconStateInput): ReconState {
  const parsed = parseOrThrow(ReconStateSchema, input, 'ReconState');
  const provenanceProvided =
    typeof input === 'object' &&
    input !== null &&
    Object.prototype.hasOwnProperty.call(input, 'provenance');
  return validateReconState(parsed, { provenanceProvided });
}

function sortCollection<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export function serializeReconState(state: ReconState): string {
  const canonical = {
    schema_version: state.schema_version,
    project: state.project,
    contracts: sortCollection(state.contracts),
    functions: sortCollection(state.functions),
    state_variables: sortCollection(state.state_variables),
    assets: sortCollection(state.assets),
    roles: sortCollection(state.roles),
    dependencies: sortCollection(state.dependencies),
    relationships: sortCollection(state.relationships),
    facts: sortCollection(state.facts),
    observations: sortCollection(state.observations),
    assumptions: sortCollection(state.assumptions),
    hypotheses: sortCollection(state.hypotheses),
    evidence: sortCollection(state.evidence),
    provenance: sortCollection(state.provenance),
  };
  return JSON.stringify(canonical, null, 2);
}

export function deserializeReconState(json: string): ReconState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ReconError('InvalidReconState', 'ReconState JSON is malformed', {
      length: json.length,
    });
  }
  return createReconState(raw as ReconStateInput);
}
