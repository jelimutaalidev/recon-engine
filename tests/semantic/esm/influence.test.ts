import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../../src/domain/state-variable.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../../src/recon/issues.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { stableStringify } from '../../../src/util/canonical.js';
import { deriveAccesses } from '../../../src/semantic/esm/access.js';
import { deriveConditions } from '../../../src/semantic/esm/conditions.js';
import { deriveBoundaries } from '../../../src/semantic/esm/external.js';
import {
  INFLUENCE_DECLARATION,
  InfluenceEdgeSchema,
  deriveInfluence,
} from '../../../src/semantic/esm/influence.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const stateVariables: StateVariable[] = [];
  const relationships: Relationship[] = [];
  const issues: ReconIssue[] = [];

  return {
    contract(name: string): Contract {
      const record = createContract({ name, contract_type: 'core' });
      contracts.push(record);
      return record;
    },
    fn(
      contract: Contract,
      name: string,
      options?: {
        modifiers?: string[];
        visibility?: Visibility;
        mutability?: Mutability;
        source?: string;
        parameters?: Array<{ type: string }>;
      },
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: options?.visibility ?? ('external' as Visibility),
        mutability: options?.mutability ?? ('nonpayable' as Mutability),
        modifiers: options?.modifiers ?? [],
        ...(options?.source !== undefined ? { source: options.source } : {}),
        ...(options?.parameters !== undefined ? { parameters: options.parameters } : {}),
      });
      functions.push(record);
      return record;
    },
    stateVar(contract: Contract, name: string): StateVariable {
      const record = createStateVariable({
        contract_id: contract.id,
        name,
        type: 'uint256',
        visibility: 'public',
      });
      stateVariables.push(record);
      return record;
    },
    access(
      type: 'READS' | 'WRITES',
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
    calls(sourceId: string, targetId: string, kind: string): Relationship {
      const record = createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        metadata: { call_kind: kind },
        provenance: [span('src/Hub.sol', 5)],
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
    looseCalls(sourceId: string, targetId: string, kind: string): Relationship {
      return createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        metadata: { call_kind: kind },
        provenance: [span('src/Gone.sol', 3)],
        created_at: CREATED_AT,
      });
    },
    builtinIssue(file: string, lineStart: number, lineEnd = lineStart): void {
      issues.push({
        severity: 'UNSUPPORTED',
        code: 'unsupported_builtin',
        message: 'builtin occurrence present',
        file,
        line_start: lineStart,
        line_end: lineEnd,
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
        issues,
        meta: { fidelity: 'semantic', fileCount: 1 },
      });
    },
  };
}

function partsOf(index: EvidenceIndex) {
  return {
    accesses: deriveAccesses(index).accesses,
    conditions: deriveConditions(index).conditions,
    boundaries: deriveBoundaries(index).boundaries,
  };
}

describe('deriveInfluence', () => {
  it('write then read of one location across a call chain yields data-supported with exact evidence', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const writer = s.fn(vault, 'deposit');
    const reader = s.fn(vault, 'withdraw');
    const location = s.stateVar(vault, 'totalAssets');
    const writeEdge = s.access('WRITES', writer.id, location.id, [span('src/Vault.sol', 10)]);
    const readEdge = s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
    const callsEdge = s.calls(writer.id, reader.id, 'internal');
    const index = s.buildIndex();
    const { influence, unknowns } = deriveInfluence(index, partsOf(index));

    const data = influence.filter((edge) => edge.kind === 'data-supported');
    expect(data).toHaveLength(1);
    const edge = data[0]!;
    expect(edge.from).toBe(`state-version:${location.id}@${writer.id}`);
    expect(edge.to).toBe(`state-version:${location.id}@${reader.id}`);
    expect(edge.evidence).toEqual([callsEdge.id, readEdge.id, writeEdge.id].sort());
    expect(edge.basis).toEqual(
      [callsEdge.id, location.id, readEdge.id, reader.id, writeEdge.id, writer.id].sort(),
    );
    expect(edge.eclass).toBe('E2');
    expect(edge.declaration).toBe('capable under stated evidence; materialization UNKNOWN');
    expect(edge.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(InfluenceEdgeSchema.safeParse(edge).success).toBe(true);
    expect(unknowns).toEqual([]);
  });

  it('a gate on the effect-owning function yields control-supported gate-to-effect with a shared function id', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const effect = s.fn(vault, 'withdraw', {
      modifiers: ['onlyOwner'],
      source: 'Vault.sol:10-30',
    });
    const location = s.stateVar(vault, 'totalAssets');
    const writeEdge = s.access('WRITES', effect.id, location.id, [span('src/Vault.sol', 15)]);
    const index = s.buildIndex();
    const parts = partsOf(index);
    const gate = parts.conditions.find(
      (entry) => entry.kind === 'modifier-gate' && entry.descriptor === 'onlyOwner',
    )!;
    expect(gate.function).toBe(effect.id);
    const { influence } = deriveInfluence(index, parts);

    const gated = influence.filter(
      (edge) => edge.kind === 'control-supported' && edge.from === `gate:${gate.id}`,
    );
    expect(gated).toHaveLength(1);
    const edge = gated[0]!;
    expect(edge.to).toBe(`state-version:${location.id}@${effect.id}`);
    expect(edge.to).toContain(effect.id);
    expect(edge.evidence).toEqual([gate.id, writeEdge.id].sort());
    expect(edge.basis).toEqual([effect.id, location.id, writeEdge.id].sort());
    expect(edge.eclass).toBe('E2');
    expect(edge.declaration).toBe(INFLUENCE_DECLARATION);
    expect(edge.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(InfluenceEdgeSchema.safeParse(edge).success).toBe(true);
  });

  it('a resolved call into the effect-owning function yields call-supported with exact evidence', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const from = s.fn(caller, 'run');
    const into = s.fn(callee, 'execute');
    const location = s.stateVar(callee, 'totalAssets');
    const writeEdge = s.access('WRITES', into.id, location.id, [span('src/Callee.sol', 12)]);
    const callsEdge = s.calls(from.id, into.id, 'external');
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));

    const calls = influence.filter((edge) => edge.kind === 'call-supported');
    expect(calls).toHaveLength(1);
    const edge = calls[0]!;
    expect(edge.from).toBe(`call-site:${callsEdge.id}`);
    expect(edge.to).toBe(`state-version:${location.id}@${into.id}`);
    expect(edge.evidence).toEqual([callsEdge.id, writeEdge.id].sort());
    expect(edge.basis).toEqual(
      [callsEdge.id, from.id, into.id, location.id, writeEdge.id].sort(),
    );
    expect(edge.eclass).toBe('E2');
    expect(edge.declaration).toBe(INFLUENCE_DECLARATION);
    expect(edge.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(InfluenceEdgeSchema.safeParse(edge).success).toBe(true);
  });

  it('every emitted edge carries the over-approximation declaration verbatim', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const writer = s.fn(vault, 'deposit', { modifiers: ['onlyOwner'] });
    const reader = s.fn(vault, 'withdraw');
    const location = s.stateVar(vault, 'totalAssets');
    s.access('WRITES', writer.id, location.id, [span('src/Vault.sol', 10)]);
    s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
    s.calls(writer.id, reader.id, 'internal');
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));

    expect(influence.length).toBeGreaterThan(0);
    for (const edge of influence) {
      expect(edge.declaration).toBe('capable under stated evidence; materialization UNKNOWN');
      expect(InfluenceEdgeSchema.safeParse(edge).success).toBe(true);
    }
  });

  it('gate endpoints are from-only: schema rejects gate-as-to and the builder never emits it', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const guarded = s.fn(vault, 'guarded', { modifiers: ['onlyOwner'] });
    const location = s.stateVar(vault, 'totalAssets');
    s.access('WRITES', guarded.id, location.id, [span('src/Vault.sol', 10)]);
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));

    expect(influence.length).toBeGreaterThan(0);
    for (const edge of influence) {
      expect(edge.to.startsWith('state-version:')).toBe(true);
      expect(edge.to).not.toContain('gate:');
    }
    const sample = influence[0]!;
    expect(
      InfluenceEdgeSchema.safeParse({ ...sample, to: `gate:${sample.from}` }).success,
    ).toBe(false);
    expect(
      InfluenceEdgeSchema.safeParse({ ...sample, to: 'gate:seme:0000000000000000' }).success,
    ).toBe(false);
  });

  it('gate-to-gate and effect-to-gate readings are refused', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const first = s.fn(vault, 'first', { modifiers: ['onlyOwner'] });
    const second = s.fn(vault, 'second', { modifiers: ['nonReentrant'] });
    const location = s.stateVar(vault, 'totalAssets');
    s.access('WRITES', first.id, location.id, [span('src/Vault.sol', 10)]);
    s.access('READS', second.id, location.id, [span('src/Vault.sol', 20)]);
    s.calls(first.id, second.id, 'internal');
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));

    for (const edge of influence) {
      const fromGate = edge.from.startsWith('gate:');
      const toGate = edge.to.startsWith('gate:');
      expect(fromGate && toGate).toBe(false);
      expect(toGate).toBe(false);
    }
    expect(influence.some((edge) => edge.from.startsWith('gate:'))).toBe(true);
  });

  it('same-signature functions on different interfaces never link across identities', () => {
    const s = miniState();
    const left = s.contract('Left');
    const right = s.contract('Right');
    const params = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }];
    const target = s.fn(left, 'transferFrom', { parameters: params });
    const decoy = s.fn(right, 'transferFrom', { parameters: params });
    expect(target.signature).toBe(decoy.signature);
    expect(target.id).not.toBe(decoy.id);
    const operator = s.fn(left, 'operate');
    const location = s.stateVar(left, 'totalAssets');
    const writeEdge = s.access('WRITES', target.id, location.id, [span('src/Left.sol', 14)]);
    const callsEdge = s.calls(operator.id, target.id, 'external');
    const index = s.buildIndex();
    const { influence, unknowns } = deriveInfluence(index, partsOf(index));

    const serialized = stableStringify({ influence, unknowns });
    expect(serialized).not.toContain(decoy.id);
    const calls = influence.filter((edge) => edge.kind === 'call-supported');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.evidence).toContain(callsEdge.id);
    expect(calls[0]!.evidence).toContain(writeEdge.id);
    expect(calls[0]!.to).toContain(target.id);
  });

  it('a resolved call into an effect-less function yields no edge plus one no_evidence unknown', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const from = s.fn(caller, 'run');
    const into = s.fn(callee, 'execute');
    const callsEdge = s.calls(from.id, into.id, 'external');
    const index = s.buildIndex();
    const { influence, unknowns } = deriveInfluence(index, partsOf(index));

    expect(influence).toEqual([]);
    expect(unknowns).toHaveLength(1);
    const entry = unknowns[0]!;
    expect(entry.scope).toBe('influence-arg-param');
    expect(entry.reason).toBe('no_evidence');
    expect(entry.basis).toEqual([callsEdge.id]);
    expect(entry.id).toMatch(/^seme:[0-9a-f]{16}$/);
  });

  it('temporal markers and unknown-target boundaries never source edges', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const consumer = s.fn(vault, 'payout', { source: 'Vault.sol:10-30' });
    s.builtinIssue('Vault.sol', 12);
    const dangling = s.looseCalls(consumer.id, 'function:Gone:missing()', 'external');
    const index = s.buildIndex();
    index.relationshipsById.set(dangling.id, dangling);
    const parts = partsOf(index);
    expect(parts.boundaries.some((entry) => entry.target === 'unknown')).toBe(true);
    const { influence, unknowns } = deriveInfluence(index, parts);

    expect(influence).toEqual([]);
    expect(unknowns).toEqual([]);
    const serialized = stableStringify({ influence, unknowns });
    expect(serialized).not.toContain('ambient-source:');
    expect(serialized).not.toContain('external-boundary:');
  });

  it('different locations never merge: write and read across locations yield no data edge', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const writer = s.fn(vault, 'deposit');
    const reader = s.fn(vault, 'withdraw');
    const first = s.stateVar(vault, 'balances');
    const second = s.stateVar(vault, 'allowances');
    s.access('WRITES', writer.id, first.id, [span('src/Vault.sol', 10)]);
    s.access('READS', reader.id, second.id, [span('src/Vault.sol', 20)]);
    s.calls(writer.id, reader.id, 'internal');
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));

    expect(influence.filter((edge) => edge.kind === 'data-supported')).toEqual([]);
  });

  it('no transitive closure: a two-hop call path yields no direct writer-to-reader edge', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const head = s.fn(hub, 'head');
    const middle = s.fn(hub, 'middle');
    const tail = s.fn(hub, 'tail');
    const location = s.stateVar(hub, 'totalAssets');
    s.access('WRITES', head.id, location.id, [span('src/Hub.sol', 10)]);
    s.access('READS', tail.id, location.id, [span('src/Hub.sol', 30)]);
    const firstHop = s.calls(head.id, middle.id, 'internal');
    s.calls(middle.id, tail.id, 'internal');
    const index = s.buildIndex();
    const { influence, unknowns } = deriveInfluence(index, partsOf(index));

    const headVersion = `state-version:${location.id}@${head.id}`;
    const tailVersion = `state-version:${location.id}@${tail.id}`;
    expect(
      influence.filter((edge) => edge.from === headVersion && edge.to === tailVersion),
    ).toEqual([]);
    expect(influence.filter((edge) => edge.kind === 'data-supported')).toEqual([]);
    expect(unknowns.map((entry) => entry.basis)).toContainEqual([firstHop.id]);
  });

  it('a write and a read inside one function yield no data edge', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const alone = s.fn(vault, 'update');
    const location = s.stateVar(vault, 'totalAssets');
    s.access('WRITES', alone.id, location.id, [span('src/Vault.sol', 10)]);
    s.access('READS', alone.id, location.id, [span('src/Vault.sol', 20)]);
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));

    expect(influence.filter((edge) => edge.kind === 'data-supported')).toEqual([]);
  });

  it('unknown-location accesses never anchor an edge', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const writer = s.fn(vault, 'deposit');
    const reader = s.fn(vault, 'withdraw');
    const location = s.stateVar(vault, 'totalAssets');
    const stray = s.looseRel('WRITES', writer.id, 'state:Vault:missing', [
      span('src/Vault.sol', 10),
    ]);
    s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
    s.calls(writer.id, reader.id, 'internal');
    const index = s.buildIndex();
    index.relationshipsById.set(stray.id, stray);
    const parts = partsOf(index);
    expect(parts.accesses.some((entry) => entry.location === 'unknown')).toBe(true);
    const { influence } = deriveInfluence(index, parts);

    expect(influence.filter((edge) => edge.kind === 'data-supported')).toEqual([]);
  });

  it('unresolved calls never yield call-supported edges', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const from = s.fn(vault, 'run');
    const dangling = s.looseCalls(from.id, 'function:Gone:missing()', 'external');
    const index = s.buildIndex();
    index.relationshipsById.set(dangling.id, dangling);
    const { influence } = deriveInfluence(index, partsOf(index));

    expect(influence.filter((edge) => edge.kind === 'call-supported')).toEqual([]);
  });

  it('InfluenceEdgeSchema rejects excess keys, bad kinds, and empty ref lists', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const writer = s.fn(vault, 'deposit');
    const reader = s.fn(vault, 'withdraw');
    const location = s.stateVar(vault, 'totalAssets');
    s.access('WRITES', writer.id, location.id, [span('src/Vault.sol', 10)]);
    s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
    s.calls(writer.id, reader.id, 'internal');
    const index = s.buildIndex();
    const { influence } = deriveInfluence(index, partsOf(index));
    const edge = influence.find((entry) => entry.kind === 'data-supported')!;

    expect(InfluenceEdgeSchema.safeParse(edge).success).toBe(true);
    expect(InfluenceEdgeSchema.safeParse({ ...edge, extra: 'field' }).success).toBe(false);
    expect(InfluenceEdgeSchema.safeParse({ ...edge, kind: 'value-flow' }).success).toBe(false);
    expect(
      InfluenceEdgeSchema.safeParse({ ...edge, declaration: 'proven flow' }).success,
    ).toBe(false);
    expect(InfluenceEdgeSchema.safeParse({ ...edge, evidence: [] }).success).toBe(false);
    expect(InfluenceEdgeSchema.safeParse({ ...edge, basis: [] }).success).toBe(false);
    expect(
      InfluenceEdgeSchema.safeParse({ ...edge, from: `function:${writer.id}` }).success,
    ).toBe(false);
    expect(InfluenceEdgeSchema.safeParse({ ...edge, eclass: 'E9' }).success).toBe(false);
  });

  it('is deterministic across runs and relationship insertion order', () => {
    const build = () => {
      const s = miniState();
      const vault = s.contract('Vault');
      const writer = s.fn(vault, 'deposit', { modifiers: ['onlyOwner'] });
      const reader = s.fn(vault, 'withdraw');
      const location = s.stateVar(vault, 'totalAssets');
      s.access('WRITES', writer.id, location.id, [span('src/Vault.sol', 10)]);
      s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
      s.calls(writer.id, reader.id, 'internal');
      const index = s.buildIndex();
      return deriveInfluence(index, partsOf(index));
    };
    const forward = build();
    const repeat = build();
    expect(stableStringify(repeat)).toBe(stableStringify(forward));

    const swapped = (() => {
      const s = miniState();
      const vault = s.contract('Vault');
      const writer = s.fn(vault, 'deposit', { modifiers: ['onlyOwner'] });
      const reader = s.fn(vault, 'withdraw');
      const location = s.stateVar(vault, 'totalAssets');
      s.calls(writer.id, reader.id, 'internal');
      s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
      s.access('WRITES', writer.id, location.id, [span('src/Vault.sol', 10)]);
      const index = s.buildIndex();
      return deriveInfluence(index, partsOf(index));
    })();
    expect(stableStringify(swapped)).toBe(stableStringify(forward));
  });

  it('sorts influence and unknowns by id in code-unit order', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const zeta = s.contract('Zeta');
    const writer = s.fn(vault, 'deposit');
    const reader = s.fn(vault, 'withdraw');
    const idle = s.fn(zeta, 'idle');
    const location = s.stateVar(vault, 'totalAssets');
    s.access('WRITES', writer.id, location.id, [span('src/Vault.sol', 10)]);
    s.access('READS', reader.id, location.id, [span('src/Vault.sol', 20)]);
    s.calls(writer.id, reader.id, 'internal');
    s.calls(writer.id, idle.id, 'external');
    const index = s.buildIndex();
    const { influence, unknowns } = deriveInfluence(index, partsOf(index));

    expect(influence.length).toBeGreaterThan(1);
    const ids = influence.map((edge) => edge.id);
    expect([...ids].sort()).toEqual(ids);
    const unknownIds = unknowns.map((entry) => entry.id);
    expect([...unknownIds].sort()).toEqual(unknownIds);
    expect(unknowns.map((entry) => entry.reason)).toEqual(['no_evidence']);
  });

  it('empty input yields empty output', () => {
    const s = miniState();
    const index = s.buildIndex();
    expect(deriveInfluence(index, { accesses: [], conditions: [], boundaries: [] })).toEqual({
      influence: [],
      unknowns: [],
    });
  });
});
