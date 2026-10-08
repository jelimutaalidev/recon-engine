import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVaultState } from '../../fixtures/vault.js';
import { isReconError, ReconError } from '../../src/errors/errors.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import type { AnalysisResult } from '../../src/recon/index.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import { createReconState } from '../../src/recon-state/state.js';
import type { ReconState } from '../../src/recon-state/schema.js';
import { analyzeProjectSemantic } from '../../src/semantic/analyze.js';
import * as transitionsModule from '../../src/semantic/transitions.js';
import * as validateModule from '../../src/semantic/validate.js';
import { validateSemanticModel } from '../../src/semantic/validate.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import { compareCodeUnits, stableStringify } from '../../src/util/canonical.js';

const TIMESTAMP = '2026-01-01T00:00:00Z';
const PROJECT_NAME = 'semantic-wrapper-fixture';

const roots: string[] = [];

function vaultState(): ReconState {
  return createReconState(structuredClone(buildVaultState()));
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
      runs: [run('run:decoy', 'decoy-manifest', 'f'.repeat(64)), run('run:vault-1', 'manifest-hash-vault-1', outputHash)],
      derivations: [
        {
          id: 'derivation:vault-1:extract',
          run_id: 'run:vault-1',
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

function fakeAnalysis(
  state: ReconState,
  overrides: { fidelity?: 'semantic' | 'syntactic'; fileCount?: number; issues?: ReconIssue[] } = {},
): AnalysisResult {
  return {
    state,
    issues: overrides.issues ?? [],
    meta: {
      solcLongVersion: '0.8.37',
      timestamp: TIMESTAMP,
      fidelity: overrides.fidelity ?? 'semantic',
      fileCount: overrides.fileCount ?? 1,
    },
  };
}

function configWithVaultFile(): ReconConfig {
  const root = mkdtempSync(join(tmpdir(), 'recon-semantic-'));
  roots.push(root);
  const vaultPath = join(root, 'src', 'Vault.sol');
  mkdirSync(dirname(vaultPath), { recursive: true });
  writeFileSync(vaultPath, '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Vault {}');
  return parseReconConfig({ root, recordGit: false, timestamp: TIMESTAMP, projectName: PROJECT_NAME });
}

function dummyConfig(): ReconConfig {
  const root = mkdtempSync(join(tmpdir(), 'recon-semantic-dummy-'));
  roots.push(root);
  return parseReconConfig({ root, recordGit: false, timestamp: TIMESTAMP, projectName: PROJECT_NAME });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('analyzeProjectSemantic — happy path (vault fixture, no scope)', () => {
  it('returns semantic-model/v1 with byte-identical analysis.state', async () => {
    const state = vaultState();
    const before = stableStringify(state);
    const config = dummyConfig();
    const { analysis, scopeReport, semantic } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(semantic.schema_version).toBe('semantic-model/v1');
    expect(scopeReport).toBeUndefined();
    expect(stableStringify(analysis.state)).toBe(before);
    expect(stableStringify(state)).toBe(before);
    expect(semantic.input.state_output_hash).toBe(computeOutputIdentity(state).output_hash);
    expect(() => validateSemanticModel(semantic, { state })).not.toThrow();
  });

  it('is read-only: stableStringify(analysis.state) identical before/after', async () => {
    const state = vaultState();
    const before = stableStringify(analysis_state(state));
    const config = dummyConfig();
    const { analysis } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(stableStringify(analysis.state)).toBe(before);
    function analysis_state(s: ReconState): ReconState { return s; }
  });

  it('double-run byte-identity: same inputs yield same semantic bytes and hash', async () => {
    const config = dummyConfig();
    const firstState = vaultState();
    const secondState = vaultState();
    const first = await analyzeProjectSemantic(config, {}, { analyze: async () => fakeAnalysis(firstState) });
    const second = await analyzeProjectSemantic(config, {}, { analyze: async () => fakeAnalysis(secondState) });
    expect(stableStringify(second.semantic)).toBe(stableStringify(first.semantic));
    expect(second.semantic.semantic_hash).toBe(first.semantic.semantic_hash);
  });
});

describe('analyzeProjectSemantic — withScope composition', () => {
  it('scopeReport present, binding.scope_hash matches, run_id present with current run', async () => {
    const state = vaultStateWithRun();
    const config = configWithVaultFile();
    const { analysis, scopeReport, semantic } = await analyzeProjectSemantic(config, { withScope: true }, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(scopeReport).toBeDefined();
    expect(scopeReport!.schema_version).toBe('scope-report/v1');
    expect(semantic.binding.scope_hash).toBe(scopeReport!.scope_hash);
    expect(semantic.binding.run_id).toBe('run:vault-1');
    expect(semantic.binding.input_manifest_hash).toBe('manifest-hash-vault-1');
    expect(stableStringify(analysis.state)).toBe(stableStringify(state));
    expect(() => validateSemanticModel(semantic, { state, scopeReport })).not.toThrow();
  });

  it('binding.run_id absent without current run (no scope)', async () => {
    const state = vaultState();
    expect(state.traceability).toBeUndefined();
    const config = dummyConfig();
    const { semantic } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(semantic.binding.run_id).toBeUndefined();
    expect(semantic.binding.scope_hash).toBeUndefined();
  });

  it('withScope without current run rethrows scope InvalidScopeReport (scope validation precedes semantic)', async () => {
    const state = vaultState();
    expect(state.traceability).toBeUndefined();
    const config = configWithVaultFile();
    let caught: unknown;
    try {
      await analyzeProjectSemantic(config, { withScope: true }, {
        analyze: async () => fakeAnalysis(state),
      });
    } catch (error) {
      caught = error;
    }
    expect(isReconError(caught)).toBe(true);
    expect((caught as ReconError).code).toBe('InvalidScopeReport');
  });

  it('UNRESOLVED scope entry yields PARTIAL with sorted degradation note', async () => {
    const state = vaultStateWithRun();
    const config = configWithVaultFile();
    const issues: ReconIssue[] = [
      { severity: 'UNKNOWN', code: 'unresolved-import', message: 'unresolved import in Vault', file: 'src/Vault.sol', line_start: 1, line_end: 1 },
    ];
    const { scopeReport, semantic } = await analyzeProjectSemantic(config, { withScope: true }, {
      analyze: async () => fakeAnalysis(state, { issues }),
    });
    expect(scopeReport!.entries.some((e) => e.status === 'UNRESOLVED')).toBe(true);
    expect(semantic.status).toBe('PARTIAL');
    expect(semantic.input.degradation !== undefined && semantic.input.degradation.length >= 1).toBe(true);
    const sorted = [...semantic.input.degradation!].sort(compareCodeUnits);
    expect(semantic.input.degradation).toEqual(sorted);
    expect(() => validateSemanticModel(semantic, { state, scopeReport })).not.toThrow();
  });
});

describe('analyzeProjectSemantic — analysis errors rethrow unchanged (OD-7)', () => {
  it('ReconError from analyze rethrows identical object, no envelope', async () => {
    const original = new ReconError('CompilationFailed', 'boom', { marker: 'x' });
    const config = dummyConfig();
    let caught: unknown;
    try {
      await analyzeProjectSemantic(config, {}, {
        analyze: async () => { throw original; },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(isReconError(caught)).toBe(true);
  });

  it('withScope analysis failure rethrows with scope_report, never a COMPLETE artifact', async () => {
    const original = new ReconError('CompilationFailed', 'no source survived compilation', {
      issues: [],
      dropped: [],
    });
    const config = configWithVaultFile();
    let caught: unknown;
    try {
      await analyzeProjectSemantic(config, { withScope: true }, {
        analyze: async () => { throw original; },
      });
    } catch (error) {
      caught = error;
    }
    expect(isReconError(caught)).toBe(true);
    expect((caught as ReconError).code).toBe('CompilationFailed');
    expect((caught as ReconError).details.scope_report).toBeDefined();
  });
});

describe('analyzeProjectSemantic — semantic-pass failure envelope (OD-7)', () => {
  it('derivation throws maps to FAILED envelope with code/stage only, empty layers, valid SINV-1/14', async () => {
    const state = vaultState();
    const config = dummyConfig();
    const boom = new ReconError('InvalidSemanticModel', 'boom', { reason: 'basis_missing' });
    vi.spyOn(transitionsModule, 'deriveTransitions').mockImplementation(() => { throw boom; });
    const { analysis, semantic } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(semantic.status).toBe('FAILED');
    expect(semantic.failure!.code).toBe('InvalidSemanticModel');
    expect(semantic.failure!.stage).toBe('transitions');
    expect(Object.keys(semantic.failure!).sort()).toEqual(['code', 'stage']);
    expect(semantic.contracts).toEqual([]);
    expect(semantic.transitions).toEqual([]);
    expect(semantic.assets).toEqual([]);
    expect(semantic.custody).toEqual([]);
    expect(semantic.claims).toEqual([]);
    expect(semantic.accounting).toEqual([]);
    expect(semantic.authority).toEqual([]);
    expect(semantic.trust.dependencies).toEqual([]);
    expect(semantic.trust.capabilities).toEqual([]);
    expect(semantic.epistemic.observations).toEqual([]);
    expect(semantic.epistemic.assumptions).toEqual([]);
    expect(semantic.epistemic.hypotheses).toEqual([]);
    expect(semantic.epistemic.invariants).toEqual([]);
    expect(semantic.unknowns).toEqual([]);
    expect(semantic.input.state_output_hash).toBe(computeOutputIdentity(analysis.state).output_hash);
    expect(() => validateSemanticModel(semantic, { state: analysis.state })).not.toThrow();
  });

  it('non-ReconError in semantic pass maps to InvalidSemanticModel code', async () => {
    const state = vaultState();
    const config = dummyConfig();
    vi.spyOn(transitionsModule, 'deriveTransitions').mockImplementation(() => { throw new TypeError('boom'); });
    const { semantic } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(semantic.status).toBe('FAILED');
    expect(semantic.failure!.code).toBe('InvalidSemanticModel');
    expect(Object.keys(semantic.failure!).sort()).toEqual(['code', 'stage']);
  });
});

describe('analyzeProjectSemantic — PARTIAL mapping (SINV-13/14)', () => {
  it("syntactic fidelity yields PARTIAL with sorted degradation note", async () => {
    const state = vaultState();
    const config = dummyConfig();
    const { semantic } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state, { fidelity: 'syntactic' }),
    });
    expect(semantic.status).toBe('PARTIAL');
    expect(semantic.input.fidelity).toBe('syntactic');
    expect(semantic.input.degradation !== undefined && semantic.input.degradation.length >= 1).toBe(true);
    const sorted = [...semantic.input.degradation!].sort(compareCodeUnits);
    expect(semantic.input.degradation).toEqual(sorted);
    expect(() => validateSemanticModel(semantic, { state })).not.toThrow();
  });
});

describe('analyzeProjectSemantic — scope conflict integration (SINV-12, stage validate)', () => {
  it('EXCLUDED file reference fails SINV-12 scope_conflict', () => {
    const state = vaultState();
    const outputHash = computeOutputIdentity(state).output_hash;
    void outputHash;
    const scopeReport: any = {
      schema_version: 'scope-report/v1',
      run: null,
      run_status: 'FAILED',
      failed_stage: 'analysis',
      counts: { expected: 1, analyzed: 0, excluded: 1, not_found: 0, unresolved: 0, unsupported: 0, failed: 0 },
      entries: [{ target_type: 'source_file', path: 'src/Vault.sol', status: 'EXCLUDED', evidence: [{ kind: 'exclude_rule', rule: 'config:excludes:src/Vault.sol' }] }],
      metrics: {
        clean_coverage: { n: 0, d: 1 },
        resolution_completeness: { n: 0, d: 1 },
        unsupported_rate: { n: 0, d: 1 },
        failed_rate: { n: 0, d: 1 },
        not_found_rate: { n: 0, d: 1 },
        excluded_by_rule: [],
        fallback_count: 0,
      },
      scope_hash: 'a'.repeat(64),
    };
    const { semantic } = { semantic: null as never };
    void semantic;
    // Build a COMPLETE semantic via wrapper without scope, then validate with conflicting report
    return analyzeProjectSemantic(dummyConfig(), {}, {
      analyze: async () => fakeAnalysis(state),
    }).then(({ semantic: model }) => {
      let reason: unknown;
      try {
        validateSemanticModel(model, { state, scopeReport });
      } catch (error) {
        reason = (error as ReconError).details.reason;
      }
      expect(reason).toBe('scope_conflict');
    });
  });

  it('validate-stage throw maps to FAILED envelope with stage validate', async () => {
    const state = vaultState();
    const config = dummyConfig();
    const scopeFailure = new ReconError('InvalidSemanticModel', 'scope conflict', { reason: 'scope_conflict' });
    vi.spyOn(validateModule, 'validateSemanticModel').mockImplementation(() => { throw scopeFailure; });
    const { semantic } = await analyzeProjectSemantic(config, {}, {
      analyze: async () => fakeAnalysis(state),
    });
    expect(semantic.status).toBe('FAILED');
    expect(semantic.failure!.stage).toBe('validate');
    expect(semantic.failure!.code).toBe('InvalidSemanticModel');
    expect(Object.keys(semantic.failure!).sort()).toEqual(['code', 'stage']);
  });
});
