import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, StateVisibility, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../../src/domain/state-variable.js';
import type { Fact } from '../../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../../src/recon/issues.js';
import { createRelationship, type Relationship } from '../../../src/relationships/relationship.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { compareCodeUnits } from '../../../src/util/canonical.js';
import { deriveEsm } from '../../../src/semantic/esm/pipeline.js';
import {
  deriveAccesses,
  finalizeEsm,
  serializeEsm,
  computeEsmHash,
  EsmArtifactSchema,
  type EsmArtifact,
} from '../../../src/semantic/esm/index.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';
const BUILTIN_MESSAGE = 'msg./block./tx. builtins are not modeled';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const stateVariables: StateVariable[] = [];
  const relationships: Relationship[] = [];
  const facts: Fact[] = [];
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
      options: { modifiers?: string[]; source?: string } = {},
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: 'external' as Visibility,
        mutability: 'nonpayable' as Mutability,
        modifiers: options.modifiers ?? [],
        ...(options.source !== undefined ? { source: options.source } : {}),
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
    builtinIssue(file: string, lineStart: number, lineEnd = lineStart): void {
      issues.push({
        severity: 'UNSUPPORTED',
        code: 'unsupported_builtin',
        message: BUILTIN_MESSAGE,
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
        facts,
      });
      return buildEvidenceIndex({
        state,
        issues,
        meta: { fidelity: 'semantic', fileCount: 1 },
      });
    },
  };
}

function vaultIndex(): EvidenceIndex {
  const s = miniState();
  const vault = s.contract('Vault');
  const deposit = s.fn(vault, 'deposit', {
    modifiers: ['onlyOwner'],
    source: 'src/Vault.sol:10-30',
  });
  const withdraw = s.fn(vault, 'withdraw', { source: 'src/Vault.sol:40-60' });
  const payout = s.fn(vault, 'payout', { source: 'src/Vault.sol:70-90' });
  const totalAssets = s.stateVar(vault, 'totalAssets');
  s.rel('WRITES', deposit.id, totalAssets.id, [span('src/Vault.sol', 12)]);
  s.rel('READS', withdraw.id, totalAssets.id, [span('src/Vault.sol', 42)]);
  s.rel('CALLS', deposit.id, withdraw.id, [span('src/Vault.sol', 15)], {
    call_kind: 'internal',
  });
  const ghostCall = s.looseRel('CALLS', withdraw.id, 'function:Vault:ghost', [span('src/Vault.sol', 45)], {
    call_kind: 'external',
  });
  const missingRead = s.looseRel('READS', payout.id, 'state:Vault:missing', [span('src/Vault.sol', 72)]);
  s.builtinIssue('src/Vault.sol', 75);
  const index = s.buildIndex();
  index.relationshipsById.set(ghostCall.id, ghostCall);
  index.relationshipsById.set(missingRead.id, missingRead);
  return index;
}

function collectIntakeIds(index: EvidenceIndex): Set<string> {
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

function collectLabelFragments(index: EvidenceIndex): string[] {
  const fragments: string[] = [];
  for (const bucket of index.issuesByFile.values()) {
    for (const issue of bucket) {
      fragments.push(issue.code);
      if (issue.file !== undefined) fragments.push(issue.file);
    }
  }
  for (const fact of index.factsById.values()) {
    if (typeof fact.value === 'string' && fact.value.length > 0) fragments.push(fact.value);
  }
  return fragments;
}

function sortedCopy(ids: string[]): string[] {
  return [...ids].sort(compareCodeUnits);
}

describe('deriveEsm — end-to-end pipeline', () => {
  it('produces a schema-valid artifact whose counts match array lengths', () => {
    const artifact = deriveEsm(vaultIndex());
    expect(EsmArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifact.schema_version).toBe('esem-model/v1');
    expect(artifact.counts).toEqual({
      influences: artifact.influences.length,
      conditions: artifact.conditions.length,
      paths: artifact.paths.length,
      contexts: artifact.contexts.length,
      accesses: artifact.accesses.length,
      boundaries: artifact.boundaries.length,
      temporals: artifact.temporals.length,
      unknowns: artifact.unknowns.length,
    });
  });

  it('emits every id-bearing array in code-unit id order', () => {
    const artifact = deriveEsm(vaultIndex());
    const arrays: Array<{ name: string; ids: string[] }> = [
      { name: 'influences', ids: artifact.influences.map((r) => r.id) },
      { name: 'conditions', ids: artifact.conditions.map((r) => r.id) },
      { name: 'paths', ids: artifact.paths.map((r) => r.id) },
      { name: 'contexts', ids: artifact.contexts.map((r) => r.id) },
      { name: 'accesses', ids: artifact.accesses.map((r) => r.id) },
      { name: 'boundaries', ids: artifact.boundaries.map((r) => r.id) },
      { name: 'temporals', ids: artifact.temporals.map((r) => r.id) },
      { name: 'unknowns', ids: artifact.unknowns.map((r) => r.id) },
    ];
    for (const { name, ids } of arrays) {
      expect(sortedCopy(ids), name).toEqual(ids);
    }
  });

  it('is byte-identical across a double run and the attached hash recomputes', () => {
    const first = deriveEsm(vaultIndex());
    const second = deriveEsm(vaultIndex());
    expect(serializeEsm(second)).toBe(serializeEsm(first));
    expect(computeEsmHash(first)).toBe(first.esem_hash);
    expect(first.esem_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('echoes intake identity in inputs without inventing scope binding', () => {
    const index = vaultIndex();
    const artifact = deriveEsm(index);
    expect(artifact.inputs.state_output_hash).toBe(index.stateHash);
    expect(artifact.inputs.fidelity).toBe('semantic');
    expect(artifact.inputs.file_count).toBe(1);
    expect(artifact.inputs.scope_hash).toBeUndefined();
  });

  it('UNKNOWN-heavy input yields an UNKNOWN-rich artifact and never forced concrete', () => {
    const artifact = deriveEsm(vaultIndex());
    expect(artifact.unknowns.length).toBeGreaterThanOrEqual(3);
    const unknownAccess = artifact.accesses.find((r) => r.location === 'unknown');
    expect(unknownAccess).toBeDefined();
    const unknownTarget = artifact.boundaries.find((r) => r.target === 'unknown');
    expect(unknownTarget).toBeDefined();
    expect(unknownTarget?.result).toBe('unknown');
    expect(unknownTarget?.returnLink).toBe('unknown');
    const unknownKind = artifact.temporals.find((r) => r.kind === 'UNKNOWN-kind');
    expect(unknownKind).toBeDefined();
    expect(artifact.temporals.every((r) => r.kind === 'UNKNOWN-kind')).toBe(true);
  });

  it('every emitted basis entry resolves to intake ids, intake labels, or artifact ids', () => {
    const index = vaultIndex();
    const artifact: EsmArtifact = deriveEsm(index);
    const intakeIds = collectIntakeIds(index);
    const labelFragments = collectLabelFragments(index);
    const artifactIds = new Set<string>();
    for (const record of [
      ...artifact.influences,
      ...artifact.conditions,
      ...artifact.paths,
      ...artifact.contexts,
      ...artifact.accesses,
      ...artifact.boundaries,
      ...artifact.temporals,
      ...artifact.unknowns,
    ]) {
      artifactIds.add(record.id);
    }
    const records: Array<{ id: string; basis: readonly string[] }> = [
      ...artifact.influences,
      ...artifact.conditions,
      ...artifact.paths,
      ...artifact.contexts,
      ...artifact.accesses,
      ...artifact.boundaries,
      ...artifact.temporals,
      ...artifact.unknowns,
    ];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.basis.length, `${record.id} basis non-empty`).toBeGreaterThan(0);
      for (const entry of record.basis) {
        const resolved =
          intakeIds.has(entry) ||
          artifactIds.has(entry) ||
          labelFragments.some((fragment) => entry.includes(fragment));
        expect(resolved, `${record.id} basis entry resolves: ${entry}`).toBe(true);
      }
    }
  });

  it('serialized bytes carry no forbidden vocabulary', () => {
    const bytes = serializeEsm(deriveEsm(vaultIndex())).toLowerCase();
    for (const token of [
      'vulnerable',
      'exploit',
      'severity',
      'critical',
      'finding',
      'attack',
      'poc',
      'confirmed',
    ]) {
      expect(bytes, `forbidden token ${token}`).not.toContain(token);
    }
  });

  it('a bare contract and function still finalize to a schema-valid artifact', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'deposit');
    const artifact = deriveEsm(s.buildIndex());
    expect(EsmArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifact.counts.unknowns).toBe(artifact.unknowns.length);
    expect(computeEsmHash(artifact)).toBe(artifact.esem_hash);
  });

  it('barrel re-exports the pipeline alongside the primitives', () => {
    expect(typeof deriveEsm).toBe('function');
    expect(typeof deriveAccesses).toBe('function');
    expect(typeof finalizeEsm).toBe('function');
    expect(typeof serializeEsm).toBe('function');
    expect(typeof computeEsmHash).toBe('function');
  });
});
