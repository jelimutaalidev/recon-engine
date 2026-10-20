import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import { deriveAccesses } from '../../../src/semantic/esm/access.js';
import { deriveConditions } from '../../../src/semantic/esm/conditions.js';
import { deriveBoundaries } from '../../../src/semantic/esm/external.js';
import { deriveTemporals } from '../../../src/semantic/esm/temporal.js';
import { deriveContexts } from '../../../src/semantic/esm/context.js';
import { deriveInfluence } from '../../../src/semantic/esm/influence.js';
import { derivePaths } from '../../../src/semantic/esm/path.js';
import {
  callbackReentry,
  composeFunction,
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
  const relationships: Relationship[] = [];
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
    buildIndex(): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: [],
        relationships,
        facts: [],
      });
      return buildEvidenceIndex({ state, issues: [], meta: { fidelity: 'semantic', fileCount: 1 } });
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

describe('E10 composition contract repair', () => {
  it('callbackReentry WITHOUT exposed entry returns NO union (empty entries) plus UNKNOWN', () => {
    const caller = frag([entry('condition', 'seme:acond', 'function:A', 'contract:H')]);
    const result = callbackReentry(caller, undefined, 'rel:out1');

    // Spec §12.1: missing entry → no union at all. Caller entries MUST NOT be returned.
    expect(result.entries).toEqual([]);
    expect(result.status).toBe('direct');
    expect(result.unknowns.length).toBe(1);
    expect(result.unknowns[0]?.reason).toBe('no_evidence');
    expect(result.unknowns[0]?.basis).toEqual(['rel:out1']);
    expect(result.lineage.length).toBe(1);
    expect(result.lineage[0]?.operator).toBe('callback-reentry');
    expect(result.lineage[0]?.flags).toEqual(['no-entry']);
    expect('entry' in (result.lineage[0] as object)).toBe(false);
  });

  it('composeFunction WITHOUT exposed entry preserves caller partition with UNKNOWN and no union', () => {
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
    expect(summary.lineage.some((record) => record.status === 'reentry-capable')).toBe(false);
    // Caller side preserved (traversal), no callee mixed in.
    const aPart = summary.entries.filter((record) => record.function === a.id);
    expect(aPart.length).toBeGreaterThan(0);
    for (const record of summary.entries) expect(record.function).toBe(a.id);
  });

  it('composeFunction A->B keeps caller AND callee contexts separable with evidence-backed ids', () => {
    const s = miniState();
    const hub = s.contract('Hub');
    const a = s.fn(hub, 'a');
    const b = s.fn(hub, 'b');
    s.calls(a.id, b.id, 'internal');
    const index = s.buildIndex();
    const parts = deriveAll(index);
    const partIds = new Set(parts.contexts.map((record) => record.id));
    const { summary } = composeFunction(index, a.id, parts);

    // §12.7: caller and callee contexts recorded SEPARATELY, never collapsed to one.
    expect(summary.contexts.length).toBeGreaterThanOrEqual(2);
    const ids = summary.contexts.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No synthetic context ids: every summary context must exist in parts.contexts.
    for (const id of ids) expect(partIds.has(id)).toBe(true);
    // Caller view and callee view distinguishable: entry-A chain [A] plus
    // an independent callee-entry context (§12.7 SEPARATELY, never collapsed).
    const chains = summary.contexts.map((record) => record.chain.join('>'));
    expect(chains).toContain(a.id);
    const calleeEntry = summary.contexts.filter((record) => record.entry === b.id);
    expect(calleeEntry.length).toBeGreaterThanOrEqual(1);
  });
});
