import { describe, expect, it } from 'vitest';
import { buildVaultState } from '../../fixtures/vault.js';
import type { Provenance } from '../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import type { ReconState } from '../../src/recon-state/schema.js';
import { createReconState } from '../../src/recon-state/state.js';
import {
  buildEvidenceIndex,
  resolveProvenanceCopy,
  type SemanticInput,
} from '../../src/semantic/evidence.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';

const RUN_ID = 'run:vault-1';
const RUN_MANIFEST = 'manifest-hash-vault-1';

function vaultInput(issues: ReconIssue[] = []): SemanticInput {
  return {
    state: createReconState(structuredClone(buildVaultState())),
    issues,
    meta: { fidelity: 'semantic', fileCount: 1 },
  };
}

function vaultStateWithRun(): ReconState {
  const base = createReconState(structuredClone(buildVaultState()));
  const outputHash = computeOutputIdentity(base).output_hash;
  const run = (id: string, inputManifestHash: string, outputHashValue: string) => ({
    id,
    project_id: 'project:acmevault',
    schema_version: 'recon-state/v1',
    analyzer_version: '0.8.37',
    started_at: '2024-01-01T00:00:00.000Z',
    status: 'COMPLETED' as const,
    source_identity: { source_hash: 'a'.repeat(64), manifest_hash: 'b'.repeat(64) },
    compiler_identity: { compiler: 'solc', version: '0.8.37', backend: 'solc-js' },
    configuration_identity: { config_hash: '{}' },
    input_manifest_hash: inputManifestHash,
    output_identity: { output_hash: outputHashValue, serialization: 'recon-state-json/v1' },
  });
  return createReconState({
    ...structuredClone(buildVaultState()),
    traceability: {
      runs: [run('run:decoy', 'decoy-manifest', 'f'.repeat(64)), run(RUN_ID, RUN_MANIFEST, outputHash)],
      derivations: [
        {
          id: 'derivation:vault-1:extract',
          run_id: RUN_ID,
          operation: 'extract',
          operation_version: '1',
          inputs: [{ entity_type: 'source_file', entity_id: 'src/Vault.sol' }],
          outputs: [
            { entity_type: 'contract', entity_id: base.contracts[0]!.id },
            { entity_type: 'function', entity_id: base.functions[0]!.id },
            { entity_type: 'state_variable', entity_id: base.state_variables[0]!.id },
            { entity_type: 'relationship', entity_id: base.relationships[0]!.id },
            { entity_type: 'fact', entity_id: base.facts[0]!.id },
          ],
          provenance: [],
          status: 'COMPLETED' as const,
        },
      ],
      outputs: [],
    },
  });
}

describe('buildEvidenceIndex', () => {
  it('indexes every fact, relationship, function, contract, and state variable by id', () => {
    const input = vaultInput();
    const { state } = input;
    const index = buildEvidenceIndex(input);

    expect(state.facts.length).toBeGreaterThanOrEqual(1);
    expect(state.relationships.length).toBeGreaterThanOrEqual(1);
    expect(state.functions.length).toBeGreaterThanOrEqual(1);
    expect(state.contracts.length).toBeGreaterThanOrEqual(1);
    expect(state.state_variables.length).toBeGreaterThanOrEqual(1);
    expect(state.provenance.length).toBeGreaterThanOrEqual(1);

    expect(index.factsById.size).toBe(state.facts.length);
    expect(index.relationshipsById.size).toBe(state.relationships.length);
    expect(index.functionsById.size).toBe(state.functions.length);
    expect(index.contractsById.size).toBe(state.contracts.length);
    expect(index.stateVariablesById.size).toBe(state.state_variables.length);
    expect(index.provenanceById.size).toBe(state.provenance.length);

    const fact = state.facts[0]!;
    const contract = state.contracts[0]!;
    const fn = state.functions[0]!;
    const stateVariable = state.state_variables[0]!;
    const relationship = state.relationships[0]!;
    expect(index.factsById.get(fact.id)).toBe(fact);
    expect(index.contractsById.get(contract.id)).toBe(contract);
    expect(index.functionsById.get(fn.id)).toBe(fn);
    expect(index.stateVariablesById.get(stateVariable.id)).toBe(stateVariable);
    expect(index.relationshipsById.get(relationship.id)).toBe(relationship);
    expect(index.provenanceById.get(state.provenance[0]!.id)).toBe(state.provenance[0]);

    expect(index.input).toBe(input);
  });

  it('builds a graph index over the state relationships', () => {
    const input = vaultInput();
    const index = buildEvidenceIndex(input);
    const fact = input.state.facts[0]!;
    const relationship = input.state.relationships[0]!;

    expect(index.graph.getRelationshipsFrom(relationship.source_id)).toEqual([relationship]);
    expect(index.graph.findRelationshipsByType('WRITES')).toEqual([relationship]);
    expect(index.graph.getRelationshipsTo(fact.object_id!)).toEqual([relationship]);
  });

  it('stateHash equals computeOutputIdentity(state).output_hash', () => {
    const input = vaultInput();
    const index = buildEvidenceIndex(input);
    expect(index.stateHash).toBe(computeOutputIdentity(input.state).output_hash);
  });

  it('does not mutate state or issues bytes during intake and a sample derive call (OD-2)', () => {
    const input = vaultInput([
      {
        severity: 'RECOVERABLE',
        code: 'call_target_unresolved',
        message: 'unresolved target',
        file: 'src/Vault.sol',
        line_start: 1,
        line_end: 2,
      },
    ]);
    const stateBefore = JSON.stringify(input.state);
    const issuesBefore = JSON.stringify(input.issues);

    const index = buildEvidenceIndex(input);
    const fact = input.state.facts[0]!;
    expect(resolveProvenanceCopy(index, structuredClone(fact.provenance[0]!))).toBe(true);
    expect(index.graph.getRelationshipsFrom(fact.subject_id).length).toBeGreaterThanOrEqual(1);

    expect(JSON.stringify(input.state)).toBe(stateBefore);
    expect(JSON.stringify(input.issues)).toBe(issuesBefore);
    expect(index.input.state).toBe(input.state);
    expect(index.input.issues).toBe(input.issues);
  });

  it('currentRun is absent for the vault fixture (no traceability)', () => {
    const input = vaultInput();
    expect(input.state.traceability).toBeUndefined();

    const index = buildEvidenceIndex(input);
    expect(index.currentRun).toBeUndefined();
    expect('currentRun' in index).toBe(false);
  });

  it('currentRun resolves the run whose output_identity matches stateHash (mirrors validate.ts lookup)', () => {
    const state = vaultStateWithRun();
    const input: SemanticInput = {
      state,
      issues: [],
      meta: { fidelity: 'semantic', fileCount: 1 },
    };
    const index = buildEvidenceIndex(input);

    expect(index.stateHash).toBe(computeOutputIdentity(state).output_hash);
    expect(index.currentRun).toEqual({ run_id: RUN_ID, input_manifest_hash: RUN_MANIFEST });
  });

  it('groups issues by file in input order and keys fileless issues under the empty string', () => {
    const issues: ReconIssue[] = [
      { severity: 'RECOVERABLE', code: 'a', message: 'm1', file: 'src/A.sol', line_start: 1, line_end: 1 },
      { severity: 'UNKNOWN', code: 'b', message: 'm2' },
      { severity: 'RECOVERABLE', code: 'c', message: 'm3', file: 'src/A.sol', line_start: 2, line_end: 2 },
      { severity: 'FATAL', code: 'd', message: 'm4', file: 'src/B.sol', line_start: 1, line_end: 3 },
    ];
    const index = buildEvidenceIndex(vaultInput(issues));

    expect([...index.issuesByFile.keys()]).toEqual(['src/A.sol', '', 'src/B.sol']);
    expect(index.issuesByFile.get('src/A.sol')!.map((issue) => issue.code)).toEqual(['a', 'c']);
    expect(index.issuesByFile.get('')!.map((issue) => issue.code)).toEqual(['b']);
    expect(index.issuesByFile.get('src/B.sol')!.map((issue) => issue.code)).toEqual(['d']);
    const grouped = [...index.issuesByFile.values()].reduce((total, list) => total + list.length, 0);
    expect(grouped).toBe(issues.length);
  });
});

describe('resolveProvenanceCopy', () => {
  it('accepts byte-identical copies from the registry, facts, and relationships (§12.3)', () => {
    const input = vaultInput();
    const index = buildEvidenceIndex(input);
    const fact = input.state.facts[0]!;
    const relationship = input.state.relationships[0]!;

    for (const record of input.state.provenance) {
      expect(resolveProvenanceCopy(index, structuredClone(record))).toBe(true);
    }
    expect(resolveProvenanceCopy(index, structuredClone(fact.provenance[0]!))).toBe(true);
    expect(resolveProvenanceCopy(index, structuredClone(relationship.provenance[0]!))).toBe(true);
  });

  it('rejects a record with a mutated line number and an invented record (SINV-4 substrate)', () => {
    const input = vaultInput();
    const index = buildEvidenceIndex(input);
    const embedded = input.state.facts[0]!.provenance[0]!;

    const mutated: Provenance = { ...embedded, line_start: 777 };
    expect(resolveProvenanceCopy(index, mutated)).toBe(false);

    const invented: Provenance = {
      id: 'prov:0000000000000000',
      source_type: 'source_code',
      file: 'src/Vault.sol',
      line_start: 1,
      line_end: 2,
    };
    expect(resolveProvenanceCopy(index, invented)).toBe(false);
  });
});
