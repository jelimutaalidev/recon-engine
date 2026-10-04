import type { Database } from 'better-sqlite3';
import { ReconError } from '../errors/errors.js';
import { stableStringify } from '../util/canonical.js';
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
import type { Provenance } from '../epistemic/provenance.js';
import { createReconState } from '../recon-state/state.js';
import type { ReconState, ReconStateInput } from '../recon-state/schema.js';
import type { ReconRepository } from './interface.js';
import {
  assumptionToRow,
  assetToRow,
  contractToRow,
  dependencyToRow,
  evidenceToRow,
  factToRow,
  functionToRow,
  hypothesisToRow,
  observationToRow,
  projectToRow,
  provenanceToRow,
  relationshipToRow,
  rowToAssumption,
  rowToAsset,
  rowToContract,
  rowToDependency,
  rowToEvidence,
  rowToFact,
  rowToFunction,
  rowToHypothesis,
  rowToObservation,
  rowToProject,
  rowToProvenance,
  rowToRelationship,
  rowToRole,
  rowToStateVariable,
  roleToRow,
  stateVariableToRow,
  type AssumptionRow,
  type AssetRow,
  type ContractRow,
  type DependencyRow,
  type EvidenceRow,
  type FactRow,
  type FunctionRow,
  type HypothesisRow,
  type ObservationRow,
  type ProjectRow,
  type ProvenanceRow,
  type RelationshipRow,
  type RoleRow,
  type RowValue,
  type StateVariableRow,
} from './mappers.js';

type Row = Record<string, unknown>;

function stripVolatile(entity: object): Record<string, unknown> {
  const { created_at: _created, updated_at: _updated, ...rest } =
    entity as Record<string, unknown>;
  return rest;
}

export class SqliteReconRepository implements ReconRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createProject(project: Project): Project {
    const current = this.db.prepare('SELECT * FROM projects LIMIT 1').get() as
      | ProjectRow
      | undefined;
    if (current !== undefined) {
      const existing = rowToProject(current);
      this.assertSameContent(existing, project, 'Project', project.id);
      return existing;
    }
    this.insertRow('projects', projectToRow(project));
    return project;
  }

  getProject(id: string): Project | null {
    const row = this.findRow('projects', id) as ProjectRow | undefined;
    return row === undefined ? null : rowToProject(row);
  }

  createContract(contract: Contract): Contract {
    const existing = this.getContract(contract.id);
    if (existing !== null) {
      this.assertSameContent(existing, contract, 'Contract', contract.id);
      return existing;
    }
    this.insertRow('contracts', contractToRow(contract));
    return contract;
  }

  getContract(id: string): Contract | null {
    const row = this.findRow('contracts', id) as ContractRow | undefined;
    return row === undefined ? null : rowToContract(row);
  }

  findContractByAddress(chainId: string, address: string): Contract | null {
    const row = this.db
      .prepare('SELECT * FROM contracts WHERE chain_id = ? AND address = ? LIMIT 1')
      .get(chainId.trim().toLowerCase(), address.trim().toLowerCase()) as
      | ContractRow
      | undefined;
    return row === undefined ? null : rowToContract(row);
  }

  createFunction(fn: SolidityFunction): SolidityFunction {
    const existing = this.getFunction(fn.id);
    if (existing !== null) {
      this.assertSameContent(existing, fn, 'Function', fn.id);
      return existing;
    }
    this.insertRow('functions', functionToRow(fn));
    return fn;
  }

  getFunction(id: string): SolidityFunction | null {
    const row = this.findRow('functions', id) as FunctionRow | undefined;
    return row === undefined ? null : rowToFunction(row);
  }

  createStateVariable(stateVariable: StateVariable): StateVariable {
    const existing = this.getStateVariable(stateVariable.id);
    if (existing !== null) {
      this.assertSameContent(existing, stateVariable, 'StateVariable', stateVariable.id);
      return existing;
    }
    this.insertRow('state_variables', stateVariableToRow(stateVariable));
    return stateVariable;
  }

  getStateVariable(id: string): StateVariable | null {
    const row = this.findRow('state_variables', id) as StateVariableRow | undefined;
    return row === undefined ? null : rowToStateVariable(row);
  }

  createAsset(asset: Asset): Asset {
    const existing = this.getAsset(asset.id);
    if (existing !== null) {
      this.assertSameContent(existing, asset, 'Asset', asset.id);
      return existing;
    }
    this.insertRow('assets', assetToRow(asset));
    return asset;
  }

  getAsset(id: string): Asset | null {
    const row = this.findRow('assets', id) as AssetRow | undefined;
    return row === undefined ? null : rowToAsset(row);
  }

  createRole(role: Role): Role {
    const existing = this.getRole(role.id);
    if (existing !== null) {
      this.assertSameContent(existing, role, 'Role', role.id);
      return existing;
    }
    this.insertRow('roles', roleToRow(role));
    return role;
  }

  getRole(id: string): Role | null {
    const row = this.findRow('roles', id) as RoleRow | undefined;
    return row === undefined ? null : rowToRole(row);
  }

  createDependency(dependency: Dependency): Dependency {
    const existing = this.getDependency(dependency.id);
    if (existing !== null) {
      this.assertSameContent(existing, dependency, 'Dependency', dependency.id);
      return existing;
    }
    this.insertRow('dependencies', dependencyToRow(dependency));
    return dependency;
  }

  getDependency(id: string): Dependency | null {
    const row = this.findRow('dependencies', id) as DependencyRow | undefined;
    return row === undefined ? null : rowToDependency(row);
  }

  createRelationship(relationship: Relationship): Relationship {
    const existing = this.getRelationship(relationship.id);
    if (existing !== null) {
      this.assertSameContent(existing, relationship, 'Relationship', relationship.id);
      return existing;
    }
    this.persistProvenance(relationship.provenance);
    this.insertRow('relationships', relationshipToRow(relationship));
    this.insertProvenanceLinks(
      'relationship_provenance',
      'relationship_id',
      relationship.id,
      relationship.provenance,
    );
    return relationship;
  }

  getRelationship(id: string): Relationship | null {
    const row = this.findRow('relationships', id) as RelationshipRow | undefined;
    return row === undefined ? null : this.hydrateRelationship(row);
  }

  getRelationshipsFrom(sourceId: string): Relationship[] {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE source_id = ? ORDER BY id')
      .all(sourceId) as RelationshipRow[];
    return rows.map((row) => this.hydrateRelationship(row));
  }

  getRelationshipsTo(targetId: string): Relationship[] {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE target_id = ? ORDER BY id')
      .all(targetId) as RelationshipRow[];
    return rows.map((row) => this.hydrateRelationship(row));
  }

  findRelationshipsByType(type: string): Relationship[] {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE type = ? ORDER BY id')
      .all(type) as RelationshipRow[];
    return rows.map((row) => this.hydrateRelationship(row));
  }

  createFact(fact: Fact): Fact {
    const existing = this.getFact(fact.id);
    if (existing !== null) {
      this.assertSameContent(existing, fact, 'Fact', fact.id);
      return existing;
    }
    this.persistProvenance(fact.provenance);
    this.insertRow('facts', factToRow(fact));
    this.insertProvenanceLinks('fact_provenance', 'fact_id', fact.id, fact.provenance);
    return fact;
  }

  getFact(id: string): Fact | null {
    const row = this.findRow('facts', id) as FactRow | undefined;
    if (row === undefined) return null;
    return rowToFact(row, this.hydrateProvenance('fact_provenance', 'fact_id', row.id));
  }

  createObservation(observation: Observation): Observation {
    const existing = this.getObservation(observation.id);
    if (existing !== null) {
      this.assertSameContent(existing, observation, 'Observation', observation.id);
      return existing;
    }
    this.persistProvenance(observation.provenance);
    this.insertRow('observations', observationToRow(observation));
    this.insertStringList(
      'observation_basis',
      'observation_id',
      'fact_id',
      observation.id,
      observation.based_on,
    );
    this.insertProvenanceLinks(
      'observation_provenance',
      'observation_id',
      observation.id,
      observation.provenance,
    );
    return observation;
  }

  getObservation(id: string): Observation | null {
    const row = this.findRow('observations', id) as ObservationRow | undefined;
    if (row === undefined) return null;
    const basedOn = this.stringList('observation_basis', 'observation_id', 'fact_id', row.id);
    const provenance = this.hydrateProvenance(
      'observation_provenance',
      'observation_id',
      row.id,
    );
    return rowToObservation(row, basedOn, provenance);
  }

  createAssumption(assumption: Assumption): Assumption {
    const existing = this.getAssumption(assumption.id);
    if (existing !== null) {
      this.assertSameContent(existing, assumption, 'Assumption', assumption.id);
      return existing;
    }
    this.insertRow('assumptions', assumptionToRow(assumption));
    this.insertStringList(
      'assumption_basis',
      'assumption_id',
      'observation_id',
      assumption.id,
      assumption.based_on,
    );
    return assumption;
  }

  getAssumption(id: string): Assumption | null {
    const row = this.findRow('assumptions', id) as AssumptionRow | undefined;
    if (row === undefined) return null;
    const basedOn = this.stringList(
      'assumption_basis',
      'assumption_id',
      'observation_id',
      row.id,
    );
    return rowToAssumption(row, basedOn);
  }

  createHypothesis(hypothesis: Hypothesis): Hypothesis {
    const existing = this.getHypothesis(hypothesis.id);
    if (existing !== null) {
      this.assertSameContent(existing, hypothesis, 'Hypothesis', hypothesis.id);
      return existing;
    }
    this.insertRow('hypotheses', hypothesisToRow(hypothesis));
    this.insertStringList(
      'hypothesis_basis',
      'hypothesis_id',
      'target_id',
      hypothesis.id,
      hypothesis.based_on,
    );
    this.insertStringList(
      'hypothesis_entities',
      'hypothesis_id',
      'entity_id',
      hypothesis.id,
      hypothesis.affected_entities,
    );
    this.insertStringList(
      'hypothesis_conditions',
      'hypothesis_id',
      'condition',
      hypothesis.id,
      hypothesis.required_conditions,
    );
    return hypothesis;
  }

  getHypothesis(id: string): Hypothesis | null {
    const row = this.findRow('hypotheses', id) as HypothesisRow | undefined;
    if (row === undefined) return null;
    const basedOn = this.stringList('hypothesis_basis', 'hypothesis_id', 'target_id', row.id);
    const affected = this.stringList(
      'hypothesis_entities',
      'hypothesis_id',
      'entity_id',
      row.id,
    );
    const conditions = this.stringList(
      'hypothesis_conditions',
      'hypothesis_id',
      'condition',
      row.id,
    );
    return rowToHypothesis(row, basedOn, affected, conditions);
  }

  createEvidence(evidence: Evidence): Evidence {
    const existing = this.getEvidence(evidence.id);
    if (existing !== null) {
      this.assertSameContent(existing, evidence, 'Evidence', evidence.id);
      return existing;
    }
    this.persistProvenance(evidence.provenance);
    this.insertRow('evidence', evidenceToRow(evidence));
    this.insertStringList(
      'evidence_supports',
      'evidence_id',
      'target_id',
      evidence.id,
      evidence.supports,
    );
    this.insertStringList(
      'evidence_contradicts',
      'evidence_id',
      'target_id',
      evidence.id,
      evidence.contradicts,
    );
    this.insertProvenanceLinks(
      'evidence_provenance',
      'evidence_id',
      evidence.id,
      evidence.provenance,
    );
    return evidence;
  }

  getEvidence(id: string): Evidence | null {
    const row = this.findRow('evidence', id) as EvidenceRow | undefined;
    if (row === undefined) return null;
    const supports = this.stringList('evidence_supports', 'evidence_id', 'target_id', row.id);
    const contradicts = this.stringList(
      'evidence_contradicts',
      'evidence_id',
      'target_id',
      row.id,
    );
    const provenance = this.hydrateProvenance('evidence_provenance', 'evidence_id', row.id);
    return rowToEvidence(row, supports, contradicts, provenance);
  }

  saveState(state: ReconState): void {
    this.db.transaction(() => {
      if (state.project !== undefined) this.createProject(state.project);
      for (const contract of state.contracts) this.createContract(contract);
      for (const fn of state.functions) this.createFunction(fn);
      for (const stateVariable of state.state_variables) {
        this.createStateVariable(stateVariable);
      }
      for (const asset of state.assets) this.createAsset(asset);
      for (const role of state.roles) this.createRole(role);
      for (const dependency of state.dependencies) this.createDependency(dependency);
      for (const relationship of state.relationships) this.createRelationship(relationship);
      for (const fact of state.facts) this.createFact(fact);
      for (const observation of state.observations) this.createObservation(observation);
      for (const assumption of state.assumptions) this.createAssumption(assumption);
      for (const hypothesis of state.hypotheses) this.createHypothesis(hypothesis);
      for (const evidence of state.evidence) this.createEvidence(evidence);
      this.setMeta('state_saved_at', new Date().toISOString());
      this.setMeta('schema_version', state.schema_version);
    })();
  }

  loadState(): ReconState | null {
    if (this.getMeta('state_saved_at') === null) return null;
    const projectRow = this.db.prepare('SELECT * FROM projects LIMIT 1').get() as
      | ProjectRow
      | undefined;
    const contractRows = this.db.prepare('SELECT * FROM contracts ORDER BY id').all() as ContractRow[];
    const functionRows = this.db
      .prepare('SELECT * FROM functions ORDER BY id')
      .all() as FunctionRow[];
    const stateVariableRows = this.db
      .prepare('SELECT * FROM state_variables ORDER BY id')
      .all() as StateVariableRow[];
    const assetRows = this.db.prepare('SELECT * FROM assets ORDER BY id').all() as AssetRow[];
    const roleRows = this.db.prepare('SELECT * FROM roles ORDER BY id').all() as RoleRow[];
    const dependencyRows = this.db
      .prepare('SELECT * FROM dependencies ORDER BY id')
      .all() as DependencyRow[];
    const relationshipRows = this.db
      .prepare('SELECT * FROM relationships ORDER BY id')
      .all() as RelationshipRow[];
    const factRows = this.db.prepare('SELECT * FROM facts ORDER BY id').all() as FactRow[];
    const observationRows = this.db
      .prepare('SELECT * FROM observations ORDER BY id')
      .all() as ObservationRow[];
    const assumptionRows = this.db
      .prepare('SELECT * FROM assumptions ORDER BY id')
      .all() as AssumptionRow[];
    const hypothesisRows = this.db
      .prepare('SELECT * FROM hypotheses ORDER BY id')
      .all() as HypothesisRow[];
    const evidenceRows = this.db
      .prepare('SELECT * FROM evidence ORDER BY id')
      .all() as EvidenceRow[];

    const input: ReconStateInput = {
      schema_version: this.getMeta('schema_version') ?? 'recon-state/v1',
      contracts: contractRows.map(rowToContract),
      functions: functionRows.map(rowToFunction),
      state_variables: stateVariableRows.map(rowToStateVariable),
      assets: assetRows.map(rowToAsset),
      roles: roleRows.map((row) => rowToRole(row)),
      dependencies: dependencyRows.map((row) => rowToDependency(row)),
      relationships: relationshipRows.map((row) => this.hydrateRelationship(row)),
      facts: factRows.map((row) =>
        rowToFact(row, this.hydrateProvenance('fact_provenance', 'fact_id', row.id)),
      ),
      observations: observationRows.map((row) =>
        rowToObservation(
          row,
          this.stringList('observation_basis', 'observation_id', 'fact_id', row.id),
          this.hydrateProvenance('observation_provenance', 'observation_id', row.id),
        ),
      ),
      assumptions: assumptionRows.map((row) =>
        rowToAssumption(
          row,
          this.stringList(
            'assumption_basis',
            'assumption_id',
            'observation_id',
            row.id,
          ),
        ),
      ),
      hypotheses: hypothesisRows.map((row) =>
        rowToHypothesis(
          row,
          this.stringList('hypothesis_basis', 'hypothesis_id', 'target_id', row.id),
          this.stringList('hypothesis_entities', 'hypothesis_id', 'entity_id', row.id),
          this.stringList('hypothesis_conditions', 'hypothesis_id', 'condition', row.id),
        ),
      ),
      evidence: evidenceRows.map((row) =>
        rowToEvidence(
          row,
          this.stringList('evidence_supports', 'evidence_id', 'target_id', row.id),
          this.stringList('evidence_contradicts', 'evidence_id', 'target_id', row.id),
          this.hydrateProvenance('evidence_provenance', 'evidence_id', row.id),
        ),
      ),
    };
    if (projectRow !== undefined) input.project = rowToProject(projectRow);
    return createReconState(input);
  }

  private assertSameContent(existing: object, incoming: object, entity: string, id: string): void {
    if (stableStringify(stripVolatile(existing)) !== stableStringify(stripVolatile(incoming))) {
      throw new ReconError(
        'DuplicateCanonicalEntity',
        `${entity} ${id} already exists with different content`,
        { entity, id },
      );
    }
  }

  private findRow(table: string, id: string): Row | undefined {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  }

  private insertRow(table: string, row: Record<string, RowValue>): void {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((column) => row[column] ?? null);
    this.db
      .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
      .run(...values);
  }

  private persistProvenance(records: readonly Provenance[]): void {
    for (const record of records) {
      const existing = this.findRow('provenance', record.id) as ProvenanceRow | undefined;
      if (existing !== undefined) {
        this.assertSameContent(rowToProvenance(existing), record, 'Provenance', record.id);
        continue;
      }
      this.insertRow('provenance', provenanceToRow(record));
    }
  }

  private insertProvenanceLinks(
    table: string,
    ownerColumn: string,
    ownerId: string,
    records: readonly Provenance[],
  ): void {
    records.forEach((record, position) => {
      this.insertRow(table, { [ownerColumn]: ownerId, provenance_id: record.id, position });
    });
  }

  private hydrateProvenance(
    table: string,
    ownerColumn: string,
    ownerId: string,
  ): Provenance[] {
    const rows = this.db
      .prepare(
        `SELECT provenance_id FROM ${table} WHERE ${ownerColumn} = ? ORDER BY position`,
      )
      .all(ownerId) as { provenance_id: string }[];
    return rows.map((row) => {
      const record = this.findRow('provenance', row.provenance_id) as
        | ProvenanceRow
        | undefined;
      if (record === undefined) {
        throw new ReconError(
          'InvalidReconState',
          'provenance record referenced by an entity is missing',
          { provenance_id: row.provenance_id },
        );
      }
      return rowToProvenance(record);
    });
  }

  private insertStringList(
    table: string,
    ownerColumn: string,
    valueColumn: string,
    ownerId: string,
    values: readonly string[],
  ): void {
    values.forEach((value, position) => {
      this.insertRow(table, { [ownerColumn]: ownerId, [valueColumn]: value, position });
    });
  }

  private stringList(
    table: string,
    ownerColumn: string,
    valueColumn: string,
    ownerId: string,
  ): string[] {
    const rows = this.db
      .prepare(`SELECT ${valueColumn} FROM ${table} WHERE ${ownerColumn} = ? ORDER BY position`)
      .all(ownerId) as Record<string, unknown>[];
    return rows.map((row) => {
      const value = row[valueColumn];
      if (typeof value !== 'string') {
        throw new ReconError('InvalidReconState', 'stored list column is not text', {
          table,
          column: valueColumn,
        });
      }
      return value;
    });
  }

  private hydrateRelationship(row: RelationshipRow): Relationship {
    return rowToRelationship(
      row,
      this.hydrateProvenance('relationship_provenance', 'relationship_id', row.id),
    );
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? null : row.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}
