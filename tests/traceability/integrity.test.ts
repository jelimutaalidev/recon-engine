import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../../src/repository/migrate.js';
import { SqliteReconRepository } from '../../src/repository/sqlite.js';
import { createReconState } from '../../src/recon-state/state.js';
import type { ReconStateInput } from '../../src/recon-state/schema.js';
import { createContract } from '../../src/domain/contract.js';
import { createFunction } from '../../src/domain/function.js';
import { createStateVariable } from '../../src/domain/state-variable.js';
import { createRelationship } from '../../src/relationships/relationship.js';
import { createFact } from '../../src/epistemic/fact.js';
import { createObservation } from '../../src/epistemic/observation.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import { contractId } from '../../src/ids/ids.js';
import { isReconError, type ReconErrorDetails } from '../../src/errors/errors.js';
import {
  computeOutputIdentity,
  createRunId,
  createTraceabilityService,
  derivationId,
  type Derivation,
  type InputManifestPayload,
  type ReconRun,
  type RunOutputRecord,
  type TraceReference,
  type TraceabilityService,
} from '../../src/traceability/index.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';
const LEGACY_OUTPUT_HASH = '0'.repeat(64);
const RUN_ID = 'run:0123456789abcdef';
const RUN_A = 'run:aaaaaaaaaaaaaaaa';
const RUN_B = 'run:bbbbbbbbbbbbbbbb';
const DERIVATION_ID = 'derivation:0123456789abcdef';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const GHOST_ID = contractId({
  name: 'Ghost',
  chainId: 'ethereum',
  address: '0xcccccccccccccccccccccccccccccccccccccccc',
});

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

function runFixture(id: string = RUN_ID, overrides: Partial<ReconRun> = {}): ReconRun {
  return {
    id,
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
      backend: 'solc-js',
    },
    configuration_identity: { config_hash: '4'.repeat(64) },
    input_manifest_hash: '5'.repeat(64),
    output_identity: { output_hash: LEGACY_OUTPUT_HASH, serialization: 'recon-state-json/v1' },
    ...overrides,
  };
}

function derivationFixture(overrides: Partial<Derivation> = {}): Derivation {
  return {
    id: DERIVATION_ID,
    run_id: RUN_ID,
    operation: 'extract.storage_access',
    operation_version: '0.1.0',
    inputs: [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }],
    outputs: [],
    provenance: ['src/Vault.sol:40-52'],
    status: 'COMPLETED',
    ...overrides,
  };
}

function materialRefs(ids: MaterialIds): TraceReference[] {
  return [
    { entity_type: 'contract', entity_id: ids.contract },
    { entity_type: 'fact', entity_id: ids.fact },
    { entity_type: 'function', entity_id: ids.fn },
    { entity_type: 'relationship', entity_id: ids.relationship },
    { entity_type: 'state_variable', entity_id: ids.stateVariable },
  ];
}

function outputRecords(runId: string, ids: MaterialIds): RunOutputRecord[] {
  return materialRefs(ids).map((ref) => ({
    run_id: runId,
    entity_type: ref.entity_type,
    entity_id: ref.entity_id,
    content_hash: 'f'.repeat(64),
  }));
}

function currentHash(input: ReconStateInput): string {
  return computeOutputIdentity(createReconState(input)).output_hash;
}

function serviceFor(input: ReconStateInput): TraceabilityService {
  return createTraceabilityService(createReconState(input));
}

function catchRecon(fn: () => unknown): { code: string; details: ReconErrorDetails } {
  try {
    fn();
  } catch (error) {
    if (isReconError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error('expected ReconError, but call succeeded');
}

function catchCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isReconError(error)) return error.code;
    throw error;
  }
  throw new Error('expected ReconError, but call succeeded');
}

interface TraceIssue {
  check: string;
  source: string;
  missing: string[];
}

function traceIssues(details: ReconErrorDetails): TraceIssue[] {
  return details.issues as TraceIssue[];
}

function openRepo(): SqliteReconRepository {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return new SqliteReconRepository(db);
}

function withLegacyContractSource(base: {
  input: ReconStateInput;
  ids: MaterialIds;
}): { input: ReconStateInput; ids: MaterialIds } {
  return {
    input: {
      ...base.input,
      contracts: [{ ...base.input.contracts![0]!, source: 'src/Legacy.sol:1-9' }],
    },
    ids: base.ids,
  };
}

interface CrossRunFixture {
  service: TraceabilityService;
  ids: MaterialIds;
  derivA: Derivation;
  derivB: Derivation;
}

function crossRunFixture(): CrossRunFixture {
  const base = withLegacyContractSource(buildBase());
  const inputsA: TraceReference[] = [{ entity_type: 'source_file', entity_id: 'src/Legacy.sol' }];
  const provenanceA = ['src/Legacy.sol:1-9'];
  const inputsB: TraceReference[] = [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }];
  const provenanceB = ['src/Vault.sol:40-52'];
  const derivA: Derivation = {
    id: derivationId(RUN_A, 'extract.storage_access', inputsA, provenanceA),
    run_id: RUN_A,
    operation: 'extract.storage_access',
    operation_version: '0.1.0',
    inputs: inputsA,
    outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
    provenance: provenanceA,
    status: 'COMPLETED',
  };
  const derivB: Derivation = {
    id: derivationId(RUN_B, 'extract.contracts', inputsB, provenanceB),
    run_id: RUN_B,
    operation: 'extract.contracts',
    operation_version: '0.1.0',
    inputs: inputsB,
    outputs: materialRefs(base.ids),
    provenance: provenanceB,
    status: 'COMPLETED',
  };
  const service = serviceFor({
    ...base.input,
    traceability: {
      runs: [
        runFixture(RUN_A, {
          source_identity: { source_hash: HASH_A, manifest_hash: '2'.repeat(64) },
        }),
        runFixture(RUN_B, {
          source_identity: { source_hash: HASH_B, manifest_hash: '2'.repeat(64) },
          output_identity: {
            output_hash: currentHash(base.input),
            serialization: 'recon-state-json/v1',
          },
        }),
      ],
      derivations: [derivA, derivB],
      outputs: [
        ...outputRecords(RUN_B, base.ids),
        {
          run_id: RUN_A,
          entity_type: 'relationship',
          entity_id: base.ids.relationship,
          content_hash: '1'.repeat(64),
        },
      ],
    },
  });
  return { service, ids: base.ids, derivA, derivB };
}

describe('cross-run isolation (spec §17 T10, ruling R7)', () => {
  it('cross-run isolation: getRun resolves the current run while each derivation keeps its own run endpoint', () => {
    const { service, ids, derivA, derivB } = crossRunFixture();

    expect(service.getRun(ids.relationship)?.id).toBe(RUN_B);

    const derivations = service.getDerivations(ids.relationship);
    expect(derivations.map((item) => item.id)).toEqual([derivA.id, derivB.id]);
    expect(derivations.map((item) => item.run_id)).toEqual([RUN_A, RUN_B]);
    expect(derivA.id).not.toBe(derivB.id);
    expect(derivA.id).toMatch(/^derivation:run:aaaaaaaaaaaaaaaa:extract\.storage_access:[0-9a-f]{16}$/);
    expect(derivB.id).toMatch(/^derivation:run:bbbbbbbbbbbbbbbb:extract\.contracts:[0-9a-f]{16}$/);
    expect(derivA.id.startsWith(`derivation:${RUN_B}:`)).toBe(false);
    expect(derivB.id.startsWith(`derivation:${RUN_A}:`)).toBe(false);
    for (const item of derivations) {
      expect(item.id.startsWith(`derivation:${item.run_id}:`)).toBe(true);
      expect(service.getRunById(item.run_id)?.id).toBe(item.run_id);
    }

    expect(service.findRunsBySourceIdentity(HASH_A).map((run) => run.id)).toEqual([RUN_A]);
    expect(service.findRunsBySourceIdentity(HASH_B).map((run) => run.id)).toEqual([RUN_B]);
    expect(service.getOutputs(RUN_A)).toEqual([
      { entity_type: 'relationship', entity_id: ids.relationship },
    ]);
    expect(service.findOrphanedTraceReferences()).toEqual([]);
    expect(service.getTraceStatus(ids.relationship)).toBe('COMPLETE');
  });

  it('cross-run isolation: backward trace exposes both runs without cross-attribution and forward chains stay per-run', () => {
    const { service, ids, derivA, derivB } = crossRunFixture();

    const trace = service.traceBackward(ids.relationship);
    expect(trace.status).toBe('COMPLETE');
    expect(trace.truncated).toBe(false);
    expect(trace.nodes).toEqual([
      { kind: 'entity', id: ids.relationship, depth: 0 },
      { kind: 'derivation', id: derivA.id, depth: 1 },
      { kind: 'derivation', id: derivB.id, depth: 1 },
      { kind: 'source_file', id: 'src/Legacy.sol', depth: 2 },
      { kind: 'provenance_span', id: 'src/Legacy.sol:1-9', depth: 2 },
      { kind: 'source_file', id: 'src/Vault.sol', depth: 2 },
      { kind: 'provenance_span', id: 'src/Vault.sol:40-52', depth: 2 },
      { kind: 'source_identity', id: HASH_A, depth: 3 },
      { kind: 'source_identity', id: HASH_B, depth: 3 },
      { kind: 'run', id: RUN_A, depth: 4 },
      { kind: 'run', id: RUN_B, depth: 4 },
    ]);
    expect(trace.nodes.filter((node) => node.kind === 'run').map((node) => node.id)).toEqual([
      RUN_A,
      RUN_B,
    ]);

    expect(
      service.traceForward({ entity_type: 'source_file', entity_id: 'src/Legacy.sol' }).nodes,
    ).toEqual([
      { kind: 'source_file', id: 'src/Legacy.sol', depth: 0 },
      { kind: 'derivation', id: derivA.id, depth: 1 },
      { kind: 'entity', id: ids.relationship, depth: 2 },
    ]);
    expect(
      service.traceForward({ entity_type: 'source_file', entity_id: 'src/Vault.sol' }).nodes,
    ).toEqual([
      { kind: 'source_file', id: 'src/Vault.sol', depth: 0 },
      { kind: 'derivation', id: derivB.id, depth: 1 },
      { kind: 'entity', id: ids.contract, depth: 2 },
      { kind: 'entity', id: ids.fact, depth: 2 },
      { kind: 'entity', id: ids.fn, depth: 2 },
      { kind: 'entity', id: ids.relationship, depth: 2 },
      { kind: 'entity', id: ids.stateVariable, depth: 2 },
    ]);
  });
});

describe('historical liveness and orphan detection (spec §17 T1, §19)', () => {
  it('historical output refs resolve via run_outputs and load clean without orphan flags', () => {
    const base = buildBase();
    const ghostRef: TraceReference = { entity_type: 'contract', entity_id: GHOST_ID };
    const ghostDerivation = derivationFixture({ run_id: RUN_A, outputs: [ghostRef] });

    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture(RUN_A)],
        derivations: [ghostDerivation],
        outputs: [
          {
            run_id: RUN_A,
            entity_type: 'contract',
            entity_id: GHOST_ID,
            content_hash: '9'.repeat(64),
          },
        ],
      },
    });

    expect(service.findOrphanedTraceReferences()).toEqual([]);
    expect(service.getOutputs(RUN_A)).toEqual([ghostRef]);
    expect(service.getRun(GHOST_ID)?.id).toBe(RUN_A);
    expect(service.getDerivations(GHOST_ID).map((item) => item.id)).toEqual([ghostDerivation.id]);
    expect(catchCode(() => service.traceBackward(GHOST_ID))).toBe('EntityNotFound');
  });

  it('orphan detection reports a dangling historical output ref; traceForward accepts it with NOT_APPLICABLE status', () => {
    const base = buildBase();
    const ghostRef: TraceReference = { entity_type: 'contract', entity_id: GHOST_ID };
    const ghostDerivation = derivationFixture({ run_id: RUN_A, outputs: [ghostRef] });

    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture(RUN_A)],
        derivations: [ghostDerivation],
        outputs: [],
      },
    });
    expect(service.findOrphanedTraceReferences()).toEqual([
      { run_id: RUN_A, derivation_id: ghostDerivation.id, ref: ghostRef },
    ]);

    const restored = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture(RUN_A)],
        derivations: [ghostDerivation],
        outputs: [
          {
            run_id: RUN_A,
            entity_type: 'contract',
            entity_id: GHOST_ID,
            content_hash: '9'.repeat(64),
          },
        ],
      },
    });
    expect(restored.findOrphanedTraceReferences()).toEqual([]);

    const forward = service.traceForward(ghostRef);
    expect(forward.status).toBe('NOT_APPLICABLE');
    expect(forward.nodes).toEqual([{ kind: 'entity', id: GHOST_ID, depth: 0 }]);
    expect(catchCode(() => service.traceBackward(GHOST_ID))).toBe('EntityNotFound');
  });
});

describe('incomplete traces are explicit (spec §17 T7/T8, §22)', () => {
  it('findIncompleteTraces lists PARTIAL and MISSING and never includes NOT_APPLICABLE objects', () => {
    const missing = createContract({ name: 'NoLine', contract_type: 'core' });
    const partialSpan = createContract({
      name: 'SpanLine',
      contract_type: 'core',
      source: 'src/Part.sol:1-9',
    });
    const partialDerivation = createContract({ name: 'DerivedLine', contract_type: 'core' });
    const complete = createContract({
      name: 'FullLine',
      contract_type: 'core',
      source: 'src/Full.sol:1-9',
    });
    const observation = createObservation({
      statement: 'non-material objects carry no trace obligation',
      provenance: [SRC],
    });

    const service = serviceFor({
      schema_version: 'recon-state/v1',
      contracts: [missing, partialSpan, partialDerivation, complete],
      observations: [observation],
      traceability: {
        runs: [runFixture()],
        derivations: [
          derivationFixture({
            id: 'derivation:0000000000000001',
            inputs: [{ entity_type: 'source_file', entity_id: 'src/Full.sol' }],
            outputs: [{ entity_type: 'contract', entity_id: complete.id }],
            provenance: ['src/Full.sol:1-9'],
          }),
          derivationFixture({
            id: 'derivation:0000000000000002',
            inputs: [{ entity_type: 'source_file', entity_id: 'src/Full.sol' }],
            outputs: [{ entity_type: 'contract', entity_id: partialDerivation.id }],
            provenance: ['src/Full.sol:1-9'],
          }),
        ],
        outputs: [],
      },
    });

    expect(service.getTraceStatus(missing.id)).toBe('MISSING');
    expect(service.getTraceStatus(partialSpan.id)).toBe('PARTIAL');
    expect(service.getTraceStatus(partialDerivation.id)).toBe('PARTIAL');
    expect(service.getTraceStatus(complete.id)).toBe('COMPLETE');
    expect(service.getTraceStatus(observation.id)).toBe('NOT_APPLICABLE');

    const incomplete = service.findIncompleteTraces();
    expect(incomplete).toHaveLength(3);
    expect(new Set(incomplete.map((entry) => entry.entity_id))).toEqual(
      new Set([missing.id, partialSpan.id, partialDerivation.id]),
    );
    expect(
      incomplete.every((entry) => entry.status === 'MISSING' || entry.status === 'PARTIAL'),
    ).toBe(true);
    expect(incomplete.some((entry) => entry.status === 'NOT_APPLICABLE')).toBe(false);
    expect(incomplete.some((entry) => entry.entity_id === observation.id)).toBe(false);
    expect(incomplete.some((entry) => entry.entity_id === complete.id)).toBe(false);
    expect(service.findOrphanedTraceReferences()).toEqual([]);
  });

  it('T7 no false resolution: zero-lineage entity stays MISSING beside COMPLETE siblings', () => {
    const traced = createContract({
      name: 'Traced',
      contract_type: 'core',
      source: 'src/Traced.sol:1-9',
    });
    const untraced = createContract({ name: 'Untraced', contract_type: 'core' });

    const service = serviceFor({
      schema_version: 'recon-state/v1',
      contracts: [traced, untraced],
      traceability: {
        runs: [runFixture()],
        derivations: [
          derivationFixture({
            id: 'derivation:0000000000000001',
            inputs: [{ entity_type: 'source_file', entity_id: 'src/Traced.sol' }],
            outputs: [{ entity_type: 'contract', entity_id: traced.id }],
            provenance: ['src/Traced.sol:1-9'],
          }),
        ],
        outputs: [],
      },
    });

    expect(service.getTraceStatus(traced.id)).toBe('COMPLETE');
    expect(service.getTraceStatus(untraced.id)).toBe('MISSING');
    expect(service.getDerivations(untraced.id)).toEqual([]);
    expect(service.getRun(untraced.id)).toBeUndefined();
    expect(service.traceBackward(untraced.id)).toEqual({
      root: untraced.id,
      direction: 'backward',
      status: 'MISSING',
      nodes: [{ kind: 'entity', id: untraced.id, depth: 0 }],
      truncated: false,
    });
    expect(service.findIncompleteTraces()).toEqual([
      { entity_type: 'contract', entity_id: untraced.id, status: 'MISSING' },
    ]);
    expect(catchCode(() => service.getTraceStatus('contract:absent'))).toBe('EntityNotFound');
  });
});

describe('historical provenance persists across runs (spec §17 T5, §19)', () => {
  it('saving a later run keeps both runs derivations, provenance spans, and analyzer records intact after reload', () => {
    const repo = openRepo();
    const base = withLegacyContractSource(buildBase());
    const inputsA: TraceReference[] = [{ entity_type: 'source_file', entity_id: 'src/Legacy.sol' }];
    const provenanceA = ['src/Legacy.sol:1-9'];
    const inputsB: TraceReference[] = [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }];
    const provenanceB = ['src/Vault.sol:40-52'];
    const derivA: Derivation = {
      id: derivationId(RUN_A, 'extract.storage_access', inputsA, provenanceA),
      run_id: RUN_A,
      operation: 'extract.storage_access',
      operation_version: '0.1.0',
      inputs: inputsA,
      outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
      provenance: provenanceA,
      status: 'COMPLETED',
    };
    const derivB: Derivation = {
      id: derivationId(RUN_B, 'extract.contracts', inputsB, provenanceB),
      run_id: RUN_B,
      operation: 'extract.contracts',
      operation_version: '0.2.0',
      inputs: inputsB,
      outputs: materialRefs(base.ids),
      provenance: provenanceB,
      status: 'COMPLETED',
    };

    repo.saveState(
      createReconState({
        ...base.input,
        traceability: {
          runs: [
            runFixture(RUN_A, {
              analyzer_version: '0.1.0',
              source_identity: { source_hash: HASH_A, manifest_hash: '2'.repeat(64) },
            }),
          ],
          derivations: [derivA],
          outputs: [
            {
              run_id: RUN_A,
              entity_type: 'relationship',
              entity_id: base.ids.relationship,
              content_hash: '1'.repeat(64),
            },
          ],
        },
      }),
    );
    repo.saveState(
      createReconState({
        ...base.input,
        traceability: {
          runs: [
            runFixture(RUN_B, {
              analyzer_version: '0.2.0',
              source_identity: { source_hash: HASH_B, manifest_hash: '2'.repeat(64) },
              output_identity: {
                output_hash: currentHash(base.input),
                serialization: 'recon-state-json/v1',
              },
            }),
          ],
          derivations: [derivB],
          outputs: outputRecords(RUN_B, base.ids),
        },
      }),
    );

    const loaded = repo.loadState();
    expect(loaded).not.toBeNull();
    const traceability = loaded!.traceability!;
    expect(traceability.runs.map((run) => run.id)).toEqual([RUN_A, RUN_B]);
    expect(traceability.runs.map((run) => run.analyzer_version)).toEqual(['0.1.0', '0.2.0']);
    expect(traceability.runs.map((run) => run.source_identity.source_hash)).toEqual([
      HASH_A,
      HASH_B,
    ]);
    expect(traceability.derivations.map((item) => item.id)).toEqual([derivA.id, derivB.id]);
    const reloadedA = traceability.derivations.find((item) => item.id === derivA.id);
    expect(reloadedA?.provenance).toEqual(['src/Legacy.sol:1-9']);
    expect(reloadedA?.run_id).toBe(RUN_A);
    expect(reloadedA?.operation_version).toBe('0.1.0');
    expect(traceability.outputs.filter((record) => record.run_id === RUN_A)).toEqual([
      {
        run_id: RUN_A,
        entity_type: 'relationship',
        entity_id: base.ids.relationship,
        content_hash: '1'.repeat(64),
      },
    ]);

    const service = createTraceabilityService(loaded!);
    expect(service.findOrphanedTraceReferences()).toEqual([]);
    expect(service.getRun(base.ids.relationship)?.id).toBe(RUN_B);
    const backward = service.traceBackward(base.ids.relationship);
    expect(
      backward.nodes
        .filter((node) => node.kind === 'derivation')
        .map((node) => node.id)
        .sort(),
    ).toEqual([derivA.id, derivB.id].sort());
    expect(
      backward.nodes.filter((node) => node.kind === 'run').map((node) => node.id),
    ).toEqual([RUN_A, RUN_B]);
  });
});

describe('versioned derivations (spec §17 T6, §18)', () => {
  it('versioned derivation distinguishable: analyzer version change yields a distinct derivation id for identical inputs', () => {
    const inputs: TraceReference[] = [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }];
    const provenance = ['src/Vault.sol:40-52'];
    const payload = (analyzerVersion: string): InputManifestPayload => ({
      sourceIdentity: { source_hash: '1'.repeat(64), manifest_hash: '2'.repeat(64) },
      configHash: '4'.repeat(64),
      compilerIdentity: {
        compiler: 'solc',
        version: '0.8.37+commit.f704f362',
        backend: 'solc-js',
      },
      analyzerVersion,
      schemaVersion: 'recon-state/v1',
    });

    const runV1 = createRunId(payload('0.1.0'));
    const runV2 = createRunId(payload('0.2.0'));
    expect(runV1).not.toBe(runV2);
    expect(runV1).toMatch(/^run:[0-9a-f]{16}$/);
    expect(runV2).toMatch(/^run:[0-9a-f]{16}$/);

    const idV1 = derivationId(runV1, 'extract.calls', inputs, provenance);
    const idV2 = derivationId(runV2, 'extract.calls', inputs, provenance);
    expect(idV1).not.toBe(idV2);
    expect(idV1).toMatch(/^derivation:run:[0-9a-f]{16}:extract\.calls:[0-9a-f]{16}$/);
    expect(idV2).toMatch(/^derivation:run:[0-9a-f]{16}:extract\.calls:[0-9a-f]{16}$/);
    expect(idV1.split(':').slice(3).join(':')).toBe(idV2.split(':').slice(3).join(':'));
    expect(idV1.split(':').slice(0, 3).join(':')).not.toBe(idV2.split(':').slice(0, 3).join(':'));
    expect(idV1).toBe(derivationId(runV1, 'extract.calls', [...inputs].reverse(), provenance));
  });

  it('versioned derivation distinguishable: findByDerivation excludes other versions while runs record analyzer_version and source_hash', () => {
    const base = buildBase();
    const inputs: TraceReference[] = [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }];
    const provenance = ['src/Vault.sol:40-52'];
    const idV1 = derivationId(RUN_A, 'extract.calls', inputs, provenance);
    const idV2 = derivationId(RUN_B, 'extract.calls', inputs, provenance);
    const outputRef = [{ entity_type: 'relationship', entity_id: base.ids.relationship }];

    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [
          runFixture(RUN_A, { analyzer_version: '0.1.0' }),
          runFixture(RUN_B, { analyzer_version: '0.2.0' }),
        ],
        derivations: [
          {
            id: idV1,
            run_id: RUN_A,
            operation: 'extract.calls',
            operation_version: '0.1.0',
            inputs,
            outputs: outputRef,
            provenance,
            status: 'COMPLETED',
          },
          {
            id: idV2,
            run_id: RUN_B,
            operation: 'extract.calls',
            operation_version: '0.2.0',
            inputs,
            outputs: outputRef,
            provenance,
            status: 'COMPLETED',
          },
        ],
        outputs: [],
      },
    });

    expect(idV1).not.toBe(idV2);
    expect(service.findByDerivation('extract.calls', '0.1.0').map((item) => item.id)).toEqual([
      idV1,
    ]);
    expect(service.findByDerivation('extract.calls', '0.2.0').map((item) => item.id)).toEqual([
      idV2,
    ]);
    expect(service.findByDerivation('extract.calls', '0.3.0')).toEqual([]);

    expect(service.getRunById(RUN_A)?.analyzer_version).toBe('0.1.0');
    expect(service.getRunById(RUN_B)?.analyzer_version).toBe('0.2.0');
    expect(service.getRunById(RUN_A)?.source_identity.source_hash).toBe('1'.repeat(64));
    expect(service.findRunsBySourceIdentity('1'.repeat(64)).map((run) => run.id)).toEqual([
      RUN_A,
      RUN_B,
    ]);

    expect(service.getTraceStatus(base.ids.relationship)).toBe('COMPLETE');
    expect(
      service
        .getDerivations(base.ids.relationship)
        .map((item) => item.id)
        .sort(),
    ).toEqual([idV1, idV2].sort());
    expect(service.findOrphanedTraceReferences()).toEqual([]);
  });
});

describe('assertTraceability integrity rules (spec §17 T1/T2/T3)', () => {
  it('T2 no orphan material output: current run missing one entity derivation throws InvalidReconState', () => {
    const base = buildBase();
    const hash = currentHash(base.input);
    const run = runFixture(RUN_ID, {
      output_identity: { output_hash: hash, serialization: 'recon-state-json/v1' },
    });
    const covered = materialRefs(base.ids).filter((ref) => ref.entity_id !== base.ids.fact);

    const caught = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [derivationFixture({ outputs: covered })],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    );
    expect(caught.code).toBe('InvalidReconState');
    expect(traceIssues(caught.details)).toEqual([
      { check: 'traceability', source: RUN_ID, missing: [base.ids.fact] },
    ]);

    expect(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [derivationFixture({ outputs: materialRefs(base.ids) })],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    ).not.toThrow();
  });

  it('rule (a): derivations must reference an existing run and keep unique ids', () => {
    const base = buildBase();
    const run = runFixture();

    const unknownRun = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [derivationFixture({ run_id: 'run:missing' })],
          outputs: [],
        },
      }),
    );
    expect(unknownRun.code).toBe('InvalidReconState');
    expect(traceIssues(unknownRun.details)).toEqual([
      { check: 'traceability', source: DERIVATION_ID, missing: ['run:missing'] },
    ]);

    const duplicate = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [derivationFixture(), derivationFixture()],
          outputs: [],
        },
      }),
    );
    expect(duplicate.code).toBe('InvalidReconState');
    expect(traceIssues(duplicate.details)).toEqual([
      { check: 'traceability', source: 'derivations', missing: [DERIVATION_ID] },
    ]);

    expect(() =>
      createReconState({
        ...base.input,
        traceability: { runs: [run], derivations: [derivationFixture()], outputs: [] },
      }),
    ).not.toThrow();
  });

  it('rule (b): current-run input files resolve through provenance or span source files', () => {
    const base = buildBase();
    const hash = currentHash(base.input);
    const run = runFixture(RUN_ID, {
      output_identity: { output_hash: hash, serialization: 'recon-state-json/v1' },
    });

    const rejected = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [
            derivationFixture({
              inputs: [{ entity_type: 'source_file', entity_id: 'src/Nowhere.sol' }],
              outputs: materialRefs(base.ids),
            }),
          ],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    );
    expect(rejected.code).toBe('InvalidReconState');
    expect(traceIssues(rejected.details)).toEqual([
      { check: 'traceability', source: DERIVATION_ID, missing: ['src/Nowhere.sol'] },
    ]);

    expect(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [derivationFixture({ outputs: materialRefs(base.ids) })],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    ).not.toThrow();

    const spanInput: ReconStateInput = {
      ...base.input,
      contracts: [{ ...base.input.contracts![0]!, source: 'src/SpanOnly.sol:10-20' }],
    };
    const spanRun = runFixture(RUN_ID, {
      output_identity: {
        output_hash: currentHash(spanInput),
        serialization: 'recon-state-json/v1',
      },
    });
    expect(() =>
      createReconState({
        ...spanInput,
        traceability: {
          runs: [spanRun],
          derivations: [
            derivationFixture({
              inputs: [{ entity_type: 'source_file', entity_id: 'src/SpanOnly.sol' }],
              outputs: materialRefs(base.ids),
            }),
          ],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    ).not.toThrow();
  });
});
