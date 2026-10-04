import { ReconError } from '../errors/errors.js';
import {
  assetId,
  contractId,
  dependencyId,
  functionId,
  projectId,
  roleId,
  stateVariableId,
} from '../ids/ids.js';
import { RELATIONSHIP_TYPES } from '../relationships/types.js';
import { relationshipContentId } from '../relationships/relationship.js';
import { factContentId } from '../epistemic/fact.js';
import { observationContentId } from '../epistemic/observation.js';
import { assumptionContentId } from '../epistemic/assumption.js';
import { hypothesisContentId } from '../epistemic/hypothesis.js';
import { evidenceContentId } from '../epistemic/evidence.js';
import { assertNonEmptyBasis } from '../epistemic/shared.js';
import type { Provenance } from '../epistemic/provenance.js';
import type { ConfidenceLevel } from '../epistemic/confidence.js';
import {
  SUPPORTED_SCHEMA_VERSIONS,
  type ReconState,
} from './schema.js';

const EXPECTED_CONFIDENCE: Record<string, ConfidenceLevel> = {
  FACT: 'VERIFIED',
  OBSERVATION: 'DERIVED',
  ASSUMPTION: 'INFERRED',
  HYPOTHESIS: 'SPECULATIVE',
};

function collectProvenance(state: ReconState): Provenance[] {
  const registry = new Map<string, Provenance>();
  const items: unknown[] = [
    state.project,
    ...state.contracts,
    ...state.functions,
    ...state.state_variables,
    ...state.assets,
    ...state.roles,
    ...state.dependencies,
    ...state.relationships,
    ...state.facts,
    ...state.observations,
    ...state.assumptions,
    ...state.hypotheses,
    ...state.evidence,
  ];
  for (const item of items) {
    if (item === undefined || item === null) continue;
    const provenance = (item as { provenance?: unknown }).provenance;
    if (!Array.isArray(provenance)) continue;
    for (const record of provenance as Provenance[]) {
      registry.set(record.id, record);
    }
  }
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function sortedIds(records: readonly { id: string }[]): string[] {
  return records.map((record) => record.id).sort();
}

function assertSameIdSet(
  provided: readonly { id: string }[],
  derived: readonly { id: string }[],
): void {
  const providedIds = sortedIds(provided);
  const derivedIds = sortedIds(derived);
  if (providedIds.length !== derivedIds.length || providedIds.some((id, index) => id !== derivedIds[index])) {
    throw new ReconError(
      'InvalidReconState',
      'provenance registry must exactly match the provenance embedded across the state',
      { expected: derivedIds, received: providedIds },
    );
  }
}

function expectedId(build: () => string, entity: string): string {
  try {
    return build();
  } catch {
    throw new ReconError(
      'InvalidReconState',
      `${entity} identity fields cannot produce a valid id`,
      { entity },
    );
  }
}

function assertEntityIdentity(state: ReconState): void {
  const seen = new Set<string>();
  const assertUnique = (id: string, entity: string): void => {
    if (seen.has(id)) {
      throw new ReconError('DuplicateCanonicalEntity', `${entity} id ${id} appears more than once`, {
        entity,
        id,
      });
    }
    seen.add(id);
  };
  const check = (entity: string, actual: string, build: () => string): void => {
    const wanted = expectedId(build, entity);
    if (actual !== wanted) {
      throw new ReconError(
        'InvalidReconState',
        `${entity} id does not match its identity fields`,
        { entity, actual, expected: wanted },
      );
    }
    assertUnique(actual, entity);
  };

  const project = state.project;
  if (project !== undefined) {
    check('Project', project.id, () => projectId(project.name));
  }
  for (const contract of state.contracts) {
    check('Contract', contract.id, () =>
      contractId({ name: contract.name, chainId: contract.chain_id, address: contract.address }),
    );
  }
  for (const fn of state.functions) {
    check('Function', fn.id, () => functionId(fn.contract_id, fn.signature));
  }
  for (const stateVariable of state.state_variables) {
    check('StateVariable', stateVariable.id, () =>
      stateVariableId(stateVariable.contract_id, stateVariable.name),
    );
  }
  for (const asset of state.assets) {
    check('Asset', asset.id, () =>
      assetId({ name: asset.name, chainId: asset.chain_id, address: asset.address }),
    );
  }
  for (const role of state.roles) {
    check('Role', role.id, () => roleId(role.contract_id, role.name));
  }
  for (const dependency of state.dependencies) {
    check('Dependency', dependency.id, () =>
      dependencyId({ name: dependency.name, chainId: dependency.chain_id, address: dependency.address }),
    );
  }
}

function assertEpistemicConfidence(state: ReconState): void {
  const collections = [
    { type: 'FACT' as const, records: state.facts },
    { type: 'OBSERVATION' as const, records: state.observations },
    { type: 'ASSUMPTION' as const, records: state.assumptions },
    { type: 'HYPOTHESIS' as const, records: state.hypotheses },
  ];
  for (const { type, records } of collections) {
    for (const record of records) {
      const expected = EXPECTED_CONFIDENCE[type];
      if (record.confidence.level !== expected) {
        throw new ReconError(
          'InvalidConfidence',
          `${type} confidence level must be ${expected}`,
          { entity: type, expected, received: record.confidence.level },
        );
      }
    }
  }
}

function assertEpistemicRules(state: ReconState): void {
  for (const fact of state.facts) {
    if (fact.provenance.length === 0) {
      throw new ReconError('MissingProvenance', 'Fact requires at least one provenance record', {
        entity: 'Fact',
        id: fact.id,
      });
    }
  }
  for (const observation of state.observations) {
    if (observation.based_on.length === 0 && observation.provenance.length === 0) {
      throw new ReconError(
        'InvalidEpistemicDependency',
        'Observation requires supporting facts or explicit source provenance stating why no fact exists',
        { entity: 'Observation', id: observation.id },
      );
    }
  }
  for (const assumption of state.assumptions) {
    assertNonEmptyBasis(assumption.based_on, 'Assumption');
  }
  for (const hypothesis of state.hypotheses) {
    assertNonEmptyBasis(hypothesis.based_on, 'Hypothesis');
  }
  for (const evidence of state.evidence) {
    if (evidence.provenance.length === 0) {
      throw new ReconError('MissingProvenance', 'Evidence requires at least one provenance record', {
        entity: 'Evidence',
        id: evidence.id,
      });
    }
    if (evidence.supports.length === 0 && evidence.contradicts.length === 0) {
      throw new ReconError(
        'InvalidEvidenceReference',
        'Evidence must support or contradict at least one epistemic object',
        { entity: 'Evidence', id: evidence.id },
      );
    }
  }
}

function assertContentIds(state: ReconState): void {
  const mismatch = (entity: string, id: string): never => {
    throw new ReconError(
      'InvalidReconState',
      `${entity} content does not hash to its id; content-addressed records are immutable`,
      { entity, id },
    );
  };
  for (const relationship of state.relationships) {
    if (!(RELATIONSHIP_TYPES as readonly string[]).includes(relationship.type)) {
      throw new ReconError(
        'UnsupportedRelationshipType',
        `Relationship type ${relationship.type} is not a supported relationship`,
        { type: relationship.type, id: relationship.id },
      );
    }
    if (relationshipContentId(relationship) !== relationship.id) mismatch('Relationship', relationship.id);
  }
  for (const fact of state.facts) {
    if (factContentId(fact) !== fact.id) mismatch('Fact', fact.id);
  }
  for (const observation of state.observations) {
    if (observationContentId(observation) !== observation.id) mismatch('Observation', observation.id);
  }
  for (const assumption of state.assumptions) {
    if (assumptionContentId(assumption) !== assumption.id) mismatch('Assumption', assumption.id);
  }
  for (const hypothesis of state.hypotheses) {
    if (hypothesisContentId(hypothesis) !== hypothesis.id) mismatch('Hypothesis', hypothesis.id);
  }
  for (const evidence of state.evidence) {
    if (evidenceContentId(evidence) !== evidence.id) mismatch('Evidence', evidence.id);
  }
}

interface IntegrityIssue {
  check: string;
  source: string;
  missing: string[];
}

function assertReferentialIntegrity(state: ReconState): void {
  const entityIds = new Set<string>();
  if (state.project !== undefined) entityIds.add(state.project.id);
  for (const collection of [
    state.contracts,
    state.functions,
    state.state_variables,
    state.assets,
    state.roles,
    state.dependencies,
  ]) {
    for (const record of collection) entityIds.add(record.id);
  }
  const factIds = new Set(state.facts.map((record) => record.id));
  const observationIds = new Set(state.observations.map((record) => record.id));
  const assumptionIds = new Set(state.assumptions.map((record) => record.id));
  const hypothesisIds = new Set(state.hypotheses.map((record) => record.id));
  const epistemicIds = new Set([...factIds, ...observationIds, ...assumptionIds, ...hypothesisIds]);

  const issues: IntegrityIssue[] = [];
  const check = (integrityCheck: string, source: string, refs: readonly string[], universe: ReadonlySet<string>): void => {
    const missing = refs.filter((ref) => !universe.has(ref));
    if (missing.length > 0) issues.push({ check: integrityCheck, source, missing });
  };

  for (const relationship of state.relationships) {
    check('relationship-endpoints', relationship.id, [relationship.source_id, relationship.target_id], entityIds);
  }
  for (const fact of state.facts) {
    check('fact-subject', fact.id, [fact.subject_id], entityIds);
    if (fact.object_id !== undefined) check('fact-object', fact.id, [fact.object_id], entityIds);
  }
  for (const observation of state.observations) {
    check('observation-basis', observation.id, observation.based_on, factIds);
  }
  for (const assumption of state.assumptions) {
    check('assumption-basis', assumption.id, assumption.based_on, observationIds);
  }
  for (const hypothesis of state.hypotheses) {
    check(
      'hypothesis-basis',
      hypothesis.id,
      hypothesis.based_on,
      new Set([...assumptionIds, ...observationIds]),
    );
    check('hypothesis-entities', hypothesis.id, hypothesis.affected_entities, entityIds);
  }
  for (const evidence of state.evidence) {
    check('evidence-supports', evidence.id, evidence.supports, epistemicIds);
    check('evidence-contradicts', evidence.id, evidence.contradicts, epistemicIds);
  }

  if (issues.length > 0) {
    throw new ReconError('InvalidReconState', 'ReconState referential integrity failed', { issues });
  }
}

export function validateReconState(
  state: ReconState,
  options: { provenanceProvided: boolean },
): ReconState {
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(state.schema_version)) {
    throw new ReconError(
      'UnsupportedSchemaVersion',
      `Schema version ${state.schema_version} is not supported by this build`,
      { schema_version: state.schema_version, supported: SUPPORTED_SCHEMA_VERSIONS },
    );
  }
  const derivedProvenance = collectProvenance(state);
  if (options.provenanceProvided) {
    assertSameIdSet(state.provenance, derivedProvenance);
  }
  const normalized: ReconState = { ...state, provenance: derivedProvenance };
  assertEntityIdentity(normalized);
  assertEpistemicConfidence(normalized);
  assertEpistemicRules(normalized);
  assertContentIds(normalized);
  assertReferentialIntegrity(normalized);
  return normalized;
}
