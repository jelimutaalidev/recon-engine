import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, StateVisibility, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../../src/domain/state-variable.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { stableStringify } from '../../../src/util/canonical.js';
import {
  deriveAccesses,
  StateAccessSchema,
  type StateAccess,
} from '../../../src/semantic/esm/access.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const stateVariables: StateVariable[] = [];
  const relationships: Relationship[] = [];

  return {
    contract(name: string): Contract {
      const record = createContract({ name, contract_type: 'core' });
      contracts.push(record);
      return record;
    },
    fn(contract: Contract, name: string): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: 'external' as Visibility,
        mutability: 'nonpayable' as Mutability,
        modifiers: [],
      });
      functions.push(record);
      return record;
    },
    stateVar(
      contract: Contract,
      name: string,
      options: { type?: string; slot?: string } = {},
    ): StateVariable {
      const record = createStateVariable({
        contract_id: contract.id,
        name,
        type: options.type ?? 'uint256',
        visibility: 'public' as StateVisibility,
        ...(options.slot !== undefined ? { slot: options.slot } : {}),
      });
      stateVariables.push(record);
      return record;
    },
    rel(
      type: Relationship['type'],
      sourceId: string,
      targetId: string,
      provenance: ProvenanceInput[],
    ): Relationship {
      const record = createRelationship({
        type,
        source_id: sourceId,
        target_id: targetId,
        provenance,
        created_at: CREATED_AT,
      });
      relationships.push(record);
      return record;
    },
    looseRel(
      type: Relationship['type'],
      sourceId: string,
      targetId: string,
      provenance: ProvenanceInput[],
    ): Relationship {
      return createRelationship({
        type,
        source_id: sourceId,
        target_id: targetId,
        provenance,
        created_at: CREATED_AT,
      });
    },
    buildIndex(): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: stateVariables,
        relationships,
        facts: [],
      });
      return buildEvidenceIndex({
        state,
        issues: [],
        meta: { fidelity: 'semantic', fileCount: 1 },
      });
    },
  };
}

describe('deriveAccesses', () => {
  it('resolved READS yields an access with the exact variable id and the edge basis', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'deposit');
    const variable = s.stateVar(contract, 'totalAssets');
    const edge = s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 10)]);
    const { accesses, unknowns } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(1);
    const access = accesses[0]!;
    expect(access).toEqual({
      id: access.id,
      location: variable.id,
      op: 'read',
      span: { file: 'src/Vault.sol', line_start: 10, line_end: 10 },
      subPath: 'unknown',
      scope: contract.id,
      basis: [edge.id, variable.id].sort(),
    });
    expect(access.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect('slot' in access).toBe(false);
    expect(unknowns).toEqual([]);
  });

  it('unresolved access yields location unknown plus one unknown entry', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'withdraw');
    const edge = s.looseRel('READS', fn.id, 'state:Vault:missing', [span('src/Vault.sol', 20)]);
    const index = s.buildIndex();
    index.relationshipsById.set(edge.id, edge);
    const { accesses, unknowns } = deriveAccesses(index);

    expect(accesses).toHaveLength(1);
    const access = accesses[0]!;
    expect(access.location).toBe('unknown');
    expect(access.op).toBe('read');
    expect(access.scope).toBe(contract.id);
    expect(access.basis).toEqual([edge.id]);
    expect(access.subPath).toBe('unknown');

    expect(unknowns).toHaveLength(1);
    const unknown = unknowns[0]!;
    expect(unknown.scope).toBe('state-access-location');
    expect(unknown.reason).toBe('location-unidentified');
    expect(unknown.basis).toEqual([edge.id]);
    expect(unknown.id).toMatch(/^seme:[0-9a-f]{16}$/);
  });

  it('mapping-typed variables stay variable-granular with subPath unknown', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'transfer');
    const balances = s.stateVar(contract, 'balances', { type: 'mapping(address => uint256)' });
    s.rel('WRITES', fn.id, balances.id, [span('src/Vault.sol', 30)]);
    const { accesses, unknowns } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(1);
    expect(accesses[0]!.location).toBe(balances.id);
    expect(accesses[0]!.op).toBe('write');
    expect(accesses[0]!.subPath).toBe('unknown');
    expect(unknowns).toEqual([]);
  });

  it('two different variables produce no alias or disjointness claim', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'move');
    const first = s.stateVar(contract, 'balances', { type: 'mapping(address => uint256)' });
    const second = s.stateVar(contract, 'allowances', {
      type: 'mapping(address => mapping(address => uint256))',
    });
    s.rel('READS', fn.id, first.id, [span('src/Vault.sol', 40)]);
    s.rel('READS', fn.id, second.id, [span('src/Vault.sol', 41)]);
    const result = deriveAccesses(s.buildIndex());

    expect(result.accesses).toHaveLength(2);
    expect(result.accesses.map((access) => access.location).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    const serialized = stableStringify(result);
    expect(serialized).not.toContain('alias');
    expect(serialized).not.toContain('disjoint');
    expect(serialized).not.toContain('alias-possible');
  });

  it('paired read and write at one span merge into a single readwrite access', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'update');
    const variable = s.stateVar(contract, 'totalAssets');
    const reads = s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 50)]);
    const writes = s.rel('WRITES', fn.id, variable.id, [span('src/Vault.sol', 50)]);
    const { accesses, unknowns } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(1);
    const access = accesses[0]!;
    expect(access.op).toBe('readwrite');
    expect(access.location).toBe(variable.id);
    expect(access.basis).toEqual([reads.id, variable.id, writes.id].sort());
    expect(unknowns).toEqual([]);
  });

  it('read and write at different spans stay separate accesses', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'update');
    const variable = s.stateVar(contract, 'totalAssets');
    s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 50)]);
    s.rel('WRITES', fn.id, variable.id, [span('src/Vault.sol', 60)]);
    const { accesses } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(2);
    expect(accesses.map((access) => access.op).sort()).toEqual(['read', 'write']);
  });

  it('copies the slot verbatim when present and omits it otherwise', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'read');
    const packed = s.stateVar(contract, 'packed', { slot: '0x05' });
    const plain = s.stateVar(contract, 'plain');
    s.rel('READS', fn.id, packed.id, [span('src/Vault.sol', 70)]);
    s.rel('READS', fn.id, plain.id, [span('src/Vault.sol', 71)]);
    const { accesses } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(2);
    const withSlot = accesses.find((access) => access.location === packed.id)!;
    const withoutSlot = accesses.find((access) => access.location === plain.id)!;
    expect(withSlot.slot).toBe('0x05');
    expect('slot' in withoutSlot).toBe(false);
  });

  it('ignores non-storage relationships', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'deposit');
    const helper = s.fn(contract, 'helper');
    const variable = s.stateVar(contract, 'totalAssets');
    s.rel('CALLS', fn.id, helper.id, [span('src/Vault.sol', 5)]);
    s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 10)]);
    const { accesses } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(1);
    expect(accesses[0]!.location).toBe(variable.id);
  });

  it('is deterministic across runs and relationship insertion order', () => {
    const build = (): { accesses: StateAccess[]; unknowns: unknown[] } => {
      const s = miniState();
      const contract = s.contract('Vault');
      const fn = s.fn(contract, 'update');
      const variable = s.stateVar(contract, 'totalAssets');
      s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 50)]);
      s.rel('WRITES', fn.id, variable.id, [span('src/Vault.sol', 60)]);
      return deriveAccesses(s.buildIndex());
    };
    const forward = build();
    const repeat = build();
    expect(stableStringify(repeat)).toBe(stableStringify(forward));

    const swapped = ((): { accesses: StateAccess[]; unknowns: unknown[] } => {
      const s = miniState();
      const contract = s.contract('Vault');
      const fn = s.fn(contract, 'update');
      const variable = s.stateVar(contract, 'totalAssets');
      s.rel('WRITES', fn.id, variable.id, [span('src/Vault.sol', 60)]);
      s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 50)]);
      return deriveAccesses(s.buildIndex());
    })();
    expect(stableStringify(swapped)).toBe(stableStringify(forward));
  });

  it('sorts accesses by id in code-unit order', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'update');
    const zeta = s.stateVar(contract, 'zeta');
    const alpha = s.stateVar(contract, 'alpha');
    s.rel('READS', fn.id, zeta.id, [span('src/Vault.sol', 12)]);
    s.rel('READS', fn.id, alpha.id, [span('src/Vault.sol', 11)]);
    const { accesses } = deriveAccesses(s.buildIndex());

    expect(accesses).toHaveLength(2);
    const ids = accesses.map((access) => access.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('StateAccessSchema rejects excess keys', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    const fn = s.fn(contract, 'deposit');
    const variable = s.stateVar(contract, 'totalAssets');
    s.rel('READS', fn.id, variable.id, [span('src/Vault.sol', 10)]);
    const { accesses } = deriveAccesses(s.buildIndex());
    const access = accesses[0]!;

    expect(StateAccessSchema.safeParse(access).success).toBe(true);
    expect(
      StateAccessSchema.safeParse({ ...access, disjointFrom: [] }).success,
    ).toBe(false);
  });

  it('empty relationship input yields empty output', () => {
    const s = miniState();
    const contract = s.contract('Vault');
    s.fn(contract, 'deposit');
    s.stateVar(contract, 'totalAssets');
    expect(deriveAccesses(s.buildIndex())).toEqual({ accesses: [], unknowns: [] });
  });

  it('unresolved access without a known source function scopes to unknown', () => {
    const s = miniState();
    const edge = s.looseRel('READS', 'function:Gone:missing()', 'state:Gone:missing', [
      span('src/Gone.sol', 3),
    ]);
    const index = s.buildIndex();
    index.relationshipsById.set(edge.id, edge);
    const { accesses, unknowns } = deriveAccesses(index);

    expect(accesses).toHaveLength(1);
    expect(accesses[0]!.location).toBe('unknown');
    expect(accesses[0]!.scope).toBe('unknown');
    expect(accesses[0]!.basis).toEqual([edge.id]);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.basis).toEqual([edge.id]);
  });
});
