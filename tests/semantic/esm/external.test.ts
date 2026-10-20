import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createFact, type Fact } from '../../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { stableStringify } from '../../../src/util/canonical.js';
import {
  deriveBoundaries,
  ExternalResultSchema,
  type ExternalResult,
} from '../../../src/semantic/esm/external.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const relationships: Relationship[] = [];
  const facts: Fact[] = [];

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
    calls(
      sourceId: string,
      targetId: string,
      kind: string | undefined,
      provenance: ProvenanceInput[],
    ): Relationship {
      const record = createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        ...(kind !== undefined ? { metadata: { call_kind: kind } } : {}),
        provenance,
        created_at: CREATED_AT,
      });
      relationships.push(record);
      return record;
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
    marker(
      subjectId: string,
      predicate: 'CALLS' | 'DELEGATES_TO',
      value: string,
      provenance: ProvenanceInput[],
    ): Fact {
      const record = createFact({
        subject_id: subjectId,
        predicate,
        value,
        provenance,
        created_at: CREATED_AT,
      });
      facts.push(record);
      return record;
    },
    buildIndex(): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: [],
        relationships,
        facts,
      });
      return buildEvidenceIndex({
        state,
        issues: [],
        meta: { fidelity: 'semantic', fileCount: 1 },
      });
    },
  };
}

describe('deriveBoundaries', () => {
  it('resolved external CALLS yields a boundary with the exact target id and the edge basis', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const from = s.fn(caller, 'run');
    const to = s.fn(callee, 'execute');
    const edge = s.calls(from.id, to.id, 'external', [span('src/Caller.sol', 10)]);
    const { boundaries, unknowns } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toHaveLength(1);
    const boundary = boundaries[0]!;
    expect(boundary.site).toBe(edge.id);
    expect(boundary.kind).toBe('external');
    expect(boundary.target).toBe(to.id);
    expect(boundary.returnLink).toBe('unknown');
    expect(boundary.result).toBe('unknown');
    expect(boundary.basis).toEqual([edge.id]);
    expect(boundary.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(ExternalResultSchema.safeParse(boundary).success).toBe(true);

    expect(unknowns).toHaveLength(2);
    const reasons = unknowns.map((entry) => entry.reason).sort();
    expect(reasons).toEqual(['no-return-linkage', 'no-return-linkage']);
    const scopes = unknowns.map((entry) => entry.scope).sort();
    expect(scopes).toEqual(['external-result', 'external-return-linkage']);
    for (const entry of unknowns) expect(entry.basis).toEqual([edge.id]);
  });

  it('lowlevel marker yields a boundary keyed by the marker with an unresolved-target entry', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const from = s.fn(caller, 'run');
    const marker = s.marker(from.id, 'CALLS', 'unresolved-lowlevel-call', [
      span('src/Caller.sol', 20),
    ]);
    const { boundaries, unknowns } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toHaveLength(1);
    const boundary = boundaries[0]!;
    expect(boundary.site).toBe(marker.id);
    expect(boundary.kind).toBe('unresolved-lowlevel-call');
    expect(boundary.target).toBe(marker.id);
    expect(boundary.returnLink).toBe('unknown');
    expect(boundary.result).toBe('unknown');
    expect(boundary.basis).toEqual([marker.id]);

    expect(unknowns).toHaveLength(3);
    const byScope = new Map(unknowns.map((entry) => [entry.scope, entry]));
    expect(byScope.get('external-target')?.reason).toBe('unresolved_call');
    expect(byScope.get('external-target')?.basis).toEqual([marker.id]);
    expect(byScope.get('external-return-linkage')?.reason).toBe('no-return-linkage');
    expect(byScope.get('external-result')?.reason).toBe('no-return-linkage');
  });

  it('delegate marker via DELEGATES_TO yields a boundary with the delegate marker kind', () => {
    const s = miniState();
    const caller = s.contract('Proxy');
    const from = s.fn(caller, 'forward');
    const marker = s.marker(from.id, 'DELEGATES_TO', 'unresolved-delegatecall', [
      span('src/Proxy.sol', 7),
    ]);
    const { boundaries, unknowns } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.kind).toBe('unresolved-delegatecall');
    expect(boundaries[0]!.target).toBe(marker.id);
    expect(boundaries[0]!.returnLink).toBe('unknown');
    expect(boundaries[0]!.result).toBe('unknown');
    expect(unknowns.map((entry) => entry.reason).sort()).toEqual([
      'no-return-linkage',
      'no-return-linkage',
      'unresolved_call',
    ]);
  });

  it('CALLS edge with an unresolvable target yields target unknown plus an entry', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const from = s.fn(caller, 'run');
    const edge = s.looseCalls(from.id, 'function:Gone:missing()', 'external');
    const index = s.buildIndex();
    index.relationshipsById.set(edge.id, edge);
    const { boundaries, unknowns } = deriveBoundaries(index);

    expect(boundaries).toHaveLength(1);
    const boundary = boundaries[0]!;
    expect(boundary.site).toBe(edge.id);
    expect(boundary.kind).toBe('external');
    expect(boundary.target).toBe('unknown');
    expect(boundary.returnLink).toBe('unknown');
    expect(boundary.result).toBe('unknown');
    expect(boundary.basis).toEqual([edge.id]);

    expect(unknowns).toHaveLength(3);
    const byScope = new Map(unknowns.map((entry) => [entry.scope, entry]));
    expect(byScope.get('external-target')?.reason).toBe('out_of_scope_target');
    expect(byScope.get('external-target')?.basis).toEqual([edge.id]);
  });

  it('return linkage and result are unknown in every boundary case', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const from = s.fn(caller, 'run');
    const to = s.fn(callee, 'execute');
    s.calls(from.id, to.id, 'external', [span('src/Caller.sol', 10)]);
    s.marker(from.id, 'CALLS', 'unresolved-staticcall', [span('src/Caller.sol', 11)]);
    const { boundaries } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toHaveLength(2);
    for (const boundary of boundaries) {
      expect(boundary.returnLink).toBe('unknown');
      expect(boundary.result).toBe('unknown');
    }
    const serialized = stableStringify(boundaries);
    expect(serialized).not.toContain('linked');
    expect(serialized).not.toContain('resolved-return');
  });

  it('selector-only decoy without a resolved edge is never resolved to a function', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const other = s.contract('Other');
    const from = s.fn(caller, 'run');
    const to = s.fn(callee, 'execute');
    const decoy = s.fn(other, 'transfer');
    s.calls(from.id, to.id, 'external', [span('src/Caller.sol', 10)]);
    const decoyFact = s.marker(from.id, 'CALLS', 'transfer(address,uint256)', [
      span('src/Caller.sol', 12),
    ]);
    const { boundaries, unknowns } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.target).toBe(to.id);
    expect(boundaries.map((boundary) => boundary.target)).not.toContain(decoy.id);
    expect(unknowns.flatMap((entry) => entry.basis)).not.toContain(decoyFact.id);
  });

  it('internal CALLS edges are not boundaries', () => {
    const s = miniState();
    const caller = s.contract('Vault');
    const from = s.fn(caller, 'deposit');
    const helper = s.fn(caller, 'helper');
    s.calls(from.id, helper.id, 'internal', [span('src/Vault.sol', 5)]);
    expect(deriveBoundaries(s.buildIndex())).toEqual({ boundaries: [], unknowns: [] });
  });

  it('CALLS edge without call_kind yields no boundary and a no-evidence entry', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const from = s.fn(caller, 'run');
    const to = s.fn(callee, 'execute');
    const edge = s.calls(from.id, to.id, undefined, [span('src/Caller.sol', 10)]);
    const { boundaries, unknowns } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toEqual([]);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.scope).toBe('external-boundary');
    expect(unknowns[0]!.reason).toBe('no_evidence');
    expect(unknowns[0]!.basis).toEqual([edge.id]);
  });

  it('is deterministic across runs and insertion order', () => {
    const build = (): { boundaries: ExternalResult[]; unknowns: unknown[] } => {
      const s = miniState();
      const caller = s.contract('Caller');
      const callee = s.contract('Callee');
      const from = s.fn(caller, 'run');
      const to = s.fn(callee, 'execute');
      s.calls(from.id, to.id, 'external', [span('src/Caller.sol', 10)]);
      s.marker(from.id, 'CALLS', 'unresolved-lowlevel-call', [span('src/Caller.sol', 20)]);
      return deriveBoundaries(s.buildIndex());
    };
    const forward = build();
    const repeat = build();
    expect(stableStringify(repeat)).toBe(stableStringify(forward));

    const swapped = ((): { boundaries: ExternalResult[]; unknowns: unknown[] } => {
      const s = miniState();
      const caller = s.contract('Caller');
      const callee = s.contract('Callee');
      const from = s.fn(caller, 'run');
      const to = s.fn(callee, 'execute');
      s.marker(from.id, 'CALLS', 'unresolved-lowlevel-call', [span('src/Caller.sol', 20)]);
      s.calls(from.id, to.id, 'external', [span('src/Caller.sol', 10)]);
      return deriveBoundaries(s.buildIndex());
    })();
    expect(stableStringify(swapped)).toBe(stableStringify(forward));
  });

  it('sorts boundaries and unknowns by id in code-unit order', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const first = s.contract('First');
    const second = s.contract('Second');
    const from = s.fn(caller, 'run');
    const alpha = s.fn(first, 'alpha');
    const zeta = s.fn(second, 'zeta');
    s.calls(from.id, zeta.id, 'external', [span('src/Caller.sol', 12)]);
    s.calls(from.id, alpha.id, 'external', [span('src/Caller.sol', 11)]);
    const { boundaries, unknowns } = deriveBoundaries(s.buildIndex());

    expect(boundaries).toHaveLength(2);
    const ids = boundaries.map((boundary) => boundary.id);
    expect([...ids].sort()).toEqual(ids);
    const unknownIds = unknowns.map((entry) => entry.id);
    expect([...unknownIds].sort()).toEqual(unknownIds);
  });

  it('ExternalResultSchema rejects excess keys and non-unknown return fields', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    const callee = s.contract('Callee');
    const from = s.fn(caller, 'run');
    const to = s.fn(callee, 'execute');
    s.calls(from.id, to.id, 'external', [span('src/Caller.sol', 10)]);
    const { boundaries } = deriveBoundaries(s.buildIndex());
    const boundary = boundaries[0]!;

    expect(ExternalResultSchema.safeParse(boundary).success).toBe(true);
    expect(ExternalResultSchema.safeParse({ ...boundary, trust: 'high' }).success).toBe(false);
    expect(ExternalResultSchema.safeParse({ ...boundary, returnLink: 'linked' }).success).toBe(
      false,
    );
    expect(ExternalResultSchema.safeParse({ ...boundary, result: 'ok' }).success).toBe(false);
  });

  it('empty call input yields empty output', () => {
    const s = miniState();
    const caller = s.contract('Caller');
    s.fn(caller, 'run');
    expect(deriveBoundaries(s.buildIndex())).toEqual({ boundaries: [], unknowns: [] });
  });
});
