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
import { esmContentId } from '../../../src/semantic/esm/ids.js';
import {
  deriveContexts,
  ExecutionContextSchema,
  type ExecutionContext,
} from '../../../src/semantic/esm/context.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

const RUNTIME_SCOPES = [
  'execution-actor',
  'execution-origin',
  'execution-value',
  'execution-block',
  'execution-order',
].sort();

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
    fn(
      contract: Contract,
      name: string,
      options?: { visibility?: Visibility; modifiers?: string[] },
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: options?.visibility ?? ('external' as Visibility),
        mutability: 'nonpayable' as Mutability,
        modifiers: options?.modifiers ?? [],
      });
      functions.push(record);
      return record;
    },
    calls(sourceId: string, targetId: string, kind: string | undefined): Relationship {
      const record = createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        ...(kind !== undefined ? { metadata: { call_kind: kind } } : {}),
        provenance: [span('src/Hub.sol', 10)],
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
    ): Fact {
      const record = createFact({
        subject_id: subjectId,
        predicate,
        value,
        provenance: [span('src/Hub.sol', 20)],
        created_at: CREATED_AT,
      });
      facts.push(record);
      return record;
    },
    decoy(subjectId: string, value: string): Fact {
      const record = createFact({
        subject_id: subjectId,
        predicate: 'CALLS',
        value,
        provenance: [span('src/Hub.sol', 30)],
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

function byEntry(contexts: ExecutionContext[], entry: string): ExecutionContext[] {
  return contexts.filter((entry2) => entry2.entry === entry);
}

describe('deriveContexts', () => {
  it('public entry yields a trivial self-chain context', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const start = s.fn(hub, 'start', {
      visibility: 'public' as Visibility,
      modifiers: ['checked'],
    });
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    expect(context.entry).toBe(start.id);
    expect(context.chain).toEqual([start.id]);
    expect(context.callKinds).toEqual([]);
    expect(context.gates).toEqual(['checked']);
    expect(context.unknown).toEqual({
      actor: 'unknown',
      origin: 'unknown',
      value: 'unknown',
      block: 'unknown',
      order: 'unknown',
    });
    expect(context.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(context.id).toBe(
      esmContentId('seme:', { entry: start.id, chain: [start.id], gates: ['checked'] }),
    );
    expect(ExecutionContextSchema.safeParse(context).success).toBe(true);

    expect(unknowns).toHaveLength(5);
    expect(unknowns.map((entry) => entry.scope).sort()).toEqual(RUNTIME_SCOPES);
    for (const entry of unknowns) {
      expect(entry.reason).toBe('runtime-unobservable');
      expect(entry.basis).toEqual([start.id]);
    }
  });

  it('external visibility also seeds an entry', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const ping = s.fn(hub, 'ping', { visibility: 'external' as Visibility });
    const { contexts } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.entry).toBe(ping.id);
    expect(contexts[0]!.chain).toEqual([ping.id]);
  });

  it('functions reached from no entry get trivial self-chain contexts', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const helper = s.fn(hub, 'helper', { visibility: 'internal' as Visibility });
    const lone = s.fn(hub, 'lone', { visibility: 'private' as Visibility });
    const { contexts } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context.chain).toEqual([context.entry]);
      expect(context.callKinds).toEqual([]);
    }
    expect(byEntry(contexts, helper.id)).toHaveLength(1);
    expect(byEntry(contexts, lone.id)).toHaveLength(1);
  });

  it('resolved call yields a callee context with the ordered chain and verbatim kind', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const leaf = s.contract('Leaf');
    const start = s.fn(hub, 'start', { modifiers: ['checked'] });
    const finish = s.fn(leaf, 'finish', {
      visibility: 'internal' as Visibility,
      modifiers: ['locked'],
    });
    const edge = s.calls(start.id, finish.id, 'external');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(2);
    const self = byEntry(contexts, start.id).find((entry) => entry.chain.length === 1)!;
    expect(self.chain).toEqual([start.id]);
    const callee = contexts.find((entry) => entry.chain.at(-1) === finish.id)!;
    expect(callee.entry).toBe(start.id);
    expect(callee.chain).toEqual([start.id, finish.id]);
    expect(callee.callKinds).toEqual(['external']);
    expect(callee.gates).toEqual(['locked']);
    expect(callee.unknown).toEqual({
      actor: 'unknown',
      origin: 'unknown',
      value: 'unknown',
      block: 'unknown',
      order: 'unknown',
    });
    expect(ExecutionContextSchema.safeParse(callee).success).toBe(true);

    const runtime = unknowns.filter((entry) => entry.reason === 'runtime-unobservable');
    expect(runtime).toHaveLength(10);
  });

  it('multi-hop chains carry ordered per-hop kinds and terminal gates', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const mid = s.contract('Mid');
    const leaf = s.contract('Leaf');
    const start = s.fn(hub, 'start', { modifiers: ['checked'] });
    const middle = s.fn(mid, 'middle', {
      visibility: 'internal' as Visibility,
      modifiers: ['paced'],
    });
    const finish = s.fn(leaf, 'finish', {
      visibility: 'internal' as Visibility,
      modifiers: ['locked'],
    });
    const first = s.calls(start.id, middle.id, 'internal');
    const second = s.calls(middle.id, finish.id, 'external');
    const { contexts } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(3);
    const deep = contexts.find((entry) => entry.chain.at(-1) === finish.id)!;
    expect(deep.entry).toBe(start.id);
    expect(deep.chain).toEqual([start.id, middle.id, finish.id]);
    expect(deep.callKinds).toEqual(['internal', 'external']);
    expect(deep.gates).toEqual(['locked']);
    expect(deep.id).toBe(
      esmContentId('seme:', {
        entry: start.id,
        chain: [start.id, middle.id, finish.id],
        gates: ['locked'],
      }),
    );
  });
  it('resolved delegatecall hop records an explicit shift marker plus storage-subject unknown', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const leaf = s.contract('Leaf');
    const start = s.fn(hub, 'start');
    const finish = s.fn(leaf, 'finish', { visibility: 'internal' as Visibility });
    const edge = s.calls(start.id, finish.id, 'delegatecall');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    const callee = contexts.find((entry) => entry.chain.at(-1) === finish.id)!;
    expect(callee.chain).toEqual([start.id, finish.id]);
    expect(callee.callKinds).toEqual(['context-shift:delegatecall']);
    expect(ExecutionContextSchema.safeParse(callee).success).toBe(true);

    const shifted = unknowns.filter((entry) => entry.scope === 'storage-subject');
    expect(shifted).toHaveLength(1);
    expect(shifted[0]!.reason).toBe('context-shift');
    expect(shifted[0]!.basis).toEqual([edge.id]);
    expect(shifted[0]!.id).toMatch(/^seme:[0-9a-f]{16}$/);
  });

  it('delegatecall marker fact truncates the chain with the marker id and shift kind', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const start = s.fn(hub, 'start', { modifiers: ['checked'] });
    const marker = s.marker(start.id, 'DELEGATES_TO', 'unresolved-delegatecall');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(2);
    const truncated = contexts.find((entry) => entry.chain.length === 2)!;
    expect(truncated.entry).toBe(start.id);
    expect(truncated.chain).toEqual([start.id, marker.id]);
    expect(truncated.callKinds).toEqual(['context-shift:unresolved-delegatecall']);
    expect(truncated.gates).toEqual(['checked']);
    expect(ExecutionContextSchema.safeParse(truncated).success).toBe(true);

    const shifted = unknowns.filter((entry) => entry.scope === 'storage-subject');
    expect(shifted).toHaveLength(1);
    expect(shifted[0]!.reason).toBe('context-shift');
    expect(shifted[0]!.basis).toEqual([marker.id]);
  });

  it('non-delegate marker truncates the chain with an unresolved-target unknown', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const start = s.fn(hub, 'start');
    const marker = s.marker(start.id, 'CALLS', 'unresolved-lowlevel-call');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    const truncated = contexts.find((entry) => entry.chain.length === 2)!;
    expect(truncated.chain).toEqual([start.id, marker.id]);
    expect(truncated.callKinds).toEqual(['unresolved-lowlevel-call']);

    const target = unknowns.filter((entry) => entry.scope === 'execution-target');
    expect(target).toHaveLength(1);
    expect(target[0]!.reason).toBe('unresolved_call');
    expect(target[0]!.basis).toEqual([marker.id]);
    expect(unknowns.some((entry) => entry.scope === 'storage-subject')).toBe(false);
  });

  it('edge without call kind is not traversed and yields a no-evidence unknown', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const leaf = s.contract('Leaf');
    const start = s.fn(hub, 'start');
    const finish = s.fn(leaf, 'finish', { visibility: 'internal' as Visibility });
    const edge = s.calls(start.id, finish.id, undefined);
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts.find((entry) => entry.chain.includes(finish.id) && entry.entry === start.id)).toBe(
      undefined,
    );
    expect(byEntry(contexts, finish.id)).toHaveLength(1);
    const missing = unknowns.filter((entry) => entry.scope === 'execution-call-kind');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.reason).toBe('no_evidence');
    expect(missing[0]!.basis).toEqual([edge.id]);
  });

  it('edge to a missing target is not traversed and yields an out-of-scope unknown', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const start = s.fn(hub, 'start');
    const edge = s.looseCalls(start.id, 'function:Gone:missing()', 'external');
    const index = s.buildIndex();
    index.relationshipsById.set(edge.id, edge);
    const { contexts, unknowns } = deriveContexts(index);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.chain).toEqual([start.id]);
    const missing = unknowns.filter((entry) => entry.scope === 'execution-target');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.reason).toBe('out_of_scope_target');
    expect(missing[0]!.basis).toEqual([edge.id]);
  });

  it('all records carry mandatory unknown runtime fields with ledger entries', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const leaf = s.contract('Leaf');
    const start = s.fn(hub, 'start');
    const finish = s.fn(leaf, 'finish', { visibility: 'internal' as Visibility });
    s.calls(start.id, finish.id, 'external');
    s.marker(finish.id, 'CALLS', 'unresolved-staticcall');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(context.unknown).toEqual({
        actor: 'unknown',
        origin: 'unknown',
        value: 'unknown',
        block: 'unknown',
        order: 'unknown',
      });
      expect(ExecutionContextSchema.safeParse(context).success).toBe(true);
    }
    const runtime = unknowns.filter((entry) => entry.reason === 'runtime-unobservable');
    expect(runtime).toHaveLength(contexts.length * 5);
    expect(unknowns.map((entry) => entry.scope).sort()).toContain('execution-actor');
  });

  it('cyclic calls terminate without duplicates', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const leaf = s.contract('Leaf');
    const first = s.fn(hub, 'first');
    const second = s.fn(leaf, 'second');
    s.calls(first.id, second.id, 'external');
    s.calls(second.id, first.id, 'external');
    const { contexts } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(4);
    const chains = contexts.map((entry) => entry.chain.join('>')).sort();
    expect(chains).toHaveLength(new Set(chains).size);
  });

  it('selector-only decoy facts never resolve', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const start = s.fn(hub, 'start');
    const decoy = s.decoy(start.id, 'transfer(address,uint256)');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.chain).toEqual([start.id]);
    expect(unknowns.flatMap((entry) => entry.basis)).not.toContain(decoy.id);
  });

  it('is deterministic across runs and insertion order', () => {
    const build = (): { contexts: ExecutionContext[]; unknowns: unknown[] } => {
      const s = miniState();
      const hub = s.contract('Hub');
      const leaf = s.contract('Leaf');
      const start = s.fn(hub, 'start');
      const finish = s.fn(leaf, 'finish', { visibility: 'internal' as Visibility });
      s.calls(start.id, finish.id, 'external');
      s.marker(finish.id, 'CALLS', 'unresolved-lowlevel-call');
      return deriveContexts(s.buildIndex());
    };
    const forward = build();
    const repeat = build();
    expect(stableStringify(repeat)).toBe(stableStringify(forward));

    const swapped = ((): { contexts: ExecutionContext[]; unknowns: unknown[] } => {
      const s = miniState();
      const hub = s.contract('Hub');
      const leaf = s.contract('Leaf');
      const finish = s.fn(leaf, 'finish', { visibility: 'internal' as Visibility });
      const start = s.fn(hub, 'start');
      s.marker(finish.id, 'CALLS', 'unresolved-lowlevel-call');
      s.calls(start.id, finish.id, 'external');
      return deriveContexts(s.buildIndex());
    })();
    expect(stableStringify(swapped)).toBe(stableStringify(forward));
  });

  it('sorts contexts and unknowns by id in code-unit order', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const first = s.contract('First');
    const second = s.contract('Second');
    const start = s.fn(hub, 'start');
    const alpha = s.fn(first, 'alpha');
    const zeta = s.fn(second, 'zeta');
    s.calls(start.id, zeta.id, 'external');
    s.calls(start.id, alpha.id, 'external');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    expect(contexts.length).toBeGreaterThan(1);
    const ids = contexts.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
    const unknownIds = unknowns.map((entry) => entry.id);
    expect([...unknownIds].sort()).toEqual(unknownIds);
  });

  it('ExecutionContextSchema rejects excess keys, known runtime values, and kind-length mismatch', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const start = s.fn(hub, 'start');
    const { contexts } = deriveContexts(s.buildIndex());
    const context = contexts[0]!;

    expect(ExecutionContextSchema.safeParse(context).success).toBe(true);
    expect(ExecutionContextSchema.safeParse({ ...context, extra: 'field' }).success).toBe(false);
    expect(
      ExecutionContextSchema.safeParse({ ...context, unknown: { ...context.unknown, actor: 'known' } })
        .success,
    ).toBe(false);
    expect(
      ExecutionContextSchema.safeParse({ ...context, callKinds: ['external'] }).success,
    ).toBe(false);
    expect(ExecutionContextSchema.safeParse({ ...context, chain: [] }).success).toBe(false);
  });

  it('empty input yields empty output', () => {
    const s = miniState();
    expect(deriveContexts(s.buildIndex())).toEqual({ contexts: [], unknowns: [] });
  });

  it('serialized output carries no classification strings', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const leaf = s.contract('Leaf');
    const start = s.fn(hub, 'start', { modifiers: ['checked'] });
    const finish = s.fn(leaf, 'finish', {
      visibility: 'internal' as Visibility,
      modifiers: ['locked'],
    });
    s.calls(start.id, finish.id, 'delegatecall');
    s.marker(finish.id, 'CALLS', 'unresolved-lowlevel-call');
    const { contexts, unknowns } = deriveContexts(s.buildIndex());

    const serialized = stableStringify({ contexts, unknowns });
    expect(serialized).not.toContain('owner');
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('role');
    expect(serialized).not.toContain('guardian');
    expect(serialized).not.toContain('authority_kind');
  });
});
