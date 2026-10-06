import { describe, expect, it } from 'vitest';
import {
  createReconState,
  deserializeReconState,
  serializeReconState,
} from '../src/recon-state/state.js';
import type { ReconStateInput } from '../src/recon-state/schema.js';
import { createProject } from '../src/domain/project.js';
import { createContract } from '../src/domain/contract.js';
import { createFunction } from '../src/domain/function.js';
import { createStateVariable } from '../src/domain/state-variable.js';
import { createRelationship } from '../src/relationships/relationship.js';
import { createFact } from '../src/epistemic/fact.js';
import { createObservation } from '../src/epistemic/observation.js';
import { createAssumption } from '../src/epistemic/assumption.js';
import { createHypothesis } from '../src/epistemic/hypothesis.js';
import { createEvidence } from '../src/epistemic/evidence.js';
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
  const observation = createObservation({
    statement: 'deposit writes totalShares',
    based_on: [fact.id],
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

describe('ReconState', () => {
  it('creates a minimal empty state with every collection', () => {
    const state = createReconState({});
    expect(state.schema_version).toBe('recon-state/v1');
    expect(state.project).toBeUndefined();
    expect(state.contracts).toEqual([]);
    expect(state.functions).toEqual([]);
    expect(state.state_variables).toEqual([]);
    expect(state.assets).toEqual([]);
    expect(state.roles).toEqual([]);
    expect(state.dependencies).toEqual([]);
    expect(state.relationships).toEqual([]);
    expect(state.facts).toEqual([]);
    expect(state.observations).toEqual([]);
    expect(state.assumptions).toEqual([]);
    expect(state.hypotheses).toEqual([]);
    expect(state.evidence).toEqual([]);
    expect(state.provenance).toEqual([]);
  });

  it('rejects an unsupported schema version', () => {
    expectReconCode(
      () => createReconState({ schema_version: 'recon-state/v2' }),
      'UnsupportedSchemaVersion',
    );
  });

  it('rejects unknown top-level fields', () => {
    expectReconCode(
      () => createReconState({ schema_version: 'recon-state/v1', surprise: 1 } as unknown as ReconStateInput),
      'SchemaValidationFailed',
    );
  });

  it('accepts a populated state and derives the provenance registry', () => {
    const state = createReconState(baseFixture());
    const embedded = new Set<string>();
    for (const record of [
      ...state.relationships,
      ...state.facts,
      ...state.observations,
      ...state.evidence,
    ]) {
      for (const provenance of record.provenance) embedded.add(provenance.id);
    }
    const registry = new Set(state.provenance.map((record) => record.id));
    expect(registry).toEqual(embedded);
    expect(state.provenance.length).toBeGreaterThan(0);
  });

  it('rejects a relationship pointing at a missing entity', () => {
    const base = baseFixture();
    expectReconCode(
      () => createReconState({ ...base, state_variables: [] }),
      'InvalidReconState',
    );
  });

  it('rejects duplicate canonical contracts with different content', () => {
    const base = baseFixture();
    const contract = base.contracts?.[0];
    if (contract === undefined) throw new Error('fixture missing contract');
    expectReconCode(
      () =>
        createReconState({
          ...base,
          contracts: [contract, { ...contract, name: 'VaultRenamed' }],
        }),
      'DuplicateCanonicalEntity',
    );
  });

  it('rejects an identical duplicated entity', () => {
    const base = baseFixture();
    const contract = base.contracts?.[0];
    if (contract === undefined) throw new Error('fixture missing contract');
    expectReconCode(
      () => createReconState({ ...base, contracts: [contract, contract] }),
      'DuplicateCanonicalEntity',
    );
  });

  it('rejects normalization-aliased source contracts that collide on a case-folded name', () => {
    const base = baseFixture();
    const upper = createContract({ name: 'Guard', source_file: 'src/Collide.sol', contract_type: 'vault' });
    const lower = createContract({ name: 'guard', source_file: 'src/Collide.sol', contract_type: 'vault' });
    expect(lower.id).toBe(upper.id);
    expectReconCode(
      () => createReconState({ ...base, contracts: [...(base.contracts ?? []), upper, lower] }),
      'DuplicateCanonicalEntity',
    );
  });

  it('rejects a duplicated content-addressed entry in any collection', () => {
    const base = baseFixture();
    const dupEntry = <K extends keyof ReconStateInput>(
      key: K,
      items: readonly { id: string }[],
    ): ReconStateInput => {
      if (items.length === 0) throw new Error(`fixture missing ${String(key)}`);
      return { ...base, [key]: [...items, items[0]] } as ReconStateInput;
    };
    expectReconCode(
      () => createReconState(dupEntry('relationships', base.relationships ?? [])),
      'DuplicateCanonicalEntity',
    );
    expectReconCode(
      () => createReconState(dupEntry('facts', base.facts ?? [])),
      'DuplicateCanonicalEntity',
    );
    expectReconCode(
      () => createReconState(dupEntry('observations', base.observations ?? [])),
      'DuplicateCanonicalEntity',
    );
    expectReconCode(
      () => createReconState(dupEntry('assumptions', base.assumptions ?? [])),
      'DuplicateCanonicalEntity',
    );
    expectReconCode(
      () => createReconState(dupEntry('hypotheses', base.hypotheses ?? [])),
      'DuplicateCanonicalEntity',
    );
    expectReconCode(
      () => createReconState(dupEntry('evidence', base.evidence ?? [])),
      'DuplicateCanonicalEntity',
    );
  });

  it('rejects an observation whose basis fact is missing', () => {
    const base = baseFixture();
    expectReconCode(
      () => createReconState({ ...base, facts: [] }),
      'InvalidReconState',
    );
  });

  it('rejects a hypothesis whose basis assumption is missing', () => {
    const base = baseFixture();
    expectReconCode(
      () => createReconState({ ...base, assumptions: [] }),
      'InvalidReconState',
    );
  });

  it('rejects evidence supporting a missing hypothesis', () => {
    const base = baseFixture();
    expectReconCode(
      () => createReconState({ ...base, hypotheses: [] }),
      'InvalidReconState',
    );
  });

  it('rejects a fact referencing a missing entity', () => {
    const base = baseFixture();
    expectReconCode(
      () => createReconState({ ...base, state_variables: [], relationships: [] }),
      'InvalidReconState',
    );
  });

  it('rejects a fact whose content was tampered after creation', () => {
    const base = baseFixture();
    const fact = base.facts?.[0];
    if (fact === undefined) throw new Error('fixture missing fact');
    expectReconCode(
      () =>
        createReconState({
          ...base,
          facts: [{ ...fact, predicate: 'READS' }],
        }),
      'InvalidReconState',
    );
  });

  it('rejects a confidence level that contradicts the epistemic type', () => {
    const base = baseFixture();
    const fact = base.facts?.[0];
    if (fact === undefined) throw new Error('fixture missing fact');
    expectReconCode(
      () =>
        createReconState({
          ...base,
          facts: [{ ...fact, confidence: { level: 'INFERRED' } }],
        }),
      'InvalidConfidence',
    );
  });

  it('rejects a relationship with an unknown type', () => {
    const base = baseFixture();
    const relationship = base.relationships?.[0];
    if (relationship === undefined) throw new Error('fixture missing relationship');
    expectReconCode(
      () =>
        createReconState({
          ...base,
          relationships: [{ ...relationship, type: 'TELEPORTS' }],
        }),
      'UnsupportedRelationshipType',
    );
  });

  it('rejects an entity whose id does not match its identity fields', () => {
    const base = baseFixture();
    const contract = base.contracts?.[0];
    if (contract === undefined) throw new Error('fixture missing contract');
    expectReconCode(
      () =>
        createReconState({
          ...base,
          contracts: [
            { ...contract, id: 'contract:ethereum:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
          ],
        }),
      'InvalidReconState',
    );
  });

  it('rejects a provenance registry that omits an embedded record', () => {
    const base = baseFixture();
    expectReconCode(
      () => createReconState({ ...base, provenance: [] }),
      'InvalidReconState',
    );
  });
});

describe('ReconState serialization', () => {
  it('serializes deterministically regardless of array order', () => {
    const base = baseFixture();
    const extraFact = createFact({
      subject_id: base.functions?.[0]?.id ?? 'function:missing',
      predicate: 'READS',
      object_id: base.state_variables?.[0]?.id ?? 'state:missing',
      provenance: [SRC],
      created_at: FIXED_TS,
    });
    const first = serializeReconState(
      createReconState({ ...base, facts: [...(base.facts ?? []), extraFact] }),
    );
    const second = serializeReconState(
      createReconState({ ...base, facts: [extraFact, ...(base.facts ?? [])] }),
    );
    expect(first).toBe(second);
  });

  it('emits pretty-printed JSON with schema_version first', () => {
    const json = serializeReconState(createReconState(baseFixture()));
    expect(json.startsWith('{\n  "schema_version": "recon-state/v1"')).toBe(true);
  });

  it('round-trips through serialize and deserialize', () => {
    const state = createReconState(baseFixture());
    const json = serializeReconState(state);
    const restored = deserializeReconState(json);
    expect(serializeReconState(restored)).toBe(json);
  });

  it('preserves creation timestamps through a round-trip', () => {
    const state = createReconState(baseFixture());
    const restored = deserializeReconState(serializeReconState(state));
    const originalFact = state.facts[0];
    const restoredFact = restored.facts.find((fact) => fact.id === originalFact?.id);
    expect(restoredFact?.created_at).toBe(FIXED_TS);
  });

  it('round-trips an empty state', () => {
    const json = serializeReconState(createReconState({}));
    expect(deserializeReconState(json)).toEqual(createReconState({}));
    expect(serializeReconState(deserializeReconState(json))).toBe(json);
  });

  it('rejects malformed JSON', () => {
    expectReconCode(() => deserializeReconState('{not json'), 'InvalidReconState');
  });

  it('rejects JSON that is not an object', () => {
    expectReconCode(() => deserializeReconState('[1, 2]'), 'SchemaValidationFailed');
  });

  it('orders serialized collections by code-unit, not by locale collation', () => {
    const base = baseFixture();
    const fixtureContractId = base.contracts?.[0]?.id;
    if (fixtureContractId === undefined) throw new Error('fixture missing contract');
    const zebra = createStateVariable({
      contract_id: fixtureContractId,
      name: 'Zebra',
      type: 'uint256',
      visibility: 'public',
    });
    const alpha = createStateVariable({
      contract_id: fixtureContractId,
      name: 'alpha',
      type: 'uint256',
      visibility: 'public',
    });
    const json = serializeReconState(
      createReconState({
        ...base,
        state_variables: [...(base.state_variables ?? []), zebra, alpha],
      }),
    );
    const zebraIndex = json.indexOf(zebra.id);
    const alphaIndex = json.indexOf(alpha.id);
    expect(zebraIndex).toBeGreaterThan(-1);
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(zebraIndex).toBeLessThan(alphaIndex);
  });
});
