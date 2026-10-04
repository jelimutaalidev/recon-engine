import { ReconError } from '../errors/errors.js';
import { parseOrThrow } from '../domain/helpers.js';
import { ProjectSchema, type Project } from '../domain/project.js';
import { ContractSchema, type Contract } from '../domain/contract.js';
import { FunctionSchema, type SolidityFunction } from '../domain/function.js';
import { StateVariableSchema, type StateVariable } from '../domain/state-variable.js';
import { AssetSchema, type Asset } from '../domain/asset.js';
import { RoleSchema, type Role } from '../domain/role.js';
import { DependencySchema, type Dependency } from '../domain/dependency.js';
import { RelationshipSchema, type Relationship } from '../relationships/relationship.js';
import { FactSchema, type Fact } from '../epistemic/fact.js';
import { ObservationSchema, type Observation } from '../epistemic/observation.js';
import { AssumptionSchema, type Assumption } from '../epistemic/assumption.js';
import { HypothesisSchema, type Hypothesis } from '../epistemic/hypothesis.js';
import { EvidenceSchema, type Evidence } from '../epistemic/evidence.js';
import { ProvenanceSchema, type Provenance } from '../epistemic/provenance.js';
import type { Confidence, ConfidenceLevel } from '../epistemic/confidence.js';

export type RowValue = string | number | null;

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  chains: string;
  repository: string | null;
  commit_sha: string | null;
  version: string | null;
  scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractRow {
  id: string;
  name: string;
  address: string | null;
  chain_id: string | null;
  contract_type: string;
  source_file: string | null;
  source_verified: number | null;
  compiler_version: string | null;
  is_proxy: number | null;
  implementation_id: string | null;
  deployment_status: string | null;
}

export interface FunctionRow {
  id: string;
  contract_id: string;
  name: string;
  signature: string;
  selector: string | null;
  visibility: string;
  mutability: string;
  parameters: string;
  returns: string;
  modifiers: string;
  source: string | null;
}

export interface StateVariableRow {
  id: string;
  contract_id: string;
  name: string;
  type: string;
  visibility: string;
  slot: string | null;
  source: string | null;
}

export interface AssetRow {
  id: string;
  name: string;
  address: string | null;
  chain_id: string | null;
  asset_type: string;
  decimals: number | null;
  custody: string | null;
  underlying_asset_id: string | null;
}

export interface RoleRow {
  id: string;
  contract_id: string | null;
  name: string;
  role_type: string;
  holder: string | null;
  source: string | null;
}

export interface DependencyRow {
  id: string;
  name: string;
  dependency_type: string;
  address: string | null;
  chain_id: string | null;
  interface: string | null;
  trust_level: string | null;
}

export interface ProvenanceRow {
  id: string;
  source_type: string;
  location: string | null;
  repository: string | null;
  commit_sha: string | null;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  chain_id: string | null;
  address: string | null;
  block_number: number | null;
  description: string | null;
  unavailable: number | null;
}

export interface RelationshipRow {
  id: string;
  type: string;
  source_id: string;
  target_id: string;
  metadata: string | null;
  created_at: string;
}

export interface FactRow {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  value: string | null;
  confidence_level: string;
  confidence_score: number | null;
  created_at: string;
}

export interface ObservationRow {
  id: string;
  statement: string;
  confidence_level: string;
  confidence_score: number | null;
  created_at: string;
}

export interface AssumptionRow {
  id: string;
  statement: string;
  status: string;
  confidence_level: string;
  confidence_score: number | null;
  created_at: string;
}

export interface HypothesisRow {
  id: string;
  statement: string;
  status: string;
  confidence_level: string;
  confidence_score: number | null;
  created_at: string;
}

export interface EvidenceRow {
  id: string;
  evidence_type: string;
  description: string;
  created_at: string;
}

function opt<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function optBool(value: number | null): boolean | undefined {
  return value === null ? undefined : value === 1;
}

function boolFlag(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReconError('InvalidReconState', 'stored JSON column is malformed', {
      column: raw.slice(0, 64),
    });
  }
}

function confidenceColumns(confidence: Confidence): {
  confidence_level: string;
  confidence_score: number | null;
} {
  return {
    confidence_level: confidence.level,
    confidence_score: confidence.score ?? null,
  };
}

function rowToConfidence(row: {
  confidence_level: string;
  confidence_score: number | null;
}): Confidence {
  const level = row.confidence_level as ConfidenceLevel;
  return row.confidence_score === null
    ? { level }
    : { level, score: row.confidence_score };
}

export function projectToRow(project: Project): Record<string, RowValue> {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    chains: JSON.stringify(project.chains),
    repository: project.repository ?? null,
    commit_sha: project.commit ?? null,
    version: project.version ?? null,
    scope: project.scope ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

export function rowToProject(row: ProjectRow): Project {
  return parseOrThrow(
    ProjectSchema,
    {
      id: row.id,
      name: row.name,
      description: opt(row.description),
      chains: parseJson(row.chains),
      repository: opt(row.repository),
      commit: opt(row.commit_sha),
      version: opt(row.version),
      scope: opt(row.scope),
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    'Project',
  );
}

export function contractToRow(contract: Contract): Record<string, RowValue> {
  return {
    id: contract.id,
    name: contract.name,
    address: contract.address ?? null,
    chain_id: contract.chain_id ?? null,
    contract_type: contract.contract_type,
    source_file: contract.source_file ?? null,
    source_verified: boolFlag(contract.source_verified),
    compiler_version: contract.compiler_version ?? null,
    is_proxy: boolFlag(contract.is_proxy),
    implementation_id: contract.implementation_id ?? null,
    deployment_status: contract.deployment_status ?? null,
  };
}

export function rowToContract(row: ContractRow): Contract {
  return parseOrThrow(
    ContractSchema,
    {
      id: row.id,
      name: row.name,
      address: opt(row.address),
      chain_id: opt(row.chain_id),
      contract_type: row.contract_type,
      source_file: opt(row.source_file),
      source_verified: optBool(row.source_verified),
      compiler_version: opt(row.compiler_version),
      is_proxy: optBool(row.is_proxy),
      implementation_id: opt(row.implementation_id),
      deployment_status: opt(row.deployment_status),
    },
    'Contract',
  );
}

export function functionToRow(fn: SolidityFunction): Record<string, RowValue> {
  return {
    id: fn.id,
    contract_id: fn.contract_id,
    name: fn.name,
    signature: fn.signature,
    selector: fn.selector ?? null,
    visibility: fn.visibility,
    mutability: fn.mutability,
    parameters: JSON.stringify(fn.parameters),
    returns: JSON.stringify(fn.returns),
    modifiers: JSON.stringify(fn.modifiers),
    source: fn.source ?? null,
  };
}

export function rowToFunction(row: FunctionRow): SolidityFunction {
  return parseOrThrow(
    FunctionSchema,
    {
      id: row.id,
      contract_id: row.contract_id,
      name: row.name,
      signature: row.signature,
      selector: opt(row.selector),
      visibility: row.visibility,
      mutability: row.mutability,
      parameters: parseJson(row.parameters),
      returns: parseJson(row.returns),
      modifiers: parseJson(row.modifiers),
      source: opt(row.source),
    },
    'Function',
  );
}

export function stateVariableToRow(stateVariable: StateVariable): Record<string, RowValue> {
  return {
    id: stateVariable.id,
    contract_id: stateVariable.contract_id,
    name: stateVariable.name,
    type: stateVariable.type,
    visibility: stateVariable.visibility,
    slot: stateVariable.slot ?? null,
    source: stateVariable.source ?? null,
  };
}

export function rowToStateVariable(row: StateVariableRow): StateVariable {
  return parseOrThrow(
    StateVariableSchema,
    {
      id: row.id,
      contract_id: row.contract_id,
      name: row.name,
      type: row.type,
      visibility: row.visibility,
      slot: opt(row.slot),
      source: opt(row.source),
    },
    'StateVariable',
  );
}

export function assetToRow(asset: Asset): Record<string, RowValue> {
  return {
    id: asset.id,
    name: asset.name,
    address: asset.address ?? null,
    chain_id: asset.chain_id ?? null,
    asset_type: asset.asset_type,
    decimals: asset.decimals ?? null,
    custody: asset.custody ?? null,
    underlying_asset_id: asset.underlying_asset_id ?? null,
  };
}

export function rowToAsset(row: AssetRow): Asset {
  return parseOrThrow(
    AssetSchema,
    {
      id: row.id,
      name: row.name,
      address: opt(row.address),
      chain_id: opt(row.chain_id),
      asset_type: row.asset_type,
      decimals: opt(row.decimals),
      custody: opt(row.custody),
      underlying_asset_id: opt(row.underlying_asset_id),
    },
    'Asset',
  );
}

export function roleToRow(role: Role): Record<string, RowValue> {
  return {
    id: role.id,
    contract_id: role.contract_id ?? null,
    name: role.name,
    role_type: role.role_type,
    holder: role.holder ?? null,
    source: role.source ?? null,
  };
}

export function rowToRole(row: RoleRow): Role {
  return parseOrThrow(
    RoleSchema,
    {
      id: row.id,
      contract_id: opt(row.contract_id),
      name: row.name,
      role_type: row.role_type,
      holder: opt(row.holder),
      source: opt(row.source),
    },
    'Role',
  );
}

export function dependencyToRow(dependency: Dependency): Record<string, RowValue> {
  return {
    id: dependency.id,
    name: dependency.name,
    dependency_type: dependency.dependency_type,
    address: dependency.address ?? null,
    chain_id: dependency.chain_id ?? null,
    interface: dependency.interface ?? null,
    trust_level: dependency.trust_level ?? null,
  };
}

export function rowToDependency(row: DependencyRow): Dependency {
  return parseOrThrow(
    DependencySchema,
    {
      id: row.id,
      name: row.name,
      dependency_type: row.dependency_type,
      address: opt(row.address),
      chain_id: opt(row.chain_id),
      interface: opt(row.interface),
      trust_level: opt(row.trust_level),
    },
    'Dependency',
  );
}

export function provenanceToRow(record: Provenance): Record<string, RowValue> {
  return {
    id: record.id,
    source_type: record.source_type,
    location: record.location ?? null,
    repository: record.repository ?? null,
    commit_sha: record.commit ?? null,
    file: record.file ?? null,
    line_start: record.line_start ?? null,
    line_end: record.line_end ?? null,
    chain_id: record.chain_id ?? null,
    address: record.address ?? null,
    block_number: record.block_number ?? null,
    description: record.description ?? null,
    unavailable: boolFlag(record.unavailable),
  };
}

export function rowToProvenance(row: ProvenanceRow): Provenance {
  return parseOrThrow(
    ProvenanceSchema,
    {
      id: row.id,
      source_type: row.source_type,
      location: opt(row.location),
      repository: opt(row.repository),
      commit: opt(row.commit_sha),
      file: opt(row.file),
      line_start: opt(row.line_start),
      line_end: opt(row.line_end),
      chain_id: opt(row.chain_id),
      address: opt(row.address),
      block_number: opt(row.block_number),
      description: opt(row.description),
      unavailable: optBool(row.unavailable),
    },
    'Provenance',
  );
}

export function relationshipToRow(relationship: Relationship): Record<string, RowValue> {
  return {
    id: relationship.id,
    type: relationship.type,
    source_id: relationship.source_id,
    target_id: relationship.target_id,
    metadata:
      relationship.metadata === undefined ? null : JSON.stringify(relationship.metadata),
    created_at: relationship.created_at,
  };
}

export function rowToRelationship(
  row: RelationshipRow,
  provenance: Provenance[],
): Relationship {
  return parseOrThrow(
    RelationshipSchema,
    {
      id: row.id,
      type: row.type,
      source_id: row.source_id,
      target_id: row.target_id,
      metadata: row.metadata === null ? undefined : parseJson(row.metadata),
      provenance,
      created_at: row.created_at,
    },
    'Relationship',
  );
}

export function factToRow(fact: Fact): Record<string, RowValue> {
  return {
    id: fact.id,
    subject_id: fact.subject_id,
    predicate: fact.predicate,
    object_id: fact.object_id ?? null,
    value: fact.value === undefined ? null : JSON.stringify(fact.value),
    ...confidenceColumns(fact.confidence),
    created_at: fact.created_at,
  };
}

export function rowToFact(row: FactRow, provenance: Provenance[]): Fact {
  return parseOrThrow(
    FactSchema,
    {
      id: row.id,
      type: 'FACT',
      subject_id: row.subject_id,
      predicate: row.predicate,
      object_id: opt(row.object_id),
      value: row.value === null ? undefined : parseJson(row.value),
      provenance,
      confidence: rowToConfidence(row),
      created_at: row.created_at,
    },
    'Fact',
  );
}

export function observationToRow(observation: Observation): Record<string, RowValue> {
  return {
    id: observation.id,
    statement: observation.statement,
    ...confidenceColumns(observation.confidence),
    created_at: observation.created_at,
  };
}

export function rowToObservation(
  row: ObservationRow,
  basedOn: string[],
  provenance: Provenance[],
): Observation {
  return parseOrThrow(
    ObservationSchema,
    {
      id: row.id,
      type: 'OBSERVATION',
      statement: row.statement,
      based_on: basedOn,
      provenance,
      confidence: rowToConfidence(row),
      created_at: row.created_at,
    },
    'Observation',
  );
}

export function assumptionToRow(assumption: Assumption): Record<string, RowValue> {
  return {
    id: assumption.id,
    statement: assumption.statement,
    status: assumption.status,
    ...confidenceColumns(assumption.confidence),
    created_at: assumption.created_at,
  };
}

export function rowToAssumption(row: AssumptionRow, basedOn: string[]): Assumption {
  return parseOrThrow(
    AssumptionSchema,
    {
      id: row.id,
      type: 'ASSUMPTION',
      statement: row.statement,
      status: row.status,
      based_on: basedOn,
      confidence: rowToConfidence(row),
      created_at: row.created_at,
    },
    'Assumption',
  );
}

export function hypothesisToRow(hypothesis: Hypothesis): Record<string, RowValue> {
  return {
    id: hypothesis.id,
    statement: hypothesis.statement,
    status: hypothesis.status,
    ...confidenceColumns(hypothesis.confidence),
    created_at: hypothesis.created_at,
  };
}

export function rowToHypothesis(
  row: HypothesisRow,
  basedOn: string[],
  affectedEntities: string[],
  requiredConditions: string[],
): Hypothesis {
  return parseOrThrow(
    HypothesisSchema,
    {
      id: row.id,
      type: 'HYPOTHESIS',
      statement: row.statement,
      status: row.status,
      based_on: basedOn,
      affected_entities: affectedEntities,
      required_conditions: requiredConditions,
      confidence: rowToConfidence(row),
      created_at: row.created_at,
    },
    'Hypothesis',
  );
}

export function evidenceToRow(evidence: Evidence): Record<string, RowValue> {
  return {
    id: evidence.id,
    evidence_type: evidence.evidence_type,
    description: evidence.description,
    created_at: evidence.created_at,
  };
}

export function rowToEvidence(
  row: EvidenceRow,
  supports: string[],
  contradicts: string[],
  provenance: Provenance[],
): Evidence {
  return parseOrThrow(
    EvidenceSchema,
    {
      id: row.id,
      evidence_type: row.evidence_type,
      description: row.description,
      supports,
      contradicts,
      provenance,
      created_at: row.created_at,
    },
    'Evidence',
  );
}
