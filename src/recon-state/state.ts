import { ReconError } from '../errors/errors.js';
import { parseOrThrow } from '../domain/helpers.js';
import { compareCodeUnits } from '../util/canonical.js';
import { ReconStateSchema, type ReconState, type ReconStateInput } from './schema.js';
import { validateReconState } from './validate.js';
import type { RunOutputRecord } from '../traceability/types.js';

export function createReconState(input: ReconStateInput): ReconState {
  const parsed = parseOrThrow(ReconStateSchema, input, 'ReconState');
  const provenanceProvided =
    typeof input === 'object' &&
    input !== null &&
    Object.prototype.hasOwnProperty.call(input, 'provenance');
  return validateReconState(parsed, { provenanceProvided });
}

function sortCollection<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareCodeUnits(a.id, b.id));
}

function compareOutputs(a: RunOutputRecord, b: RunOutputRecord): number {
  return (
    compareCodeUnits(a.run_id, b.run_id) ||
    compareCodeUnits(a.entity_type, b.entity_type) ||
    compareCodeUnits(a.entity_id, b.entity_id)
  );
}

export function serializeReconState(
  state: ReconState,
  options: { omitTraceability?: boolean } = {},
): string {
  const omitTraceability = options.omitTraceability ?? false;
  const canonical: Record<string, unknown> = {
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
  if (!omitTraceability && state.traceability !== undefined) {
    canonical.traceability = {
      runs: sortCollection(state.traceability.runs),
      derivations: sortCollection(state.traceability.derivations),
      outputs: [...state.traceability.outputs].sort(compareOutputs),
    };
  }
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
