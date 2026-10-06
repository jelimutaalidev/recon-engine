import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReconError } from '../../src/errors/errors.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { analyzeProject, type AnalysisResult } from '../../src/recon/index.js';
import { serializeReconState } from '../../src/recon-state/state.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import { analyzeProjectScoped, type AnalyzeScopedResult } from '../../src/scope/analyze.js';
import type { ScopeReport as BarrelScopeReport, Stage as BarrelStage } from '../../src/scope/index.js';
import type { ScopeReport } from '../../src/scope/model.js';
import { serializeScopeReport } from '../../src/scope/report.js';
import { validateScopeReportWithState } from '../../src/scope/validate.js';
import * as modelModule from '../../src/scope/model.js';
import * as inventoryModule from '../../src/scope/inventory.js';
import * as evidenceModule from '../../src/scope/evidence.js';
import * as deriveModule from '../../src/scope/derive.js';
import * as metricsModule from '../../src/scope/metrics.js';
import * as validateModule from '../../src/scope/validate.js';
import * as reportModule from '../../src/scope/report.js';
import * as analyzeModule from '../../src/scope/analyze.js';

const TIMESTAMP = '2026-01-01T00:00:00Z';
const PROJECT_NAME = 'parity-fixture';
const TEST_TIMEOUT = 60_000;

const VAULT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Vault {
  uint256 public balance;

  function deposit(uint256 amount) external {
    balance += amount;
  }
}
`;

const GAP_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Gap {
  function ping(address target) external returns (bool) {
    (bool ok, ) = target.call(abi.encodeWithSignature("pong()"));
    return ok;
  }
}
`;

const HELPER_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Helper {
  function noop() external {}
}
`;

const roots: string[] = [];

function fixtureConfig(): ReconConfig {
  const root = mkdtempSync(join(tmpdir(), 'recon-parity-'));
  roots.push(root);
  const files: Record<string, string> = {
    'src/Vault.sol': VAULT_SOURCE,
    'src/Gap.sol': GAP_SOURCE,
    'lib/Helper.sol': HELPER_SOURCE,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return parseReconConfig({
    root,
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: PROJECT_NAME,
    includes: ['**/*.sol', 'src/Ghost.sol'],
    excludes: ['lib/**'],
  });
}

interface SharedRuns {
  config: ReconConfig;
  scoped: AnalyzeScopedResult;
  plain: AnalysisResult;
}

let shared: Promise<SharedRuns> | undefined;

function sharedRuns(): Promise<SharedRuns> {
  shared ??= (async () => {
    const config = fixtureConfig();
    const scoped = await analyzeProjectScoped(config);
    const plain = await analyzeProject(config);
    return { config, scoped, plain };
  })();
  return shared;
}

afterAll(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function expectInvalidScope(fn: () => void, reason: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReconError);
  const recon = caught as ReconError;
  expect(recon.code).toBe('InvalidScopeReport');
  expect(recon.details.reason).toBe(reason);
}

describe('analyzeProjectScoped parity [RF5]', () => {
  it(
    'wrapper state is byte-identical to plain analyzeProject',
    async () => {
      const { scoped, plain } = await sharedRuns();
      expect(serializeReconState(scoped.result.state)).toBe(serializeReconState(plain.state));
      expect(scoped.result.issues).toEqual(plain.issues);
      expect(scoped.result.meta).toEqual(plain.meta);
    },
    TEST_TIMEOUT,
  );

  it('report.run equals the current run by output_identity rule', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;

    const outputHash = computeOutputIdentity(result.state).output_hash;
    const currentRun = result.state.traceability?.runs.find(
      (run) => run.output_identity?.output_hash === outputHash,
    );
    expect(currentRun).toBeDefined();
    if (currentRun === undefined || currentRun.output_identity === undefined) {
      throw new Error('expected a current run on the state');
    }
    expect(report.run).toEqual({
      run_id: currentRun.id,
      input_manifest_hash: currentRun.input_manifest_hash,
      output_hash: currentRun.output_identity.output_hash,
    });

    expect(() => validateScopeReportWithState(report, result.state, result.meta)).not.toThrow();
  });

  it('meta.fileCount equation holds', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;
    expect(result.meta.fileCount).toBe(
      report.counts.analyzed +
        report.counts.unresolved +
        report.counts.unsupported +
        report.counts.failed,
    );
    expect(() => validateScopeReportWithState(report, result.state, result.meta)).not.toThrow();
  });

  it(
    'double run produces byte-identical serializeScopeReport',
    async () => {
      const { config, scoped } = await sharedRuns();
      const again = await analyzeProjectScoped(config);
      expect(serializeScopeReport(again.report)).toBe(serializeScopeReport(scoped.report));
      expect(again.report.scope_hash).toBe(scoped.report.scope_hash);
    },
    TEST_TIMEOUT,
  );
});

describe('validateScopeReportWithState', () => {
  it('provenance cross-check passes on a real fixture', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;

    const cited = new Set(
      result.state.provenance
        .map((record) => record.file)
        .filter((file): file is string => file !== undefined),
    );
    expect(cited.size).toBeGreaterThan(0);
    expect(cited.has('src/Vault.sol')).toBe(true);
    expect(cited.has('src/Gap.sol')).toBe(true);

    const statuses = new Set(report.entries.map((entry) => entry.status));
    expect(statuses.has('ANALYZED')).toBe(true);
    expect(statuses.has('UNRESOLVED')).toBe(true);
    expect(statuses.has('EXCLUDED')).toBe(true);
    expect(statuses.has('NOT_FOUND')).toBe(true);

    expect(() => validateScopeReportWithState(report, result.state, result.meta)).not.toThrow();
  });

  it('provenance cross-check fails when an entry is demoted to NOT_FOUND', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;
    const target = report.entries.find((entry) => entry.path === 'src/Vault.sol');
    expect(target?.status).toBe('ANALYZED');

    const mutated: ScopeReport = {
      ...report,
      entries: report.entries.map((entry) =>
        entry.path === 'src/Vault.sol' ? { ...entry, status: 'NOT_FOUND' as const } : entry,
      ),
    };
    expectInvalidScope(
      () => validateScopeReportWithState(mutated, result.state, result.meta),
      'provenance_mismatch',
    );
  });

  it('fileCount mismatch rejected', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;
    expectInvalidScope(
      () =>
        validateScopeReportWithState(report, result.state, {
          ...result.meta,
          fileCount: result.meta.fileCount + 1,
        }),
      'file_count_mismatch',
    );
  });

  it('run identity mismatch rejected', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;
    if (report.run === null) {
      throw new Error('expected the COMPLETED fixture report to bind a run');
    }
    const tampered: ScopeReport = {
      ...report,
      run: { ...report.run, run_id: 'run:tampered' },
    };
    expectInvalidScope(
      () => validateScopeReportWithState(tampered, result.state, result.meta),
      'run_binding',
    );
  });

  it('run fidelity mismatch rejected', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;
    const flipped = result.meta.fidelity === 'semantic' ? 'syntactic' : 'semantic';
    expectInvalidScope(
      () =>
        validateScopeReportWithState(report, result.state, {
          fileCount: result.meta.fileCount,
          fidelity: flipped,
        }),
      'fidelity_mismatch',
    );
  });

  it('validation does not mutate state', async () => {
    const { scoped } = await sharedRuns();
    const { result, report } = scoped;
    const before = serializeReconState(result.state);
    const snapshot = structuredClone(result.state);

    expect(() => validateScopeReportWithState(report, result.state, result.meta)).not.toThrow();

    expect(serializeReconState(result.state)).toBe(before);
    expect(result.state).toEqual(snapshot);
  });
});

describe('src/scope/index barrel', () => {
  it('barrel exports the full module surface', async () => {
    const barrel = await import('../../src/scope/index.js');
    const { scoped } = await sharedRuns();

    const expected = [
      ...Object.keys(modelModule),
      ...Object.keys(inventoryModule),
      ...Object.keys(evidenceModule),
      ...Object.keys(deriveModule),
      ...Object.keys(metricsModule),
      ...Object.keys(validateModule),
      ...Object.keys(reportModule),
      ...Object.keys(analyzeModule),
    ];
    expect(Object.keys(barrel).sort()).toEqual([...new Set(expected)].sort());

    expect(barrel.analyzeProjectScoped).toBe(analyzeProjectScoped);
    expect(barrel.validateScopeReportWithState).toBe(validateScopeReportWithState);
    expect(barrel.serializeScopeReport).toBe(serializeScopeReport);
    expect(barrel.scopeReportSchema).toBe(modelModule.scopeReportSchema);

    const typed: BarrelScopeReport = scoped.report;
    const stage: BarrelStage = 'analysis';
    expect(typed.scope_hash).toBe(scoped.report.scope_hash);
    expect(stage).toBe('analysis');
  });
});
