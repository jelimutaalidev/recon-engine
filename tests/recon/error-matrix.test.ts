import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isReconError, type ReconErrorCode } from '../../src/errors/errors.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { analyzeProject } from '../../src/recon/index.js';

const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));
const UNSUPPORTED_ROOT = fileURLToPath(
  new URL('../../fixtures/solidity/unsupported', import.meta.url),
);

const cleanup: (() => void)[] = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function expectReconCode(fn: () => Promise<unknown>, code: ReconErrorCode): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(isReconError(error)).toBe(true);
    if (isReconError(error)) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ReconError ${code}, but call succeeded`);
}

describe('error matrix', () => {
  it('FATAL: analysis aborts when the source set is empty', async () => {
    const root = tempRoot('recon-matrix-');
    mkdirSync(join(root, 'empty'));

    const config = parseReconConfig({
      root: join(root, 'empty'),
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await expectReconCode(() => analyzeProject(config), 'NoSourcesFound');
  });

  it('RECOVERABLE: unavailable git HEAD degrades to the epoch timestamp with an issue', async () => {
    const root = tempRoot('recon-matrix-');
    writeFileSync(join(root, 'A.sol'), 'contract A {}');

    const config = parseReconConfig({ root, recordGit: true });
    const result = await analyzeProject(config);

    const gitIssue = result.issues.find((issue) => issue.code === 'git_unavailable');
    expect(gitIssue?.severity).toBe('RECOVERABLE');
    expect(result.meta.timestamp).toBe('1970-01-01T00:00:00Z');
    expect(result.state.project?.created_at).toBe('1970-01-01T00:00:00Z');
    expect(result.state.contracts.map((contract) => contract.name)).toEqual(['A']);
    expect(result.issues.some((issue) => issue.severity === 'FATAL')).toBe(false);
  });

  it('UNKNOWN: an unresolved delegatecall yields a marker fact and an UNKNOWN issue', async () => {
    const config = parseReconConfig({
      root: VAULT_ROOT,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      projectName: 'matrix-unknown',
    });
    const result = await analyzeProject(config);

    const marker = result.state.facts.find(
      (fact) => fact.predicate === 'DELEGATES_TO' && fact.value === 'unresolved-delegatecall',
    );
    expect(marker).toBeDefined();
    const issue = result.issues.find((issue) => issue.code === 'unresolved_delegatecall');
    expect(issue?.severity).toBe('UNKNOWN');
    expect(issue?.file).toBe('Vault.sol');
    expect(issue?.line_start).toBeGreaterThanOrEqual(1);
    expect(issue?.line_end).toBeGreaterThanOrEqual(issue?.line_start as number);
    expect(issue?.count).toBeGreaterThanOrEqual(1);
  });

  it('UNSUPPORTED: out-of-model constructs surface UNSUPPORTED issues and no facts', async () => {
    const config = parseReconConfig({
      root: UNSUPPORTED_ROOT,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      projectName: 'matrix-unsupported',
    });
    const result = await analyzeProject(config);

    expect(result.meta.fidelity).toBe('semantic');
    const unsupported = result.issues.filter((issue) => issue.severity === 'UNSUPPORTED');
    expect(unsupported.map((issue) => issue.code).sort()).toEqual([
      'unsupported_assembly',
      'unsupported_builtin',
      'unsupported_enum_definition',
      'unsupported_struct_definition',
      'unsupported_try_catch',
      'unsupported_udvt_definition',
    ]);
    for (const issue of unsupported) {
      expect(issue.file).toBe('Unsupported.sol');
      expect(issue.line_start).toBeGreaterThanOrEqual(1);
      expect(issue.line_end).toBeGreaterThanOrEqual(issue.line_start as number);
      expect(issue.count).toBeGreaterThanOrEqual(1);
    }

    expect(result.issues.filter((issue) => issue.severity === 'UNKNOWN')).toEqual([]);
    expect(result.state.facts.some((fact) => String(fact.value).startsWith('unresolved-'))).toBe(
      false,
    );
  });
});
