import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, StateVisibility, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../../src/domain/state-variable.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../../src/recon/issues.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { compareCodeUnits, stableStringify } from '../../../src/util/canonical.js';
import { deriveEsm } from '../../../src/semantic/esm/pipeline.js';
import { deriveCompositions } from '../../../src/semantic/esm/pipeline.js';
import {
  computeEsmHash,
  serializeEsm,
  type EsmArtifact,
} from '../../../src/semantic/esm/index.js';
import { deriveAccesses } from '../../../src/semantic/esm/access.js';
import { deriveBoundaries } from '../../../src/semantic/esm/external.js';
import { deriveTemporals } from '../../../src/semantic/esm/temporal.js';
import { deriveConditions } from '../../../src/semantic/esm/conditions.js';
import { deriveContexts } from '../../../src/semantic/esm/context.js';
import { deriveInfluence } from '../../../src/semantic/esm/influence.js';
import { derivePaths } from '../../../src/semantic/esm/path.js';

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
    fn(contract: Contract, name: string, visibility: Visibility = 'external' as Visibility): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility,
        mutability: 'nonpayable' as Mutability,
        modifiers: [],
      });
      functions.push(record);
      return record;
    },
    stateVar(contract: Contract, name: string): StateVariable {
      const record = createStateVariable({
        contract_id: contract.id,
        name,
        type: 'uint256',
        visibility: 'public' as StateVisibility,
      });
      stateVariables.push(record);
      return record;
    },
    rel(
      type: Relationship['type'],
      sourceId: string,
      targetId: string,
      provenance: ProvenanceInput[],
      metadata?: Record<string, string>,
    ): Relationship {
      const record = createRelationship({
        type,
        source_id: sourceId,
        target_id: targetId,
        provenance,
        ...(metadata !== undefined ? { metadata } : {}),
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
      metadata?: Record<string, string>,
    ): Relationship {
      return createRelationship({
        type,
        source_id: sourceId,
        target_id: targetId,
        provenance,
        ...(metadata !== undefined ? { metadata } : {}),
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
      return buildEvidenceIndex({ state, issues, meta: { fidelity: 'semantic', fileCount: 1 } });
    },
  };
}

function vaultIndex(): EvidenceIndex {
  const s = miniState();
  const vault = s.contract('Vault');
  const deposit = s.fn(vault, 'deposit');
  const withdraw = s.fn(vault, 'withdraw');
  const totalAssets = s.stateVar(vault, 'totalAssets');
  s.rel('WRITES', deposit.id, totalAssets.id, [span('src/Vault.sol', 12)]);
  s.rel('READS', withdraw.id, totalAssets.id, [span('src/Vault.sol', 42)]);
  s.rel('CALLS', deposit.id, withdraw.id, [span('src/Vault.sol', 15)], { call_kind: 'internal' });
  return s.buildIndex();
}

function reentryIndex(): EvidenceIndex {
  const s = miniState();
  const hub = s.contract('Hub');
  const a = s.fn(hub, 'a', 'internal' as Visibility);
  s.fn(hub, 'b', 'internal' as Visibility);
  const site = s.looseRel('CALLS', a.id, 'function:Ghost:missing()', [span('src/Hub.sol', 10)], {
    call_kind: 'external',
  });
  const index = s.buildIndex();
  index.relationshipsById.set(site.id, site);
  return index;
}

function intakeIds(index: EvidenceIndex): Set<string> {
  const ids = new Set<string>();
  for (const map of [
    index.relationshipsById,
    index.factsById,
    index.functionsById,
    index.contractsById,
    index.stateVariablesById,
    index.provenanceById,
  ] as Array<Map<string, { id: string }>>) {
    for (const id of map.keys()) ids.add(id);
  }
  return ids;
}

function primitiveIds(index: EvidenceIndex): Set<string> {
  const accesses = deriveAccesses(index).accesses;
  const conditions = deriveConditions(index).conditions;
  const boundaries = deriveBoundaries(index).boundaries;
  const temporals = deriveTemporals(index).temporals;
  const contexts = deriveContexts(index).contexts;
  const influence = deriveInfluence(index, { accesses, conditions, boundaries }).influence;
  const paths = derivePaths(index, { influence, conditions }).paths;
  return new Set(
    [...accesses, ...conditions, ...boundaries, ...temporals, ...contexts, ...influence, ...paths].map(
      (record) => record.id,
    ),
  );
}

describe('deriveCompositions — §12.8 transient output', () => {
  it('exposes one summary per function, owner-sorted, with id-sorted unknowns', () => {
    const index = reentryIndex();
    const { summaries, unknowns } = deriveCompositions(index);
    expect(summaries.length).toBe(index.functionsById.size);
    const owners = summaries.map((s) => `${s.owner.function}::${s.owner.contract}`);
    expect([...owners].sort(compareCodeUnits)).toEqual(owners);
    const ids = unknowns.map((u) => u.id);
    expect([...ids].sort(compareCodeUnits)).toEqual(ids);
  });

  it('is byte-identical across a repeated transient run', () => {
    const first = stableStringify(deriveCompositions(vaultIndex()));
    const second = stableStringify(deriveCompositions(vaultIndex()));
    expect(second).toBe(first);
  });

  it('leaves full artifact bytes identical under the four specified call orderings', () => {
    const bytesEE = serializeEsm(deriveEsm(vaultIndex()));
    const i2 = vaultIndex();
    deriveCompositions(i2);
    const bytesCE = serializeEsm(deriveEsm(i2));
    const i3 = vaultIndex();
    deriveEsm(i3);
    deriveCompositions(i3);
    const bytesECE = serializeEsm(deriveEsm(i3));
    const i4 = vaultIndex();
    deriveCompositions(i4);
    deriveCompositions(i4);
    const bytesCC = serializeEsm(deriveEsm(i4));
    expect(bytesCE).toBe(bytesEE);
    expect(bytesECE).toBe(bytesEE);
    expect(bytesCC).toBe(bytesEE);
  });

  it('keeps deriveEsm byte-identical with hash recompute (full bytes, not hash alone)', () => {
    const artifact: EsmArtifact = deriveEsm(vaultIndex());
    expect(serializeEsm(deriveEsm(vaultIndex()))).toBe(serializeEsm(artifact));
    expect(computeEsmHash(artifact)).toBe(artifact.esem_hash);
  });

  it('transient unknowns equal the artifact composed-unknown id-set with valid basis', () => {
    const index = reentryIndex();
    const { unknowns } = deriveCompositions(index);
    expect(unknowns.length).toBeGreaterThan(0);
    const artifact = deriveEsm(index);
    const acc = deriveAccesses(index);
    const con = deriveConditions(index);
    const bou = deriveBoundaries(index);
    const inf = deriveInfluence(index, {
      accesses: acc.accesses,
      conditions: con.conditions,
      boundaries: bou.boundaries,
    });
    const pat = derivePaths(index, { influence: inf.influence, conditions: con.conditions });
    const primitiveUnknownIds = new Set([
      ...acc.unknowns,
      ...bou.unknowns,
      ...deriveTemporals(index).unknowns,
      ...con.unknowns,
      ...deriveContexts(index).unknowns,
      ...inf.unknowns,
      ...pat.unknowns,
    ].map((u) => u.id));
    const composedInArtifact = artifact.unknowns.filter((u) => !primitiveUnknownIds.has(u.id));
    // §12.8(1)/(2c): strict id-set equality of the composed subset (both directions).
    expect(new Set(unknowns.map((u) => u.id))).toEqual(new Set(composedInArtifact.map((u) => u.id)));
    for (const unknown of unknowns) {
      expect(unknown.basis.length).toBeGreaterThan(0);
    }
  });

  it('summary references resolve to evidence-backed ids; no synthetic ids', () => {
    const index = reentryIndex();
    const { summaries } = deriveCompositions(index);
    const prims = primitiveIds(index);
    const contextIds = new Set(deriveContexts(index).contexts.map((c) => c.id));
    const allowed = new Set([...intakeIds(index)]);
    for (const fn of index.functionsById.values()) {
      for (const modifier of fn.modifiers) allowed.add(modifier);
    }
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      for (const entry of summary.entries) {
        expect(prims.has(entry.ref), `entry ref resolves: ${entry.ref}`).toBe(true);
      }
      for (const context of summary.contexts) {
        expect(contextIds.has(context.id), `context id backed: ${context.id}`).toBe(true);
      }
      for (const record of summary.lineage) {
        if (record.edge !== undefined) {
          expect(allowed.has(record.edge), `lineage edge backed: ${record.edge}`).toBe(true);
        }
        if (record.entry !== undefined) {
          expect(allowed.has(record.entry), `lineage entry backed: ${record.entry}`).toBe(true);
        }
        if (record.owner !== undefined) {
          expect(allowed.has(record.owner), `lineage owner backed: ${record.owner}`).toBe(true);
        }
      }
    }
  });
});
