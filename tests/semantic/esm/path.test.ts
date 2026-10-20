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
import { compareCodeUnits } from '../../../src/util/canonical.js';
import { deriveConditions } from '../../../src/semantic/esm/conditions.js';
import { deriveInfluence } from '../../../src/semantic/esm/influence.js';
import { deriveAccesses } from '../../../src/semantic/esm/access.js';
import { deriveBoundaries } from '../../../src/semantic/esm/external.js';
import {
  PATH_HEADER,
  SemPathSchema,
  derivePaths,
  type SemPath,
} from '../../../src/semantic/esm/path.js';

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
    calls(sourceId: string, targetId: string): Relationship {
      const record = createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        metadata: { call_kind: 'internal' },
        provenance: [span('src/Hub.sol', 10)],
        created_at: CREATED_AT,
      });
      relationships.push(record);
      return record;
    },
    dangling(sourceId: string, targetId: string): Relationship {
      return createRelationship({
        type: 'CALLS',
        source_id: sourceId,
        target_id: targetId,
        metadata: { call_kind: 'external' },
        provenance: [span('src/Gone.sol', 3)],
        created_at: CREATED_AT,
      });
    },
    base(
      derivedId: string,
      baseId: string,
      type: 'INHERITS' | 'IMPLEMENTS',
    ): Relationship {
      const record = createRelationship({
        type,
        source_id: derivedId,
        target_id: baseId,
        provenance: [span('src/Derived.sol', 2)],
        created_at: CREATED_AT,
      });
      relationships.push(record);
      return record;
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

function fullParts(index: EvidenceIndex) {
  const accesses = deriveAccesses(index).accesses;
  const conditions = deriveConditions(index).conditions;
  const boundaries = deriveBoundaries(index).boundaries;
  const influence = deriveInfluence(index, { accesses, conditions, boundaries }).influence;
  return { influence, conditions };
}

function routeNodes(route: SemPath): string[] {
  return route.steps.map((step) => step.node);
}

describe('derivePaths', () => {
  it('resolved A->B->C yields a route with per-step conditions from owning functions', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    const c = s.fn(hub, 'c');
    const eAB = s.calls(a.id, b.id);
    const eBC = s.calls(b.id, c.id);
    const index = s.buildIndex();
    const { paths, unknowns } = derivePaths(index, fullParts(index));

    const route = paths.find(
      (entry) => stableStringify(routeNodes(entry)) === stableStringify([a.id, b.id, c.id]),
    );
    expect(route).toBeDefined();
    const steps = route!.steps;
    expect(steps.map((step) => step.via)).toEqual([eAB.id, eAB.id, eBC.id]);
    const parts = fullParts(index);
    for (const step of steps) {
      const gates = parts.conditions
        .filter((entry) => entry.function === step.node)
        .map((entry) => entry.id)
        .sort(compareCodeUnits);
      expect(gates.length).toBeGreaterThan(0);
      expect(step.condition.split(',')).toEqual(gates);
    }
    expect(route!.basis).toEqual(
      [eAB.id, eBC.id, ...steps.flatMap((step) => step.condition.split(','))].sort(
        compareCodeUnits,
      ),
    );
    expect(route!.header).toBe(
      'structural route only; not executable, feasible, minimal, or complete',
    );
    expect(route!.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(SemPathSchema.safeParse(route).success).toBe(true);
    expect(unknowns).toEqual([]);
  });

  it('an unresolved hop yields a terminated route with marker plus one unknown entry', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const missing = 'function:Gone:missing()';
    const hop = s.dangling(a.id, missing);
    const index = s.buildIndex();
    index.relationshipsById.set(hop.id, hop);
    const { paths, unknowns } = derivePaths(index, fullParts(index));

    const route = paths.find((entry) => routeNodes(entry).includes(missing));
    expect(route).toBeDefined();
    expect(routeNodes(route!)).toEqual([a.id, missing]);
    const terminal = route!.steps[route!.steps.length - 1]!;
    expect(terminal.via).toBe(hop.id);
    expect(terminal.condition).toBe('unknown');
    for (const entry of paths) {
      const nodes = routeNodes(entry);
      if (nodes.includes(missing)) {
        expect(nodes[nodes.length - 1]).toBe(missing);
      }
    }
    expect(unknowns).toHaveLength(1);
    const entry = unknowns[0]!;
    expect(entry.scope).toBe('path-unresolved-hop');
    expect(entry.reason).toBe('out_of_scope_target');
    expect(entry.basis).toEqual([hop.id]);
    expect(entry.id).toMatch(/^seme:[0-9a-f]{16}$/);
  });

  it('intra-function detail is absent: no route lists one function twice', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const f = s.fn(hub, 'f');
    const g = s.fn(hub, 'g');
    s.calls(f.id, f.id);
    s.calls(f.id, g.id);
    const index = s.buildIndex();
    const { paths } = derivePaths(index, fullParts(index));

    expect(paths.length).toBeGreaterThan(0);
    for (const route of paths) {
      const fnNodes = route.steps
        .map((step) => step.node)
        .filter((node) => index.functionsById.has(node));
      expect(new Set(fnNodes).size).toBe(fnNodes.length);
    }
    expect(
      paths.some(
        (route) =>
          route.steps.length === 2 &&
          route.steps[0]!.node === f.id &&
          route.steps[1]!.node === f.id,
      ),
    ).toBe(false);
  });

  it('diamond with an unknown step records both routes with no ranking', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    const c = s.fn(hub, 'c');
    const d = s.fn(hub, 'd');
    const eAB = s.calls(a.id, b.id);
    s.calls(a.id, c.id);
    s.calls(b.id, d.id);
    s.calls(c.id, d.id);
    const index = s.buildIndex();
    const all = deriveConditions(index).conditions;
    const withoutB = all.filter((entry) => entry.function !== b.id);
    const { paths, unknowns } = derivePaths(index, { influence: [], conditions: withoutB });

    const left = paths.find(
      (entry) => stableStringify(routeNodes(entry)) === stableStringify([a.id, b.id, d.id]),
    );
    const right = paths.find(
      (entry) => stableStringify(routeNodes(entry)) === stableStringify([a.id, c.id, d.id]),
    );
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    const bStep = left!.steps.find((step) => step.node === b.id)!;
    expect(bStep.condition).toBe('unknown');
    const flagged = unknowns.find(
      (entry) =>
        entry.scope === 'path-step-condition' &&
        entry.reason === 'no_evidence' &&
        stableStringify(entry.basis) === stableStringify([eAB.id]),
    );
    expect(flagged).toBeDefined();
    for (const step of right!.steps) {
      expect(step.condition).not.toBe('unknown');
    }
    const ids = paths.map((route) => route.id);
    expect([...ids].sort(compareCodeUnits)).toEqual(ids);
  });

  it('route count beyond 128 per anchor yields an explicit truncated-routes bound-hit unknown', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'hub');
    for (let n = 0; n < 129; n += 1) {
      const leaf = s.fn(hub, `leaf${n}`);
      s.calls(a.id, leaf.id);
    }
    const index = s.buildIndex();
    const { paths, unknowns } = derivePaths(index, fullParts(index));

    expect(paths).toHaveLength(128);
    const truncated = unknowns.filter((entry) => entry.scope === 'truncated-routes');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.reason).toBe('bound-hit');
    expect(truncated[0]!.basis.length).toBeGreaterThan(0);
    expect(truncated[0]!.id).toMatch(/^seme:[0-9a-f]{16}$/);
    const ids = paths.map((route) => route.id);
    expect([...ids].sort(compareCodeUnits)).toEqual(ids);
  });

  it('every emitted route carries the non-claim header verbatim', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const base = s.contract('Base');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    s.calls(a.id, b.id);
    s.base(hub.id, base.id, 'INHERITS');
    s.marker(b.id, 'DELEGATES_TO', 'unresolved-delegatecall');
    const index = s.buildIndex();
    const { paths } = derivePaths(index, fullParts(index));

    expect(paths.length).toBeGreaterThan(2);
    for (const route of paths) {
      expect(route.header).toBe(PATH_HEADER);
      expect(route.header).toBe(
        'structural route only; not executable, feasible, minimal, or complete',
      );
      expect(SemPathSchema.safeParse(route).success).toBe(true);
    }
  });

  it('a resolved inheritance base yields a contract-granularity route with unknown conditions', () => {
    const s = miniState();
    const derived = s.contract('Derived');
    const base = s.contract('Base');
    const edge = s.base(derived.id, base.id, 'INHERITS');
    const index = s.buildIndex();
    const { paths, unknowns } = derivePaths(index, fullParts(index));

    const route = paths.find(
      (entry) => stableStringify(routeNodes(entry)) === stableStringify([derived.id, base.id]),
    );
    expect(route).toBeDefined();
    expect(route!.steps.map((step) => step.via)).toEqual([edge.id, edge.id]);
    for (const step of route!.steps) {
      expect(step.condition).toBe('unknown');
    }
    expect(route!.basis).toEqual([edge.id]);
    const ledger = unknowns.find(
      (entry) =>
        entry.scope === 'path-step-condition' &&
        entry.reason === 'no_evidence' &&
        stableStringify(entry.basis) === stableStringify([edge.id]),
    );
    expect(ledger).toBeDefined();
  });

  it('a delegate marker terminates the route with a marker step plus one unresolved_call entry', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const f = s.fn(hub, 'f');
    const fact = s.marker(f.id, 'DELEGATES_TO', 'unresolved-delegatecall');
    s.marker(f.id, 'CALLS', 'not-a-marker');
    const index = s.buildIndex();
    const { paths, unknowns } = derivePaths(index, fullParts(index));

    const route = paths.find(
      (entry) => routeNodes(entry)[0] === f.id && entry.steps.length === 2,
    );
    expect(route).toBeDefined();
    expect(routeNodes(route!)).toEqual([f.id, 'unknown']);
    expect(route!.steps[1]!.via).toBe(fact.id);
    expect(route!.steps[1]!.condition).toBe('unknown');
    const ledger = unknowns.find(
      (entry) =>
        entry.scope === 'path-delegate-hop' &&
        entry.reason === 'unresolved_call' &&
        stableStringify(entry.basis) === stableStringify([fact.id]),
    );
    expect(ledger).toBeDefined();
    const serialized = stableStringify({ paths, unknowns });
    expect(serialized).not.toContain('not-a-marker');
  });

  it('a step with several gates records every applicable gate id without merging meanings', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a', { modifiers: ['onlyOwner', 'nonReentrant'] });
    const b = s.fn(hub, 'b');
    s.calls(a.id, b.id);
    const index = s.buildIndex();
    const parts = fullParts(index);
    const { paths } = derivePaths(index, parts);

    const expected = parts.conditions
      .filter((entry) => entry.function === a.id)
      .map((entry) => entry.id)
      .sort(compareCodeUnits);
    expect(expected.length).toBeGreaterThan(2);
    const route = paths.find((entry) => routeNodes(entry)[0] === a.id)!;
    const step = route.steps.find((entry) => entry.node === a.id)!;
    expect(step.condition.split(',')).toEqual(expected);
    for (const id of expected) {
      expect(parts.conditions.some((entry) => entry.id === id && entry.function === a.id)).toBe(
        true,
      );
    }
  });

  it('steps without evidenced condition use unknown plus one no_evidence entry scoped to the hop', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    const hop = s.calls(a.id, b.id);
    const index = s.buildIndex();
    const { paths, unknowns } = derivePaths(index, { influence: [], conditions: [] });

    const route = paths.find(
      (entry) => stableStringify(routeNodes(entry)) === stableStringify([a.id, b.id]),
    );
    expect(route).toBeDefined();
    for (const step of route!.steps) {
      expect(step.condition).toBe('unknown');
    }
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.scope).toBe('path-step-condition');
    expect(unknowns[0]!.reason).toBe('no_evidence');
    expect(unknowns[0]!.basis).toEqual([hop.id]);
  });

  it('influence input neither adds nor removes routes', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    s.calls(a.id, b.id);
    const index = s.buildIndex();
    const parts = fullParts(index);

    const without = derivePaths(index, { influence: [], conditions: parts.conditions });
    const withInfluence = derivePaths(index, parts);
    expect(stableStringify(withInfluence.paths)).toBe(stableStringify(without.paths));
  });

  it('same-signature functions on different contracts never link across identities', () => {
    const s = miniState();
    const left = s.contract('Left');
    const right = s.contract('Right');
    const params = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }];
    const leftFn = createFunction({
      contract_id: left.id,
      name: 'transferFrom',
      visibility: 'external' as Visibility,
      mutability: 'nonpayable' as Mutability,
      modifiers: [],
      parameters: params,
    });
    const rightFn = createFunction({
      contract_id: right.id,
      name: 'transferFrom',
      visibility: 'external' as Visibility,
      mutability: 'nonpayable' as Mutability,
      modifiers: [],
      parameters: params,
    });
    expect(leftFn.signature).toBe(rightFn.signature);
    const state = createReconState({
      contracts: [left, right],
      functions: [leftFn, rightFn],
      state_variables: [],
      relationships: [
        createRelationship({
          type: 'CALLS',
          source_id: leftFn.id,
          target_id: leftFn.id,
          metadata: { call_kind: 'internal' },
          provenance: [span('src/Left.sol', 4)],
          created_at: CREATED_AT,
        }),
      ],
      facts: [],
    });
    const index = buildEvidenceIndex({
      state,
      issues: [],
      meta: { fidelity: 'semantic', fileCount: 1 },
    });
    const { paths, unknowns } = derivePaths(index, {
      influence: [],
      conditions: deriveConditions(index).conditions,
    });

    const serialized = stableStringify({ paths, unknowns });
    expect(serialized).not.toContain(rightFn.id);
  });

  it('SemPathSchema rejects excess keys, bad headers, and empty ref lists', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    s.calls(a.id, b.id);
    const index = s.buildIndex();
    const { paths } = derivePaths(index, fullParts(index));
    const route = paths.find(
      (entry) => stableStringify(routeNodes(entry)) === stableStringify([a.id, b.id]),
    )!;

    expect(SemPathSchema.safeParse(route).success).toBe(true);
    expect(SemPathSchema.safeParse({ ...route, extra: 'field' }).success).toBe(false);
    expect(SemPathSchema.safeParse({ ...route, header: 'proven path' }).success).toBe(false);
    expect(SemPathSchema.safeParse({ ...route, steps: [] }).success).toBe(false);
    expect(SemPathSchema.safeParse({ ...route, basis: [] }).success).toBe(false);
    expect(
      SemPathSchema.safeParse({ ...route, steps: [{ node: a.id, via: 'rel:x' }] }).success,
    ).toBe(false);
  });

  it('is deterministic across runs and relationship insertion order', () => {
    const build = (swapped: boolean) => {
      const s = miniState();
      const hub = s.contract('Hub');
      const a = s.fn(hub, 'a', { modifiers: ['onlyOwner'] });
      const b = s.fn(hub, 'b');
      const c = s.fn(hub, 'c');
      if (swapped) {
        s.calls(b.id, c.id);
        s.calls(a.id, b.id);
      } else {
        s.calls(a.id, b.id);
        s.calls(b.id, c.id);
      }
      const index = s.buildIndex();
      return derivePaths(index, fullParts(index));
    };
    const forward = build(false);
    const repeat = build(false);
    expect(stableStringify(repeat)).toBe(stableStringify(forward));
    expect(stableStringify(build(true))).toBe(stableStringify(forward));
  });

  it('sorts paths and unknowns by id in code-unit order', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    const c = s.fn(hub, 'c');
    s.calls(a.id, b.id);
    s.calls(a.id, c.id);
    const stray = s.dangling(b.id, 'function:Gone:missing()');
    const index = s.buildIndex();
    index.relationshipsById.set(stray.id, stray);
    const { paths, unknowns } = derivePaths(index, fullParts(index));

    expect(paths.length).toBeGreaterThan(1);
    const ids = paths.map((route) => route.id);
    expect([...ids].sort(compareCodeUnits)).toEqual(ids);
    const unknownIds = unknowns.map((entry) => entry.id);
    expect([...unknownIds].sort(compareCodeUnits)).toEqual(unknownIds);
  });

  it('empty input yields empty output', () => {
    const s = miniState();
    const index = s.buildIndex();
    expect(derivePaths(index, { influence: [], conditions: [] })).toEqual({
      paths: [],
      unknowns: [],
    });
  });
});
