import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/recon/index.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { createReconState } from '../../src/recon-state/state.js';
import type { ReconStateInput } from '../../src/recon-state/schema.js';
import { createContract } from '../../src/domain/contract.js';
import { createFunction } from '../../src/domain/function.js';
import { createStateVariable } from '../../src/domain/state-variable.js';
import { createRelationship } from '../../src/relationships/relationship.js';
import { createFact } from '../../src/epistemic/fact.js';
import { createObservation } from '../../src/epistemic/observation.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import { isReconError } from '../../src/errors/errors.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import {
  createTraceabilityService,
  DEFAULT_TRACE_DEPTH,
  type Derivation,
  type ReconRun,
  type RunOutputRecord,
  type TraceReference,
} from '../../src/traceability/index.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';
const LEGACY_OUTPUT_HASH = '0'.repeat(64);
const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));

const SRC: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Vault.sol',
  line_start: 40,
  line_end: 52,
};
const SRC2: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Other.sol',
  line_start: 1,
  line_end: 9,
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

function runFixture(id: string, overrides: Partial<ReconRun> = {}): ReconRun {
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

function derivation(
  id: string,
  runId: string,
  overrides: Partial<Derivation> = {},
): Derivation {
  return {
    id,
    run_id: runId,
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

function serviceFor(input: ReconStateInput): ReturnType<typeof createTraceabilityService> {
  return createTraceabilityService(createReconState(input));
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

describe('TraceabilityService queries', () => {
  it('getProvenance returns sorted unique entity spans and throws EntityNotFound for unknown ids', () => {
    const base = buildBase();
    const relationship = createRelationship({
      type: 'WRITES',
      source_id: base.ids.fn,
      target_id: base.ids.stateVariable,
      provenance: [SRC, SRC, SRC2],
      created_at: FIXED_TS,
    });
    const spanContract = createContract({
      name: 'SpanOnly',
      contract_type: 'core',
      source: 'src/SpanOnly.sol:10-20',
    });
    const service = serviceFor({
      ...base.input,
      contracts: [...base.input.contracts!, spanContract],
      relationships: [relationship],
    });

    expect(service.getProvenance(relationship.id)).toEqual([
      'src/Other.sol:1-9',
      'src/Vault.sol:40-52',
    ]);
    expect(service.getProvenance(spanContract.id)).toEqual(['src/SpanOnly.sol:10-20']);
    expect(catchCode(() => service.getProvenance('contract:nope'))).toBe('EntityNotFound');
  });

  it('getRun prefers the current run, falls back to the lexicographically greatest run id, and returns undefined without derivations', () => {
    const base = buildBase();
    const hash = currentHash(base.input);
    const currentRun = runFixture('run:current', {
      output_identity: { output_hash: hash, serialization: 'recon-state-json/v1' },
    });
    const historicRun = runFixture('run:historic');

    const multi = serviceFor({
      ...base.input,
      traceability: {
        runs: [historicRun, currentRun],
        derivations: [
          derivation('derivation:historic', 'run:historic', {
            outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
          }),
          derivation('derivation:current', 'run:current', { outputs: materialRefs(base.ids) }),
        ],
        outputs: outputRecords('run:current', base.ids),
      },
    });
    expect(multi.getRun(base.ids.relationship)?.id).toBe('run:current');
    expect(multi.getRun(base.ids.contract)?.id).toBe('run:current');

    const single = serviceFor({
      ...base.input,
      traceability: {
        runs: [currentRun],
        derivations: [derivation('derivation:current', 'run:current', { outputs: materialRefs(base.ids) })],
        outputs: outputRecords('run:current', base.ids),
      },
    });
    expect(single.getRun(base.ids.relationship)?.id).toBe('run:current');

    const fallback = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture('run:a'), runFixture('run:b')],
        derivations: [
          derivation('derivation:a', 'run:a', {
            outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
          }),
          derivation('derivation:b', 'run:b', {
            outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
          }),
        ],
        outputs: [],
      },
    });
    expect(fallback.getRun(base.ids.relationship)?.id).toBe('run:b');

    const none = serviceFor(base.input);
    expect(none.getRun(base.ids.relationship)).toBeUndefined();
  });

  it('backward trace reaches source, provenance, source identity, and run', () => {
    const base = buildBase();
    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture('run:lineage')],
        derivations: [
          derivation('derivation:rel-lineage', 'run:lineage', {
            outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
          }),
        ],
        outputs: [],
      },
    });

    const result = service.traceBackward(base.ids.relationship);
    expect(result).toEqual({
      root: base.ids.relationship,
      direction: 'backward',
      status: 'COMPLETE',
      truncated: false,
      nodes: [
        { kind: 'entity', id: base.ids.relationship, depth: 0 },
        { kind: 'derivation', id: 'derivation:rel-lineage', depth: 1 },
        { kind: 'source_file', id: 'src/Vault.sol', depth: 2 },
        { kind: 'provenance_span', id: 'src/Vault.sol:40-52', depth: 2 },
        { kind: 'source_identity', id: '1'.repeat(64), depth: 3 },
        { kind: 'run', id: 'run:lineage', depth: 4 },
      ],
    });
    expect(catchCode(() => service.traceBackward('contract:nope'))).toBe('EntityNotFound');
  });

  it('forward trace returns material outputs from a source file', () => {
    const base = buildBase();
    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture('run:forward')],
        derivations: [
          derivation('derivation:forward', 'run:forward', {
            outputs: [
              { entity_type: 'fact', entity_id: base.ids.fact },
              { entity_type: 'relationship', entity_id: base.ids.relationship },
            ],
          }),
        ],
        outputs: [],
      },
    });

    const result = service.traceForward({ entity_type: 'source_file', entity_id: 'src/Vault.sol' });
    expect(result).toEqual({
      root: 'src/Vault.sol',
      direction: 'forward',
      status: 'NOT_APPLICABLE',
      truncated: false,
      nodes: [
        { kind: 'source_file', id: 'src/Vault.sol', depth: 0 },
        { kind: 'derivation', id: 'derivation:forward', depth: 1 },
        { kind: 'entity', id: base.ids.fact, depth: 2 },
        { kind: 'entity', id: base.ids.relationship, depth: 2 },
      ],
    });
    expect(catchCode(() => service.traceForward({ entity_type: 'source_file', entity_id: 'src/Nope.sol' }))).toBe(
      'EntityNotFound',
    );
  });

  it('traversal is cycle safe and truncates an 8-link chain at the default depth', () => {
    expect(DEFAULT_TRACE_DEPTH).toBe(5);

    const contractA = createContract({ name: 'CycleA', contract_type: 'core' });
    const contractB = createContract({ name: 'CycleB', contract_type: 'core' });
    const cycle = serviceFor({
      contracts: [contractA, contractB],
      traceability: {
        runs: [runFixture('run:cycle')],
        derivations: [
          derivation('derivation:cycle-ab', 'run:cycle', {
            outputs: [{ entity_type: 'contract', entity_id: contractA.id }],
            inputs: [{ entity_type: 'contract', entity_id: contractB.id }],
            provenance: [],
          }),
          derivation('derivation:cycle-ba', 'run:cycle', {
            outputs: [{ entity_type: 'contract', entity_id: contractB.id }],
            inputs: [{ entity_type: 'contract', entity_id: contractA.id }],
            provenance: [],
          }),
        ],
        outputs: [],
      },
    });

    const backward = cycle.traceBackward(contractA.id);
    expect(backward.nodes.map((node) => node.id)).toEqual([
      contractA.id,
      'derivation:cycle-ab',
      contractB.id,
      'derivation:cycle-ba',
    ]);
    expect(backward.truncated).toBe(false);

    const forward = cycle.traceForward({ entity_type: 'contract', entity_id: contractA.id });
    expect(forward.nodes.map((node) => node.id)).toEqual([
      contractA.id,
      'derivation:cycle-ba',
      contractB.id,
      'derivation:cycle-ab',
    ]);
    expect(forward.truncated).toBe(false);

    const contracts = Array.from({ length: 9 }, (_unused, index) =>
      createContract({ name: `Chain${index}`, contract_type: 'core' }),
    );
    const chainDerivations: Derivation[] = [];
    for (let link = 1; link <= 8; link += 1) {
      chainDerivations.push(
        derivation(`derivation:chain-${link}`, 'run:chain', {
          inputs: [{ entity_type: 'contract', entity_id: contracts[link]!.id }],
          outputs: [{ entity_type: 'contract', entity_id: contracts[link - 1]!.id }],
          provenance: [],
        }),
      );
    }
    const chain = serviceFor({
      contracts,
      traceability: {
        runs: [runFixture('run:chain')],
        derivations: chainDerivations,
        outputs: [],
      },
    });

    const result = chain.traceBackward(contracts[0]!.id);
    expect(result.truncated).toBe(true);
    expect(result.nodes).toEqual([
      { kind: 'entity', id: contracts[0]!.id, depth: 0 },
      { kind: 'derivation', id: 'derivation:chain-1', depth: 1 },
      { kind: 'entity', id: contracts[1]!.id, depth: 2 },
      { kind: 'derivation', id: 'derivation:chain-2', depth: 3 },
      { kind: 'entity', id: contracts[2]!.id, depth: 4 },
      { kind: 'derivation', id: 'derivation:chain-3', depth: 5 },
    ]);
  });

  it('direction both merges backward and forward nodes', () => {
    const base = buildBase();
    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture('run:both')],
        derivations: [
          derivation('derivation:both-out', 'run:both', {
            outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
          }),
          derivation('derivation:both-in', 'run:both', {
            inputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
            outputs: [{ entity_type: 'fact', entity_id: base.ids.fact }],
            provenance: [],
          }),
        ],
        outputs: [],
      },
    });

    const result = service.trace(base.ids.relationship, { direction: 'both' });
    expect(result).toEqual({
      root: base.ids.relationship,
      direction: 'both',
      status: 'COMPLETE',
      truncated: false,
      nodes: [
        { kind: 'entity', id: base.ids.relationship, depth: 0 },
        { kind: 'derivation', id: 'derivation:both-out', depth: 1 },
        { kind: 'source_file', id: 'src/Vault.sol', depth: 2 },
        { kind: 'provenance_span', id: 'src/Vault.sol:40-52', depth: 2 },
        { kind: 'source_identity', id: '1'.repeat(64), depth: 3 },
        { kind: 'run', id: 'run:both', depth: 4 },
        { kind: 'derivation', id: 'derivation:both-in', depth: 1 },
        { kind: 'entity', id: base.ids.fact, depth: 2 },
      ],
    });
  });

  it('getTraceStatus makes missing lineage explicit', () => {
    const missing = createContract({ name: 'MissingLine', contract_type: 'core' });
    const partial = createContract({
      name: 'PartialLine',
      contract_type: 'core',
      source: 'src/Part.sol:1-9',
    });
    const complete = createContract({
      name: 'FullLine',
      contract_type: 'core',
      source: 'src/Full.sol:1-9',
    });
    const observation = createObservation({
      statement: 'phase 2 does not emit observations',
      provenance: [SRC],
    });
    const service = serviceFor({
      contracts: [missing, partial, complete],
      observations: [observation],
      traceability: {
        runs: [runFixture('run:status')],
        derivations: [
          derivation('derivation:status', 'run:status', {
            inputs: [{ entity_type: 'source_file', entity_id: 'src/Full.sol' }],
            outputs: [{ entity_type: 'contract', entity_id: complete.id }],
            provenance: ['src/Full.sol:1-9'],
          }),
        ],
        outputs: [],
      },
    });

    expect(service.getTraceStatus(missing.id)).toBe('MISSING');
    expect(service.getTraceStatus(partial.id)).toBe('PARTIAL');
    expect(service.getTraceStatus(complete.id)).toBe('COMPLETE');
    expect(service.getTraceStatus(observation.id)).toBe('NOT_APPLICABLE');
    expect(catchCode(() => service.getTraceStatus('contract:nope'))).toBe('EntityNotFound');
    expect(service.findIncompleteTraces()).toEqual([
      { entity_type: 'contract', entity_id: missing.id, status: 'MISSING' },
      { entity_type: 'contract', entity_id: partial.id, status: 'PARTIAL' },
    ]);
  });

  it('findByDerivation and findRunsBySourceIdentity filter exactly', () => {
    const service = serviceFor({
      traceability: {
        runs: [
          runFixture('run:a', {
            source_identity: { source_hash: 'a'.repeat(64), manifest_hash: '2'.repeat(64) },
          }),
          runFixture('run:b', {
            source_identity: { source_hash: 'a'.repeat(64), manifest_hash: '2'.repeat(64) },
          }),
          runFixture('run:c', {
            source_identity: { source_hash: 'b'.repeat(64), manifest_hash: '2'.repeat(64) },
          }),
        ],
        derivations: [
          derivation('derivation:01', 'run:a', {
            operation: 'extract.contracts',
            operation_version: '0.1.0',
          }),
          derivation('derivation:02', 'run:b', {
            operation: 'extract.functions',
            operation_version: '0.1.0',
          }),
          derivation('derivation:03', 'run:a', {
            operation: 'extract.contracts',
            operation_version: '0.2.0',
          }),
        ],
        outputs: [],
      },
    });

    expect(service.findByDerivation('extract.contracts', '0.1.0').map((item) => item.id)).toEqual([
      'derivation:01',
    ]);
    expect(service.findByDerivation('extract.contracts', '0.2.0').map((item) => item.id)).toEqual([
      'derivation:03',
    ]);
    expect(service.findByDerivation('extract.contracts', '0.9.9')).toEqual([]);
    expect(service.findByDerivation('extract.missing', '0.1.0')).toEqual([]);
    expect(service.findRunsBySourceIdentity('a'.repeat(64)).map((run) => run.id)).toEqual([
      'run:a',
      'run:b',
    ]);
    expect(service.findRunsBySourceIdentity('b'.repeat(64)).map((run) => run.id)).toEqual(['run:c']);
    expect(service.findRunsBySourceIdentity('c'.repeat(64))).toEqual([]);
  });

  it('getOutputs lists run output records as references', () => {
    const base = buildBase();
    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture('run:a'), runFixture('run:b')],
        derivations: [],
        outputs: [
          { run_id: 'run:b', entity_type: 'function', entity_id: base.ids.fn, content_hash: 'cc' },
          { run_id: 'run:a', entity_type: 'fact', entity_id: base.ids.fact, content_hash: 'aa' },
          {
            run_id: 'run:a',
            entity_type: 'contract',
            entity_id: base.ids.contract,
            content_hash: 'bb',
          },
        ],
      },
    });

    expect(service.getOutputs('run:a')).toEqual([
      { entity_type: 'contract', entity_id: base.ids.contract },
      { entity_type: 'fact', entity_id: base.ids.fact },
    ]);
    expect(service.getOutputs('run:b')).toEqual([
      { entity_type: 'function', entity_id: base.ids.fn },
    ]);
    expect(service.getOutputs('run:absent')).toEqual([]);
  });

  it('getDerivations matches inputs or outputs', () => {
    const base = buildBase();
    const service = serviceFor({
      ...base.input,
      traceability: {
        runs: [runFixture('run:deriv')],
        derivations: [
          derivation('derivation:out', 'run:deriv', {
            inputs: [],
            outputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
          }),
          derivation('derivation:in', 'run:deriv', {
            inputs: [{ entity_type: 'relationship', entity_id: base.ids.relationship }],
            provenance: [],
          }),
          derivation('derivation:file', 'run:deriv', {
            inputs: [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }],
            provenance: [],
          }),
        ],
        outputs: [],
      },
    });

    expect(service.getDerivations(base.ids.relationship).map((item) => item.id)).toEqual([
      'derivation:in',
      'derivation:out',
    ]);
    expect(service.getDerivations('src/Vault.sol').map((item) => item.id)).toEqual([
      'derivation:file',
    ]);
    expect(service.getDerivations('contract:absent')).toEqual([]);
  });
});

describe('TraceabilityService over a real analyzeProject state', () => {
  it('vault pipeline state answers service queries end to end', async () => {
    const result = await analyzeProject(
      parseReconConfig({
        root: VAULT_ROOT,
        recordGit: false,
        timestamp: '2026-01-01T00:00:00.000Z',
        projectName: 'service-trace',
      }),
    );
    const state = result.state;
    const traceability = state.traceability!;
    const runId = traceability.runs[0]!.id;
    const service = createTraceabilityService(state);

    expect(service.getRunById(runId)?.id).toBe(runId);
    expect(service.getRunById('run:absent')).toBeUndefined();

    const relationship = state.relationships[0]!;
    expect(service.getTraceStatus(relationship.id)).toBe('COMPLETE');
    expect(service.getRun(relationship.id)?.id).toBe(runId);
    expect(service.getProvenance(relationship.id).length).toBeGreaterThan(0);
    expect(service.getDerivations(relationship.id).length).toBeGreaterThan(0);

    const backward = service.traceBackward(relationship.id);
    expect(backward.status).toBe('COMPLETE');
    expect(backward.truncated).toBe(false);
    expect(new Set(backward.nodes.map((node) => node.kind))).toEqual(
      new Set(['entity', 'derivation', 'source_file', 'provenance_span', 'source_identity', 'run']),
    );
    expect(backward.nodes.find((node) => node.kind === 'run')?.id).toBe(runId);

    const sourceRef = traceability.derivations[0]!.inputs[0]!;
    const forward = service.traceForward(sourceRef);
    expect(forward.nodes.length).toBeGreaterThan(1);
    expect(forward.truncated).toBe(false);

    expect(service.findIncompleteTraces()).toEqual([]);
    expect(service.findOrphanedTraceReferences()).toEqual([]);

    const materialCount =
      state.contracts.length +
      state.functions.length +
      state.state_variables.length +
      state.relationships.length +
      state.facts.length;
    expect(service.getOutputs(runId)).toHaveLength(materialCount);
    expect(
      service
        .findRunsBySourceIdentity(traceability.runs[0]!.source_identity.source_hash)
        .map((run) => run.id),
    ).toEqual([runId]);
  });
});
