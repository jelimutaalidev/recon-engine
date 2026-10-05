import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createReconState, serializeReconState } from '../../src/recon-state/state.js';
import type { ReconStateInput } from '../../src/recon-state/schema.js';
import { createContract } from '../../src/domain/contract.js';
import { createFunction } from '../../src/domain/function.js';
import { createStateVariable } from '../../src/domain/state-variable.js';
import { createRelationship } from '../../src/relationships/relationship.js';
import { createFact } from '../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import { isReconError, type ReconErrorDetails } from '../../src/errors/errors.js';
import type {
  Derivation,
  ReconRun,
  RunOutputRecord,
  TraceReference,
  TraceabilityState,
} from '../../src/traceability/types.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';
const RUN_ID = 'run:0123456789abcdef';
const LEGACY_OUTPUT_HASH = '0'.repeat(64);

const SERIALIZED_OUTPUTS_SNAPSHOT = `{
  "schema_version": "recon-state/v1",
  "contracts": [],
  "functions": [],
  "state_variables": [],
  "assets": [],
  "roles": [],
  "dependencies": [],
  "relationships": [],
  "facts": [],
  "observations": [],
  "assumptions": [],
  "hypotheses": [],
  "evidence": [],
  "provenance": [],
  "traceability": {
    "runs": [],
    "derivations": [],
    "outputs": [
      {
        "run_id": "run:a",
        "entity_type": "contract",
        "entity_id": "contract:1",
        "content_hash": "bb"
      },
      {
        "run_id": "run:a",
        "entity_type": "fact",
        "entity_id": "fact:9",
        "content_hash": "aa"
      },
      {
        "run_id": "run:b",
        "entity_type": "function",
        "entity_id": "function:2",
        "content_hash": "cc"
      }
    ]
  }
}`;

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

function runFixture(outputHash: string = LEGACY_OUTPUT_HASH): ReconRun {
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
    id: 'derivation:0123456789abcdef',
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

function outputRecords(runId: string, ids: MaterialIds): RunOutputRecord[] {
  return materialRefs(ids).map((ref) => ({
    run_id: runId,
    entity_type: ref.entity_type,
    entity_id: ref.entity_id,
    content_hash: 'f'.repeat(64),
  }));
}

function currentHash(input: ReconStateInput): string {
  const state = createReconState(input);
  return createHash('sha256')
    .update(serializeReconState(state, { omitTraceability: true }), 'utf8')
    .digest('hex');
}

interface Caught {
  code: string;
  details: ReconErrorDetails;
}

function catchRecon(fn: () => unknown): Caught {
  try {
    fn();
  } catch (error) {
    if (isReconError(error)) return { code: error.code, details: error.details };
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

function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

describe('traceability schema', () => {
  it('accepts state with traceability section', () => {
    const base = buildBase();
    const traceability: TraceabilityState = {
      runs: [runFixture()],
      derivations: [derivationFixture()],
      outputs: [
        {
          run_id: RUN_ID,
          entity_type: 'contract',
          entity_id: base.ids.contract,
          content_hash: '6'.repeat(64),
        },
      ],
    };
    const state = createReconState({ ...base.input, traceability });
    expect(state.traceability).toEqual(traceability);
  });

  it('rejects unknown keys inside traceability', () => {
    const base = buildBase();
    const traceability = {
      runs: [{ ...runFixture(), surprise: 1 }],
      derivations: [],
      outputs: [],
    };
    const { code } = catchRecon(() =>
      createReconState({ ...base.input, traceability } as unknown as ReconStateInput),
    );
    expect(code).toBe('SchemaValidationFailed');
  });

  it('rejects derivation whose run_id does not exist', () => {
    const base = buildBase();
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [runFixture()],
          derivations: [derivationFixture({ run_id: 'run:missing' })],
          outputs: [],
        },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.missing).toEqual(['run:missing']);
  });

  it('allows state without traceability', () => {
    const base = buildBase();
    const state = createReconState(base.input);
    expect(state.traceability).toBeUndefined();
    const expected = JSON.stringify(
      {
        schema_version: state.schema_version,
        project: state.project,
        contracts: [...state.contracts].sort(byId),
        functions: [...state.functions].sort(byId),
        state_variables: [...state.state_variables].sort(byId),
        assets: [...state.assets].sort(byId),
        roles: [...state.roles].sort(byId),
        dependencies: [...state.dependencies].sort(byId),
        relationships: [...state.relationships].sort(byId),
        facts: [...state.facts].sort(byId),
        observations: [...state.observations].sort(byId),
        assumptions: [...state.assumptions].sort(byId),
        hypotheses: [...state.hypotheses].sort(byId),
        evidence: [...state.evidence].sort(byId),
        provenance: [...state.provenance].sort(byId),
      },
      null,
      2,
    );
    const json = serializeReconState(state);
    expect(json).toBe(expected);
    expect(json).not.toContain('traceability');
  });

  it('serialize omits traceability when requested', () => {
    const base = buildBase();
    const state = createReconState({
      ...base.input,
      traceability: { runs: [runFixture()], derivations: [derivationFixture()], outputs: [] },
    });
    const full = serializeReconState(state);
    const omitted = serializeReconState(state, { omitTraceability: true });
    expect(omitted).not.toContain('traceability');
    expect(full).toContain('traceability');
    expect(omitted).toBe(serializeReconState(state, { omitTraceability: true }));
  });

  it('outputs are canonically sorted', () => {
    const outputs: RunOutputRecord[] = [
      { run_id: 'run:b', entity_type: 'function', entity_id: 'function:2', content_hash: 'cc' },
      { run_id: 'run:a', entity_type: 'fact', entity_id: 'fact:9', content_hash: 'aa' },
      { run_id: 'run:a', entity_type: 'contract', entity_id: 'contract:1', content_hash: 'bb' },
    ];
    const first = serializeReconState(
      createReconState({ traceability: { runs: [], derivations: [], outputs: [...outputs] } }),
    );
    const second = serializeReconState(
      createReconState({
        traceability: {
          runs: [],
          derivations: [],
          outputs: [outputs[2]!, outputs[0]!, outputs[1]!],
        },
      }),
    );
    expect(first).toBe(second);
    expect(first).toBe(SERIALIZED_OUTPUTS_SNAPSHOT);
  });
});

describe('traceability validation', () => {
  it('rejects duplicate run ids', () => {
    const base = buildBase();
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: { runs: [runFixture(), runFixture()], derivations: [], outputs: [] },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe('runs');
    expect(issues[0]?.missing).toEqual([RUN_ID]);
  });

  it('rejects duplicate derivation ids', () => {
    const base = buildBase();
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [runFixture()],
          derivations: [derivationFixture(), derivationFixture()],
          outputs: [],
        },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe('derivations');
    expect(issues[0]?.missing).toEqual([derivationFixture().id]);
  });

  it('rejects duplicate output records for the same run and entity', () => {
    const base = buildBase();
    const record: RunOutputRecord = {
      run_id: RUN_ID,
      entity_type: 'contract',
      entity_id: base.ids.contract,
      content_hash: '6'.repeat(64),
    };
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: { runs: [runFixture()], derivations: [], outputs: [record, record] },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe('outputs');
    expect(issues[0]?.missing).toEqual([`${RUN_ID}|contract|${base.ids.contract}`]);
  });

  it('rejects an output record with a non-material entity type', () => {
    const base = buildBase();
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [runFixture()],
          derivations: [],
          outputs: [
            {
              run_id: RUN_ID,
              entity_type: 'source_file',
              entity_id: 'src/Vault.sol',
              content_hash: '6'.repeat(64),
            },
          ],
        },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe(`${RUN_ID}|source_file|src/Vault.sol`);
    expect(issues[0]?.missing).toEqual(['source_file']);
  });

  it('validates a fully covered current run', () => {
    const base = buildBase();
    const hash = currentHash(base.input);
    const run = runFixture(hash);
    const state = createReconState({
      ...base.input,
      traceability: {
        runs: [run],
        derivations: [derivationFixture({ outputs: materialRefs(base.ids) })],
        outputs: outputRecords(RUN_ID, base.ids),
      },
    });
    expect(state.traceability?.runs[0]?.output_identity?.output_hash).toBe(hash);
    expect(state.traceability?.derivations[0]?.outputs).toHaveLength(5);
  });

  it('rejects a current-run derivation output that does not resolve', () => {
    const base = buildBase();
    const run = runFixture(currentHash(base.input));
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [
            derivationFixture({
              outputs: [
                ...materialRefs(base.ids),
                { entity_type: 'contract', entity_id: 'contract:missing' },
              ],
            }),
          ],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe(derivationFixture().id);
    expect(issues[0]?.missing).toEqual(['contract:missing']);
  });

  it('rejects a current-run source input missing from provenance', () => {
    const base = buildBase();
    const run = runFixture(currentHash(base.input));
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [
            derivationFixture({
              inputs: [{ entity_type: 'source_file', entity_id: 'src/Missing.sol' }],
              outputs: materialRefs(base.ids),
            }),
          ],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe(derivationFixture().id);
    expect(issues[0]?.missing).toEqual(['src/Missing.sol']);
  });

  it('rejects a material entity not covered by current-run derivations', () => {
    const base = buildBase();
    const run = runFixture(currentHash(base.input));
    const { code, details } = catchRecon(() =>
      createReconState({
        ...base.input,
        traceability: {
          runs: [run],
          derivations: [
            derivationFixture({
              outputs: materialRefs(base.ids).filter((ref) => ref.entity_type !== 'fact'),
            }),
          ],
          outputs: outputRecords(RUN_ID, base.ids),
        },
      }),
    );
    expect(code).toBe('InvalidReconState');
    const issues = traceIssues(details);
    expect(issues[0]?.check).toBe('traceability');
    expect(issues[0]?.source).toBe(RUN_ID);
    expect(issues[0]?.missing).toEqual([base.ids.fact]);
  });

  it('skips strict checks when no run matches the current hash', () => {
    const base = buildBase();
    const state = createReconState({
      ...base.input,
      traceability: {
        runs: [runFixture()],
        derivations: [
          derivationFixture({
            inputs: [{ entity_type: 'source_file', entity_id: 'src/Missing.sol' }],
            outputs: [{ entity_type: 'contract', entity_id: 'contract:missing' }],
          }),
        ],
        outputs: [],
      },
    });
    expect(state.traceability?.runs[0]?.output_identity?.output_hash).toBe(LEGACY_OUTPUT_HASH);
  });
});
