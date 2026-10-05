import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase, runMigrations } from '../src/repository/migrate.js';
import { SqliteReconRepository } from '../src/repository/sqlite.js';
import { createProject } from '../src/domain/project.js';
import { createContract } from '../src/domain/contract.js';
import { createFunction } from '../src/domain/function.js';
import { createStateVariable } from '../src/domain/state-variable.js';
import { createAsset } from '../src/domain/asset.js';
import { createRole } from '../src/domain/role.js';
import { createDependency } from '../src/domain/dependency.js';
import { createRelationship } from '../src/relationships/relationship.js';
import { createFact } from '../src/epistemic/fact.js';
import { createObservation } from '../src/epistemic/observation.js';
import { createAssumption } from '../src/epistemic/assumption.js';
import { createHypothesis } from '../src/epistemic/hypothesis.js';
import { createEvidence } from '../src/epistemic/evidence.js';
import { createReconState, serializeReconState } from '../src/recon-state/state.js';
import type { ReconStateInput } from '../src/recon-state/schema.js';
import type { ProvenanceInput } from '../src/epistemic/provenance.js';
import { isReconError, type ReconErrorCode } from '../src/errors/errors.js';

function expectReconCode(fn: () => unknown, code: ReconErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(isReconError(error)).toBe(true);
    if (isReconError(error)) {
      expect(error.code).toBe(code);
    }
    return;
  }
  throw new Error(`expected ReconError ${code}, but call succeeded`);
}

function openRepo(): { db: Database; repo: SqliteReconRepository } {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return { db, repo: new SqliteReconRepository(db) };
}

const FIXED_TS = '2024-01-01T00:00:00.000Z';

const SRC: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Vault.sol',
  line_start: 40,
  line_end: 52,
};

const CHAIN_SRC: ProvenanceInput = {
  source_type: 'onchain',
  chain_id: 'ethereum',
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  block_number: 19_000_000,
};

function baseFixture(): ReconStateInput {
  const project = createProject({
    name: 'AcmeVault',
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  });
  const contract = createContract({
    name: 'Vault',
    chain_id: 'ethereum',
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    contract_type: 'vault',
    source_verified: true,
    is_proxy: false,
  });
  const deposit = createFunction({
    contract_id: contract.id,
    name: 'deposit',
    visibility: 'external',
    mutability: 'nonpayable',
    parameters: [{ name: 'shares', type: 'uint256' }],
    returns: [{ type: 'uint256' }],
    modifiers: ['nonReentrant'],
    source: 'src/Vault.sol',
  });
  const stateVar = createStateVariable({
    contract_id: contract.id,
    name: 'totalShares',
    type: 'uint256',
    visibility: 'public',
    slot: '0x0',
  });
  const relationship = createRelationship({
    type: 'WRITES',
    source_id: deposit.id,
    target_id: stateVar.id,
    provenance: [SRC],
    created_at: FIXED_TS,
  });
  const fact = createFact({
    subject_id: deposit.id,
    predicate: 'WRITES',
    object_id: stateVar.id,
    provenance: [SRC],
    created_at: FIXED_TS,
  });
  const observation = createObservation({
    statement: 'deposit writes totalShares',
    based_on: [fact.id],
    provenance: [CHAIN_SRC],
    created_at: FIXED_TS,
  });
  const assumption = createAssumption({
    statement: 'share accounting stays consistent',
    based_on: [observation.id],
    created_at: FIXED_TS,
  });
  const hypothesis = createHypothesis({
    statement: 'inflation attack is possible',
    based_on: [assumption.id],
    affected_entities: [stateVar.id],
    required_conditions: ['donation before first deposit'],
    created_at: FIXED_TS,
  });
  const evidence = createEvidence({
    evidence_type: 'static',
    description: 'donation attack path exists in source',
    supports: [hypothesis.id],
    provenance: [CHAIN_SRC],
    created_at: FIXED_TS,
  });
  return {
    schema_version: 'recon-state/v1',
    project,
    contracts: [contract],
    functions: [deposit],
    state_variables: [stateVar],
    relationships: [relationship],
    facts: [fact],
    observations: [observation],
    assumptions: [assumption],
    hypotheses: [hypothesis],
    evidence: [evidence],
  };
}

describe('migrations', () => {
  it('applies the initial migration and records it', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[];
    expect(rows.map((row) => row.version)).toEqual([
      '001_initial.sql',
      '002_phase2_extraction_fields.sql',
    ]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = new Set(tables.map((table) => table.name));
    for (const expected of [
      'projects',
      'contracts',
      'functions',
      'state_variables',
      'assets',
      'roles',
      'dependencies',
      'provenance',
      'relationships',
      'facts',
      'observations',
      'assumptions',
      'hypotheses',
      'evidence',
      'meta',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('is idempotent when run twice', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const rows = db.prepare('SELECT version FROM schema_migrations').all();
    expect(rows).toHaveLength(2);
  });

  it('rejects a recorded migration whose checksum changed', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(
      'tampered',
      '001_initial.sql',
    );
    expectReconCode(() => runMigrations(db), 'MigrationError');
  });
});

describe('SqliteReconRepository entities', () => {
  it('round-trips a project', async () => {
    const { repo } = openRepo();
    const project = createProject({
      name: 'AcmeVault',
      description: 'demo',
      chains: ['ethereum', 'base', 'ethereum'],
      repository: 'https://example.com/repo',
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    });
    await repo.createProject(project);
    expect(await repo.getProject(project.id)).toEqual(project);
  });

  it('round-trips a contract and finds it by address case-insensitively', async () => {
    const { repo } = openRepo();
    const contract = createContract({
      name: 'Vault',
      chain_id: 'ethereum',
      address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      contract_type: 'vault',
      source_file: 'src/Vault.sol',
      source_verified: true,
      compiler_version: '0.8.24',
      is_proxy: false,
    });
    const stored = await repo.createContract(contract);
    expect(stored).toEqual(contract);
    expect(await repo.getContract(contract.id)).toEqual(contract);
    const found = await repo.findContractByAddress('Ethereum', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(found).toEqual(contract);
    expect(await repo.getContract('contract:ethereum:0x1111111111111111111111111111111111111111')).toBeNull();
    expect(await repo.findContractByAddress('ethereum', '0x1111111111111111111111111111111111111111')).toBeNull();
  });

  it('treats an identical contract write as idempotent', async () => {
    const { repo } = openRepo();
    const contract = createContract({
      name: 'Vault',
      chain_id: 'ethereum',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contract_type: 'vault',
    });
    const first = await repo.createContract(contract);
    const second = await repo.createContract({ ...contract });
    expect(second).toEqual(first);
  });

  it('rejects a conflicting contract with the same id', async () => {
    const { repo } = openRepo();
    const contract = createContract({
      name: 'Vault',
      chain_id: 'ethereum',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contract_type: 'vault',
    });
    await repo.createContract(contract);
    expectReconCode(
      () => repo.createContract({ ...contract, name: 'VaultRenamed' }),
      'DuplicateCanonicalEntity',
    );
  });

  it('round-trips functions, state variables, assets, roles, and dependencies', async () => {
    const { repo } = openRepo();
    const contract = createContract({
      name: 'Vault',
      chain_id: 'ethereum',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contract_type: 'vault',
    });
    await repo.createContract(contract);
    const fn = createFunction({
      contract_id: contract.id,
      name: 'deposit',
      visibility: 'external',
      mutability: 'nonpayable',
      parameters: [{ name: 'shares', type: 'uint256' }],
      returns: [{ type: 'uint256' }],
      modifiers: ['nonReentrant'],
      selector: '0x6e553f65',
    });
    await repo.createFunction(fn);
    expect(await repo.getFunction(fn.id)).toEqual(fn);

    const stateVar = createStateVariable({
      contract_id: contract.id,
      name: 'totalShares',
      type: 'uint256',
      visibility: 'public',
      slot: '0x0',
    });
    await repo.createStateVariable(stateVar);
    expect(await repo.getStateVariable(stateVar.id)).toEqual(stateVar);

    const asset = createAsset({
      name: 'USD Coin',
      chain_id: 'ethereum',
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      asset_type: 'erc20',
      decimals: 6,
      custody: 'pool',
    });
    await repo.createAsset(asset);
    expect(await repo.getAsset(asset.id)).toEqual(asset);

    const role = createRole({
      contract_id: contract.id,
      name: 'admin',
      role_type: 'admin',
      holder: '0x1111111111111111111111111111111111111111',
    });
    await repo.createRole(role);
    expect(await repo.getRole(role.id)).toEqual(role);

    const dependency = createDependency({
      name: 'Chainlink ETH/USD',
      dependency_type: 'oracle',
      interface: 'AggregatorV3Interface',
      trust_level: 'high',
    });
    await repo.createDependency(dependency);
    expect(await repo.getDependency(dependency.id)).toEqual(dependency);
  });

  it('returns null for unknown epistemic and relationship ids', async () => {
    const { repo } = openRepo();
    expect(await repo.getFact('fact:0000000000000000')).toBeNull();
    expect(await repo.getRelationship('rel:0000000000000000')).toBeNull();
    expect(await repo.getObservation('obs:0000000000000000')).toBeNull();
  });
});

describe('SqliteReconRepository relationships', () => {
  it('round-trips a relationship and serves endpoint and type queries', async () => {
    const { repo } = openRepo();
    const contract = createContract({
      name: 'Vault',
      chain_id: 'ethereum',
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contract_type: 'vault',
    });
    await repo.createContract(contract);
    const deposit = createFunction({
      contract_id: contract.id,
      name: 'deposit',
      visibility: 'external',
      mutability: 'nonpayable',
    });
    const withdraw = createFunction({
      contract_id: contract.id,
      name: 'withdraw',
      visibility: 'external',
      mutability: 'nonpayable',
    });
    await repo.createFunction(deposit);
    await repo.createFunction(withdraw);
    const relationship = createRelationship({
      type: 'CALLS',
      source_id: withdraw.id,
      target_id: deposit.id,
      metadata: { note: 'internal call', depth: 1 },
      provenance: [SRC],
      created_at: FIXED_TS,
    });
    await repo.createRelationship(relationship);
    expect(await repo.getRelationship(relationship.id)).toEqual(relationship);

    const outgoing = await repo.getRelationshipsFrom(withdraw.id);
    expect(outgoing).toEqual([relationship]);
    expect(await repo.getRelationshipsTo(deposit.id)).toEqual([relationship]);
    expect(await repo.getRelationshipsFrom(deposit.id)).toEqual([]);
    expect(await repo.findRelationshipsByType('CALLS')).toEqual([relationship]);
    expect(await repo.findRelationshipsByType('MINTS')).toEqual([]);
  });
});

describe('SqliteReconRepository epistemic records', () => {
  it('round-trips a fact, observation, assumption, hypothesis, and evidence', async () => {
    const { repo } = openRepo();
    const fixture = baseFixture();
    const contract = fixture.contracts?.[0];
    const fact = fixture.facts?.[0];
    const observation = fixture.observations?.[0];
    const assumption = fixture.assumptions?.[0];
    const hypothesis = fixture.hypotheses?.[0];
    const evidence = fixture.evidence?.[0];
    if (
      contract === undefined ||
      fact === undefined ||
      observation === undefined ||
      assumption === undefined ||
      hypothesis === undefined ||
      evidence === undefined
    ) {
      throw new Error('fixture incomplete');
    }
    await repo.createContract(contract);
    await repo.createFact(fact);
    expect(await repo.getFact(fact.id)).toEqual(fact);

    await repo.createObservation(observation);
    expect(await repo.getObservation(observation.id)).toEqual(observation);

    await repo.createAssumption(assumption);
    expect(await repo.getAssumption(assumption.id)).toEqual(assumption);

    await repo.createHypothesis(hypothesis);
    expect(await repo.getHypothesis(hypothesis.id)).toEqual(hypothesis);

    await repo.createEvidence(evidence);
    expect(await repo.getEvidence(evidence.id)).toEqual(evidence);
  });

  it('treats an identical fact write as idempotent and rejects conflicting content', async () => {
    const { repo } = openRepo();
    const fixture = baseFixture();
    const fact = fixture.facts?.[0];
    if (fact === undefined) throw new Error('fixture incomplete');
    await repo.createFact(fact);
    expect(await repo.createFact({ ...fact, created_at: '2025-06-01T00:00:00.000Z' })).toEqual(fact);
    expectReconCode(
      () => repo.createFact({ ...fact, predicate: 'READS' }),
      'DuplicateCanonicalEntity',
    );
  });
});

describe('SqliteReconRepository state', () => {
  it('returns null when no state was ever saved', async () => {
    const { repo } = openRepo();
    expect(await repo.loadState()).toBeNull();
  });

  it('persists a full state with a byte-identical serialization', async () => {
    const { repo } = openRepo();
    const state = createReconState(baseFixture());
    await repo.saveState(state);
    const loaded = await repo.loadState();
    expect(loaded).not.toBeNull();
    expect(serializeReconState(loaded!)).toBe(serializeReconState(state));
  });

  it('is idempotent when the same state is saved twice', async () => {
    const { repo } = openRepo();
    const state = createReconState(baseFixture());
    await repo.saveState(state);
    await repo.saveState(createReconState(baseFixture()));
    const loaded = await repo.loadState();
    expect(serializeReconState(loaded!)).toBe(serializeReconState(state));
  });

  it('persists an empty state distinctly from never saving', async () => {
    const { repo } = openRepo();
    await repo.saveState(createReconState({}));
    const loaded = await repo.loadState();
    expect(loaded).not.toBeNull();
    expect(loaded?.contracts).toEqual([]);
    expect(loaded?.facts).toEqual([]);
  });
});
