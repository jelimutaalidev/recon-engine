import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../../src/domain/state-variable.js';
import { createFact, type Fact } from '../../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { stableStringify } from '../../../src/util/canonical.js';
import { deriveAccesses } from '../../../src/semantic/esm/access.js';
import { deriveConditions } from '../../../src/semantic/esm/conditions.js';
import { deriveBoundaries } from '../../../src/semantic/esm/external.js';
import { deriveTemporals } from '../../../src/semantic/esm/temporal.js';
import { deriveContexts } from '../../../src/semantic/esm/context.js';
import { deriveInfluence } from '../../../src/semantic/esm/influence.js';
import { derivePaths } from '../../../src/semantic/esm/path.js';
import {
  COMPOSITION_BOUND,
  ComposedSummarySchema,
  callbackReentry,
  callInline,
  composeFunction,
  delegateShift,
  inheritMerge,
  modifierWrap,
  type ComposedEntry,
  type CompositionFragment,
} from '../../../src/semantic/esm/compose.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const stateVariables: StateVariable[] = [];
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
    writes(sourceId: string, varId: string): Relationship {
      const record = createRelationship({
        type: 'WRITES',
        source_id: sourceId,
        target_id: varId,
        provenance: [span('src/Hub.sol', 5)],
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
        provenance: [span('src/Hub.sol', 10)],
        created_at: CREATED_AT,
      });
      relationships.push(record);
      return record;
    },
    base(derivedContractId: string, baseContractId: string): Relationship {
      const record = createRelationship({
        type: 'INHERITS',
        source_id: derivedContractId,
        target_id: baseContractId,
        provenance: [span('src/Derived.sol', 2)],
        created_at: CREATED_AT,
      });
      relationships.push(record);
      return record;
    },
    dangling(sourceId: string, targetId: string, kind: string): Relationship {
      return createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        metadata: { call_kind: kind },
        provenance: [span('src/Hub.sol', 10)],
        created_at: CREATED_AT,
      });
    },
    ghostBase(derivedContractId: string, baseContractId: string): Relationship {
      return createRelationship({
        type: 'INHERITS',
        source_id: derivedContractId,
        target_id: baseContractId,
        provenance: [span('src/Derived.sol', 2)],
        created_at: CREATED_AT,
      });
    },
    buildIndex(): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: stateVariables,
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

function deriveAll(index: EvidenceIndex) {
  const accesses = deriveAccesses(index).accesses;
  const conditions = deriveConditions(index).conditions;
  const boundaries = deriveBoundaries(index).boundaries;
  const temporals = deriveTemporals(index).temporals;
  const contexts = deriveContexts(index).contexts;
  const influence = deriveInfluence(index, { accesses, conditions, boundaries }).influence;
  const paths = derivePaths(index, { influence, conditions }).paths;
  return { accesses, conditions, boundaries, temporals, contexts, influence, paths };
}

function frag(entries: ComposedEntry[]): CompositionFragment {
  return { entries, lineage: [], unknowns: [], status: 'direct' };
}

function entry(
  kind: ComposedEntry['kind'],
  ref: string,
  fn: string,
  contract: string,
): ComposedEntry {
  return { kind, ref, function: fn, contract };
}

describe('composeFunction ownership preservation', () => {
  it('A->B composes with separable A/B partitions and two linked contexts', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    const eAB = s.calls(a.id, b.id, 'internal');
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, a.id, parts);

    expect(ComposedSummarySchema.parse(summary)).toEqual(summary);
    expect(summary.owner).toEqual({ function: a.id, contract: hub.id });

    const aPart = summary.entries.filter((record) => record.function === a.id);
    const bPart = summary.entries.filter((record) => record.function === b.id);
    expect(aPart.length).toBeGreaterThan(0);
    expect(bPart.length).toBeGreaterThan(0);
    for (const record of summary.entries) {
      expect([a.id, b.id]).toContain(record.function);
      expect(record.contract).toBe(hub.id);
    }
    const aRefs = new Set(aPart.map((record) => `${record.kind}::${record.ref}`));
    const bRefs = new Set(bPart.map((record) => `${record.kind}::${record.ref}`));
    for (const ref of aRefs) expect(bRefs.has(ref)).toBe(false);
    const keptB = summary.entries.filter((record) => record.function !== a.id);
    expect(keptB).toEqual(bPart);

    expect(summary.contexts.length).toBeGreaterThanOrEqual(2);
    const summaryIds = new Set(summary.contexts.map((context) => context.id));
    const partIds = new Set(parts.contexts.map((context) => context.id));
    for (const id of summaryIds) expect(partIds.has(id)).toBe(true);
    const callerView = summary.contexts.filter((context) => context.entry === a.id);
    const calleeView = summary.contexts.filter((context) => context.entry === b.id);
    expect(callerView.length).toBeGreaterThanOrEqual(1);
    expect(calleeView.length).toBeGreaterThanOrEqual(1);
    const chains = summary.contexts.map((context) => stableStringify(context.chain));
    expect(chains).toContain(stableStringify([a.id]));
    expect(chains).toContain(stableStringify([a.id, b.id]));

    const inline = summary.lineage.find(
      (record) => record.operator === 'call-inline' && record.edge === eAB.id,
    );
    expect(inline?.status).toBe('direct');
    expect(unknowns).toEqual([]);
  });
});

describe('modifierWrap', () => {
  it('prepends every modifier gate in order (multi-modifier, no first-only)', () => {
    const target = frag([entry('condition', 'seme:vis', 'function:A', 'contract:H')]);
    const gates = [
      { entry: entry('condition', 'seme:m1', 'function:A', 'contract:H'), modifier: 'onlyOwner' },
      {
        entry: entry('condition', 'seme:m2', 'function:A', 'contract:H'),
        modifier: 'whenNotPaused',
      },
    ];
    const result = modifierWrap(target, gates);
    expect(result.entries.map((record) => record.ref)).toEqual([
      'seme:m1',
      'seme:m2',
      'seme:vis',
    ]);
    expect(result.lineage.map((record) => record.edge)).toEqual([
      'onlyOwner',
      'whenNotPaused',
    ]);
    expect(result.lineage.every((record) => record.operator === 'modifier-wrap')).toBe(true);
  });

  it('composeFunction keeps all modifier gates first in modifier order', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a', { modifiers: ['onlyOwner', 'whenNotPaused'] });
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const { summary } = composeFunction(index, a.id, parts);

    const first = summary.lineage.find((record) => record.operator === 'modifier-wrap');
    expect(first?.edge).toBe('onlyOwner');
    const wraps = summary.lineage.filter((record) => record.operator === 'modifier-wrap');
    expect(wraps.map((record) => record.edge)).toEqual(['onlyOwner', 'whenNotPaused']);

    const m1 = parts.conditions.find(
      (condition) =>
        condition.function === a.id &&
        condition.kind === 'modifier-gate' &&
        condition.descriptor === 'onlyOwner',
    );
    const m2 = parts.conditions.find(
      (condition) =>
        condition.function === a.id &&
        condition.kind === 'modifier-gate' &&
        condition.descriptor === 'whenNotPaused',
    );
    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
    expect(summary.entries[0]?.ref).toBe(m1?.id);
    expect(summary.entries[1]?.ref).toBe(m2?.id);
  });

  it('identical operator applications on caller and callee stay distinguishable in lineage', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a', { modifiers: ['onlyOwner'] });
    const b = s.fn(hub, 'b', { modifiers: ['onlyOwner'] });
    s.calls(a.id, b.id, 'internal');
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const { summary } = composeFunction(index, a.id, parts);

    const wraps = summary.lineage.filter(
      (record) => record.operator === 'modifier-wrap' && record.edge === 'onlyOwner',
    );
    expect(wraps.length).toBe(2);
    expect(wraps.map((record) => record.owner).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('inheritMerge', () => {
  it('unknown base yields a marker while the derived side is preserved', () => {
    const derived = frag([entry('condition', 'seme:dvis', 'function:D', 'contract:Derived')]);
    const result = inheritMerge(derived, undefined, 'rel:base1');
    expect(result.entries.map((record) => record.ref)).toEqual(['seme:dvis']);
    expect(result.lineage).toEqual([
      { operator: 'inherit-merge', edge: 'rel:base1', status: 'direct', flags: ['unknown-base'] },
    ]);
    expect(result.unknowns.length).toBe(1);
    expect(result.unknowns[0]?.reason).toBe('out_of_scope_target');
    expect(result.unknowns[0]?.basis).toContain('rel:base1');
  });

  it('composeFunction marks an unknown base and preserves derived entries', () => {
    const s = miniState();
    const derived = s.contract('Derived');
    const d = s.fn(derived, 'd');
    const rel = s.ghostBase(derived.id, 'contract:GhostBase');
    const index = s.buildIndex();
    index.relationshipsById.set(rel.id, rel);
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, d.id, parts);

    const marker = unknowns.find((record) => record.reason === 'out_of_scope_target');
    expect(marker?.basis).toContain(rel.id);
    const merge = summary.lineage.find((record) => record.operator === 'inherit-merge');
    expect(merge?.flags).toContain('unknown-base');
    const dPart = summary.entries.filter((record) => record.function === d.id);
    expect(dPart.length).toBeGreaterThan(0);
    for (const record of summary.entries) {
      expect(record.contract).not.toBe('contract:GhostBase');
    }
  });

  it('composeFunction merges a known base with inherit-merge lineage on the base contract', () => {
    const s = miniState();
    const base = s.contract('Base');
    const derived = s.contract('Derived');
    const m = s.fn(base, 'm', { modifiers: ['onlyOwner'] });
    const d = s.fn(derived, 'd');
    s.base(derived.id, base.id);
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, d.id, parts);

    const dPart = summary.entries.filter((record) => record.function === d.id);
    expect(dPart.length).toBeGreaterThan(0);
    const mPart = summary.entries.filter((record) => record.function === m.id);
    expect(mPart.length).toBeGreaterThan(0);
    for (const record of mPart) expect(record.contract).toBe(base.id);
    const merge = summary.lineage.find((record) => record.operator === 'inherit-merge');
    expect(merge?.edge).toBe(base.id);
    expect(merge?.flags).toEqual([]);
    expect(merge?.owner).toBe(d.id);
    expect(unknowns).toEqual([]);
  });
});

describe('delegateShift', () => {
  it('composeFunction records a shift marker plus storage-subject UNKNOWN', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    const site = s.calls(a.id, b.id, 'delegatecall');
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, a.id, parts);

    const shift = summary.lineage.find((record) => record.operator === 'delegate-shift');
    expect(shift?.edge).toBe(site.id);
    const subject = unknowns.find((record) => record.scope === 'storage-subject');
    expect(subject?.reason).toBe('context-shift');
    expect(subject?.basis).toContain(site.id);
    const bPart = summary.entries.filter((record) => record.function === b.id);
    expect(bPart.length).toBeGreaterThan(0);
    expect(summary.lineage.every((record) => record.status === 'direct')).toBe(true);
  });

  it('delegateShift operator keeps target entries under the marker', () => {
    const target = frag([entry('access', 'seme:acc', 'function:B', 'contract:H')]);
    const result = delegateShift(target, 'rel:site1');
    expect(result.entries.map((record) => record.ref)).toEqual(['seme:acc']);
    expect(result.lineage).toEqual([
      { operator: 'delegate-shift', edge: 'rel:site1', status: 'direct', flags: ['shift'] },
    ]);
    expect(result.unknowns.length).toBe(1);
    expect(result.unknowns[0]?.reason).toBe('context-shift');
  });
});

describe('callbackReentry', () => {
  it('WITH outward call and exposed entry yields a reentry-capable union plus UNKNOWN order', () => {
    const caller = frag([entry('condition', 'seme:acond', 'function:A', 'contract:H')]);
    const exposed = frag([entry('condition', 'seme:bcond', 'function:B', 'contract:H')]);
    const result = callbackReentry(caller, exposed, 'rel:out1', 'function:B');

    expect(result.entries.map((record) => record.ref).sort()).toEqual([
      'seme:acond',
      'seme:bcond',
    ]);
    expect(result.lineage.length).toBe(1);
    expect(result.lineage[0]).toEqual({
      operator: 'callback-reentry',
      edge: 'rel:out1',
      entry: 'function:B',
      status: 'reentry-capable',
      flags: ['unknown-order'],
    });
    expect(result.status).toBe('reentry-capable');
    expect(result.unknowns.length).toBe(1);
    expect(result.unknowns[0]?.reason).toBe('ordering-unobservable');
    expect(result.unknowns[0]?.basis).toContain('rel:out1');
    expect(result.unknowns[0]?.basis).toContain('function:B');
  });

  it('WITHOUT an exposed entry yields UNKNOWN with no union (pure operator returns empty)', () => {
    const caller = frag([entry('condition', 'seme:acond', 'function:A', 'contract:H')]);
    caller.status = 'reentry-capable';
    const result = callbackReentry(caller, undefined, 'rel:out1');

    // Spec §12.1: no union at all — caller entries MUST NOT be returned here.
    // Traversal preserves the caller side separately (see composeFunction test).
    expect(result.entries).toEqual([]);
    expect(result.status).toBe('reentry-capable');
    expect(result.unknowns.length).toBe(1);
    expect(result.unknowns[0]?.reason).toBe('no_evidence');
    expect(result.unknowns[0]?.basis).toEqual(['rel:out1']);
    expect(result.lineage.length).toBe(1);
    expect(result.lineage[0]?.operator).toBe('callback-reentry');
    expect(result.lineage[0]?.status).toBe('reentry-capable');
    expect(result.lineage[0]?.flags).toEqual(['no-entry']);
    expect('entry' in (result.lineage[0] as object)).toBe(false);
  });

  it('composeFunction unions an exposed entry for an unresolved outward call', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a', { visibility: 'internal' });
    const b = s.fn(hub, 'b');
    const site = s.dangling(a.id, 'function:Ghost:missing()', 'external');
    const index = s.buildIndex();
    index.relationshipsById.set(site.id, site);
    const parts = deriveAll(index);
    const partIds = new Set(
      [...parts.accesses, ...parts.conditions, ...parts.boundaries, ...parts.temporals,
        ...parts.influence, ...parts.paths].map((record) => record.id),
    );
    const { summary, unknowns } = composeFunction(index, a.id, parts);

    const reentry = summary.lineage.find((record) => record.operator === 'callback-reentry');
    expect(reentry?.edge).toBe(site.id);
    expect(reentry?.entry).toBe(b.id);
    expect(reentry?.status).toBe('reentry-capable');
    const bPart = summary.entries.filter((record) => record.function === b.id);
    expect(bPart.length).toBeGreaterThan(0);
    for (const record of summary.entries) expect(partIds.has(record.ref)).toBe(true);
    const order = unknowns.find((record) => record.reason === 'ordering-unobservable');
    expect(order?.basis).toContain(site.id);
    expect(order?.basis).toContain(b.id);
  });

  it('composeFunction without an exposed entry yields UNKNOWN and no union', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a', { visibility: 'internal' });
    s.fn(hub, 'b', { visibility: 'internal' });
    const site = s.dangling(a.id, 'function:Ghost:missing()', 'external');
    const index = s.buildIndex();
    index.relationshipsById.set(site.id, site);
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, a.id, parts);

    const marker = unknowns.find((record) => record.scope === 'composition-reentry');
    expect(marker?.reason).toBe('no_evidence');
    expect(marker?.basis).toContain(site.id);
    expect(
      summary.lineage.some((record) => record.status === 'reentry-capable'),
    ).toBe(false);
    const aPart = summary.entries.filter((record) => record.function === a.id);
    expect(aPart.length).toBeGreaterThan(0);
    for (const record of summary.entries) expect(record.function).toBe(a.id);
  });

  it('reentry-capable output is not promotable downstream', () => {
    const caller = frag([entry('condition', 'seme:acond', 'function:A', 'contract:H')]);
    const exposed = frag([entry('condition', 'seme:bcond', 'function:B', 'contract:H')]);
    const third = frag([entry('condition', 'seme:ccond', 'function:C', 'contract:H')]);
    const union = callbackReentry(caller, exposed, 'rel:out1', 'function:B');
    expect(union.status).toBe('reentry-capable');

    const downstream = callInline(union, third, 'rel:next');
    expect(downstream.status).toBe('reentry-capable');
    const last = downstream.lineage[downstream.lineage.length - 1];
    expect(last?.operator).toBe('call-inline');
    expect(last?.status).toBe('reentry-capable');
    const allowed = new Set(['seme:acond', 'seme:bcond', 'seme:ccond']);
    for (const record of downstream.entries) expect(allowed.has(record.ref)).toBe(true);
    expect(stableStringify(downstream)).toContain('reentry-capable');
  });
});

describe('cycle and bound behavior', () => {
  it('recursion terminates with a cyclic marker', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const edge = s.calls(a.id, a.id, 'internal');
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, a.id, parts);

    expect(unknowns.length).toBe(1);
    expect(unknowns[0]?.reason).toBe('cyclic');
    expect(unknowns[0]?.basis).toContain(edge.id);
    const cut = summary.lineage.find((record) => record.edge === edge.id);
    expect(cut?.operator).toBe('call-inline');
    expect(cut?.flags).toContain('cyclic');
    for (const record of summary.entries) expect(record.function).toBe(a.id);
  });

  it('depth beyond 8 is cut with bound-hit UNKNOWN and lineage', () => {
    expect(COMPOSITION_BOUND).toBe(8);
    const s = miniState();
    const hub = s.contract('Hub');
    const fns: SolidityFunction[] = [];
    for (let n = 0; n < 10; n += 1) {
      fns.push(s.fn(hub, `f${n}`));
    }
    const edges: Relationship[] = [];
    for (let n = 0; n < 9; n += 1) {
      edges.push(s.calls((fns[n] as SolidityFunction).id, (fns[n + 1] as SolidityFunction).id, 'internal'));
    }
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const first = (fns[0] as SolidityFunction).id;
    const { summary, unknowns } = composeFunction(index, first, parts);

    const cuts = unknowns.filter((record) => record.reason === 'bound-hit');
    expect(cuts.length).toBe(1);
    const cutEdge = (edges[8] as Relationship).id;
    expect(cuts[0]?.basis).toContain(cutEdge);
    const lineageCut = summary.lineage.find((record) => record.edge === cutEdge);
    expect(lineageCut?.operator).toBe('call-inline');
    expect(lineageCut?.flags).toContain('bound-hit');

    const ninth = parts.conditions.find(
      (condition) =>
        condition.function === (fns[8] as SolidityFunction).id &&
        condition.kind === 'visibility-gate',
    );
    const tenth = parts.conditions.find(
      (condition) =>
        condition.function === (fns[9] as SolidityFunction).id &&
        condition.kind === 'visibility-gate',
    );
    expect(ninth).toBeDefined();
    expect(tenth).toBeDefined();
    expect(summary.entries.some((record) => record.ref === ninth?.id)).toBe(true);
    expect(summary.entries.some((record) => record.ref === tenth?.id)).toBe(false);
    for (let n = 0; n < 8; n += 1) {
      const earlier = (edges[n] as Relationship).id;
      const hit = summary.lineage.find((record) => record.edge === earlier);
      expect(hit?.flags).not.toContain('bound-hit');
    }
  });

  it('unresolvable callee yields an UNKNOWN-target marker with the caller preserved', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const edge = s.dangling(a.id, 'function:Gone:missing()', 'internal');
    const index = s.buildIndex();
    index.relationshipsById.set(edge.id, edge);
    const parts = deriveAll(index);
    const { summary, unknowns } = composeFunction(index, a.id, parts);

    const marker = unknowns.find((record) => record.scope === 'composition-unknown-target');
    expect(marker?.reason).toBe('out_of_scope_target');
    expect(marker?.basis).toContain(edge.id);
    const aPart = summary.entries.filter((record) => record.function === a.id);
    expect(aPart.length).toBeGreaterThan(0);
  });
});

describe('composition honesty', () => {
  it('value triples compose as scaffolding only, never amounts', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b', { modifiers: ['onlyOwner'] });
    s.calls(a.id, b.id, 'internal');
    const v = s.stateVar(hub, 'vault');
    s.writes(b.id, v.id);
    const index = s.buildIndex();
    const parts = deriveAll(index);
    expect(parts.influence.length).toBeGreaterThan(0);
    const { summary } = composeFunction(index, a.id, parts);

    expect(stableStringify(summary)).not.toContain('amount');
    const influenceRefs = new Set(
      summary.entries.filter((record) => record.kind === 'influence').map((record) => record.ref),
    );
    expect(influenceRefs.size).toBeGreaterThan(0);
    for (const edge of parts.influence) {
      expect(Object.keys(edge)).not.toContain('amount');
      if (influenceRefs.has(edge.id)) {
        expect(`${edge.from}::${edge.to}`).toContain(v.id);
      }
    }
  });

  it('repeated composition is byte-identical', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    s.calls(a.id, b.id, 'internal');
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const first = composeFunction(index, a.id, parts);
    const second = composeFunction(index, a.id, parts);
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(ComposedSummarySchema.parse(first.summary)).toEqual(first.summary);
  });
});
