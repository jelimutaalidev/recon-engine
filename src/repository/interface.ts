import type { Project } from '../domain/project.js';
import type { Contract } from '../domain/contract.js';
import type { SolidityFunction } from '../domain/function.js';
import type { StateVariable } from '../domain/state-variable.js';
import type { Asset } from '../domain/asset.js';
import type { Role } from '../domain/role.js';
import type { Dependency } from '../domain/dependency.js';
import type { Relationship } from '../relationships/relationship.js';
import type { Fact } from '../epistemic/fact.js';
import type { Observation } from '../epistemic/observation.js';
import type { Assumption } from '../epistemic/assumption.js';
import type { Hypothesis } from '../epistemic/hypothesis.js';
import type { Evidence } from '../epistemic/evidence.js';
import type { ReconState } from '../recon-state/schema.js';

export interface ReconRepository {
  createProject(project: Project): Project;
  getProject(id: string): Project | null;

  createContract(contract: Contract): Contract;
  getContract(id: string): Contract | null;
  findContractByAddress(chainId: string, address: string): Contract | null;

  createFunction(fn: SolidityFunction): SolidityFunction;
  getFunction(id: string): SolidityFunction | null;

  createStateVariable(stateVariable: StateVariable): StateVariable;
  getStateVariable(id: string): StateVariable | null;

  createAsset(asset: Asset): Asset;
  getAsset(id: string): Asset | null;

  createRole(role: Role): Role;
  getRole(id: string): Role | null;

  createDependency(dependency: Dependency): Dependency;
  getDependency(id: string): Dependency | null;

  createRelationship(relationship: Relationship): Relationship;
  getRelationship(id: string): Relationship | null;
  getRelationshipsFrom(sourceId: string): Relationship[];
  getRelationshipsTo(targetId: string): Relationship[];
  findRelationshipsByType(type: string): Relationship[];

  createFact(fact: Fact): Fact;
  getFact(id: string): Fact | null;

  createObservation(observation: Observation): Observation;
  getObservation(id: string): Observation | null;

  createAssumption(assumption: Assumption): Assumption;
  getAssumption(id: string): Assumption | null;

  createHypothesis(hypothesis: Hypothesis): Hypothesis;
  getHypothesis(id: string): Hypothesis | null;

  createEvidence(evidence: Evidence): Evidence;
  getEvidence(id: string): Evidence | null;

  saveState(state: ReconState): void;
  loadState(): ReconState | null;
}
