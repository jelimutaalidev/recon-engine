import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import {
  DEFAULT_MIGRATIONS_DIR,
  openDatabase,
  runMigrations,
} from '../../src/repository/migrate.js';
import { SqliteReconRepository } from '../../src/repository/sqlite.js';
import { createReconState, serializeReconState } from '../../src/recon-state/state.js';
import type { ReconState, ReconStateInput } from '../../src/recon-state/schema.js';
import { createContract } from '../../src/domain/contract.js';
import { createFunction } from '../../src/domain/function.js';
import { createStateVariable } from '../../src/domain/state-variable.js';
import { createRelationship } from '../../src/relationships/relationship.js';
import { createFact } from '../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import {
  isReconError,
  type ReconErrorCode,
  type ReconErrorDetails,
} from '../../src/errors/errors.js';
import type {
  Derivation,
  ReconRun,
  RunOutputRecord,
  TraceReference,
  TraceabilityState,
} from '../../src/traceability/types.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';
const LATER_TS = '2024-06-01T00:00:00.000Z';
const RUN_ID = 'run:0123456789abcdef';
const DERIVATION_1_ID = 'derivation:0000000000000001';
const DERIVATION_2_ID = 'derivation:0000000000000002';

function expectReconCode(fn: () => unknown, code: ReconErrorCode): ReconErrorDetails {
  try {
    fn();
  } catch (error) {
    expect(isReconError(error)).toBe(true);
    if (isReconError(error)) {
      expect(error.code).toBe(code);
      return error.details;
    }
    return {};
  }
  throw new Error(`expected ReconError ${code}, but call succeeded`);
}

function openRepo(): { db: Database; repo: SqliteReconRepository } {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return { db, repo: new SqliteReconRepository(db) };
}

const SRC: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Vault.sol',
  line_start: 40,
  line_end: 52,
};

interface MaterialIds {
  contract: string;
  fn: string;
  stateVariable: string;
  relationship: string;
  fact: string;
}

function buildBase(): { input: ReconStateInput; ids: MaterialIds } {
  const contract = createContract({
    name: 'Vault',
    chain_id: 'ethereum',
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    contract_type: 'vault',
  });
  const deposit = createFunction({
    contract_id: contract.id,
    name: 'deposit',
    visibility: 'external',
    mutability: 'nonpayable',
    parameters: [{ type: 'uint256' }],
  });
  const stateVar = createStateVariable({
    contract_id: contract.id,
    name: 'totalShares',
    type: 'uint256',
    visibility: 'public',
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
  return {
    input: {
      schema_version: 'recon-state/v1',
      contracts: [contract],
      functions: [deposit],
      state_variables: [stateVar],
      relationships: [relationship],
      facts: [fact],
    },
    ids: {
      contract: contract.id,
      fn: deposit.id,
      stateVariable: stateVar.id,
      relationship: relationship.id,
      fact: fact.id,
    },
  };
}

function runFixture(outputHash: string): ReconRun {
  return {
    id: RUN_ID,
    project_id: 'project:0123456789abcdef',
    schema_version: 'recon-state/v1',
    analyzer_version: '0.1.0',
    started_at: FIXED_TS,
    completed_at: FIXED_TS,
    status: 'COMPLETED',
    source_identity: {
      source_hash: '1'.repeat(64),
      manifest_hash: '2'.repeat(64),
      repository: 'https://example.com/acme.git',
      commit: 'abc123def456',
      source_root: 'contracts',
    },
    compiler_identity: {
      compiler: 'solc',
      version: '0.8.37+commit.f704f362',
      binary_hash: '3'.repeat(64),
      backend: 'solc-js',
    },
    configuration_identity: { config_hash: '4'.repeat(64) },
    input_manifest_hash: '5'.repeat(64),
    output_identity: { output_hash: outputHash, serialization: 'recon-state-json/v1' },
  };
}

function derivationFixture(overrides: Partial<Derivation> = {}): Derivation {
  return {
    id: DERIVATION_1_ID,
    run_id: RUN_ID,
    operation: 'extract-storage-access',
    operation_version: '0.1.0',
    inputs: [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }],
    outputs: [],
    provenance: ['src/Vault.sol:40-52'],
    status: 'COMPLETED',
    metadata: { fidelity: 'exact' },
    ...overrides,
  };
}

function materialRefs(ids: MaterialIds): TraceReference[] {
  return [
    { entity_type: 'contract', entity_id: ids.contract },
    { entity_type: 'function', entity_id: ids.fn },
    { entity_type: 'state_variable', entity_id: ids.stateVariable },
    { entity_type: 'relationship', entity_id: ids.relationship },
    { entity_type: 'fact', entity_id: ids.fact },
  ];
}

function lineageOutputs(runId: string, ids: MaterialIds): RunOutputRecord[] {
  return [
    {
      run_id: runId,
      entity_type: 'contract',
      entity_id: ids.contract,
      content_hash: '6'.repeat(64),
    },
    {
      run_id: runId,
      entity_type: 'fact',
      entity_id: ids.fact,
      content_hash: '7'.repeat(64),
    },
    {
      run_id: runId,
      entity_type: 'function',
      entity_id: ids.fn,
      content_hash: '8'.repeat(64),
    },
  ];
}

function traceFixture(ids: MaterialIds, outputHash: string): TraceabilityState {
  return {
    runs: [runFixture(outputHash)],
    derivations: [
      derivationFixture({
        outputs: [
          { entity_type: 'contract', entity_id: ids.contract },
          { entity_type: 'function', entity_id: ids.fn },
          { entity_type: 'state_variable', entity_id: ids.stateVariable },
        ],
        provenance: ['src/Vault.sol:40-52', 'ethereum:19000000'],
      }),
      derivationFixture({
        id: DERIVATION_2_ID,
        operation: 'link-epistemic',
        outputs: [
          { entity_type: 'relationship', entity_id: ids.relationship },
          { entity_type: 'fact', entity_id: ids.fact },
        ],
        status: 'PARTIAL',
        metadata: { fidelity: 'approximate' },
      }),
    ],
    outputs: lineageOutputs(RUN_ID, ids),
  };
}

function currentHash(input: ReconStateInput): string {
  const state = createReconState(input);
  return createHash('sha256')
    .update(serializeReconState(state, { omitTraceability: true }), 'utf8')
    .digest('hex');
}

function count(db: Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('traceability persistence', () => {
  it('save/load preserves full traceability', () => {
    const { repo } = openRepo();
    const base = buildBase();
    const state = createReconState({
      ...base.input,
      traceability: traceFixture(base.ids, currentHash(base.input)),
    });

    repo.saveState(state);
    const loaded = repo.loadState();

    expect(loaded).not.toBeNull();
    expect(loaded?.traceability).toEqual(state.traceability);
    expect(serializeReconState(loaded!)).toBe(serializeReconState(state));
  });

  it('state without traceability round-trips unchanged', () => {
    const { repo } = openRepo();
    const base = buildBase();
    const state = createReconState(base.input);

    repo.saveState(state);
    const loaded = repo.loadState();

    expect(loaded).not.toBeNull();
    expect(loaded?.traceability).toBeUndefined();
    expect(serializeReconState(loaded!)).toBe(serializeReconState(state));
  });

  it('corrupted current-run reference is rejected on load', () => {
    const { repo } = openRepo();
    const base = buildBase();
    const corrupted: ReconState = {
      ...createReconState(base.input),
      traceability: {
        runs: [runFixture(currentHash(base.input))],
        derivations: [
          derivationFixture({
            outputs: [
              ...materialRefs(base.ids),
              { entity_type: 'contract', entity_id: 'contract:missing' },
            ],
          }),
        ],
        outputs: lineageOutputs(RUN_ID, base.ids),
      },
    };

    repo.saveState(corrupted);

    const details = expectReconCode(() => repo.loadState(), 'InvalidReconState');
    expect(details.issues).toEqual([
      { check: 'traceability', source: DERIVATION_1_ID, missing: ['contract:missing'] },
    ]);
  });

  it('idempotent re-save stores one run', () => {
    const { db, repo } = openRepo();
    const base = buildBase();
    const traceability = traceFixture(base.ids, currentHash(base.input));
    const state = createReconState({ ...base.input, traceability });

    repo.saveState(state);
    repo.saveState(state);

    expect(count(db, 'runs')).toBe(1);
    expect(count(db, 'derivations')).toBe(2);
    expect(count(db, 'run_outputs')).toBe(3);

    const resaved = createReconState({
      ...base.input,
      traceability: {
        ...traceability,
        runs: [{ ...traceability.runs[0]!, started_at: LATER_TS }],
      },
    });
    repo.saveState(resaved);

    expect(count(db, 'runs')).toBe(1);
    const row = db.prepare('SELECT started_at FROM runs WHERE id = ?').get(RUN_ID) as {
      started_at: string;
    };
    expect(row.started_at).toBe(LATER_TS);

    const divergent = createReconState({
      ...base.input,
      traceability: {
        ...traceability,
        derivations: [
          { ...traceability.derivations[0]!, provenance: ['src/Vault.sol:1-10'] },
          traceability.derivations[1]!,
        ],
      },
    });
    expectReconCode(() => repo.saveState(divergent), 'DuplicateCanonicalEntity');
    expect(count(db, 'runs')).toBe(1);
    expect(count(db, 'derivations')).toBe(2);
  });
});

describe('migration 003', () => {
  it('upgrades a database that already has 001 and 002', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-migrations-'));
    try {
      copyFileSync(
        join(DEFAULT_MIGRATIONS_DIR, '001_initial.sql'),
        join(dir, '001_initial.sql'),
      );
      copyFileSync(
        join(DEFAULT_MIGRATIONS_DIR, '002_phase2_extraction_fields.sql'),
        join(dir, '002_phase2_extraction_fields.sql'),
      );
      const db = openDatabase(':memory:');

      runMigrations(db, dir);
      const before = db.prepare('SELECT version FROM schema_migrations').all() as {
        version: string;
      }[];
      expect(before.map((row) => row.version)).toEqual([
        '001_initial.sql',
        '002_phase2_extraction_fields.sql',
      ]);

      runMigrations(db);
      const after = db.prepare('SELECT version FROM schema_migrations').all() as {
        version: string;
      }[];
      expect(after.map((row) => row.version)).toEqual([
        '001_initial.sql',
        '002_phase2_extraction_fields.sql',
        '003_traceability.sql',
      ]);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      const names = new Set(tables.map((row) => row.name));
      expect(names.has('runs')).toBe(true);
      expect(names.has('derivations')).toBe(true);
      expect(names.has('run_outputs')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
