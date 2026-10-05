import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { afterEach, describe, expect, it } from 'vitest';
import { isReconError, type ReconErrorCode } from '../../src/errors/errors.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { analyzeProject } from '../../src/recon/index.js';
import { verifyChecksum } from '../../src/recon/backend/solc/versions.js';

const BROKEN_ROOT = fileURLToPath(new URL('../../fixtures/solidity/broken', import.meta.url));

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

describe('security: untrusted repositories', () => {
  it('does not let ../ include patterns escape the analysis root', async () => {
    const base = tempRoot('recon-sec-');
    const root = join(base, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'A.sol'), 'contract A {}');
    writeFileSync(join(base, 'Evil.sol'), 'contract Evil {}');

    const config = parseReconConfig({
      root,
      includes: ['**/*.sol', '../*.sol', '../**'],
      excludes: ['../**'],
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const result = await analyzeProject(config);

    expect(result.meta.fileCount).toBe(1);
    expect(result.state.contracts.map((contract) => contract.name)).toEqual(['A']);
    expect(result.state.contracts.some((contract) => contract.name === 'Evil')).toBe(false);
  });

  it('does not let absolute include patterns reach files outside the analysis root', async () => {
    const base = tempRoot('recon-sec-');
    const root = join(base, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'A.sol'), 'contract A {}');
    writeFileSync(join(base, 'Evil.sol'), 'contract Evil {}');

    const config = parseReconConfig({
      root,
      includes: ['**/*.sol', join(base, 'Evil.sol'), join(base, '*.sol')],
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const result = await analyzeProject(config);

    expect(result.meta.fileCount).toBe(1);
    expect(result.state.contracts.map((contract) => contract.name)).toEqual(['A']);
    expect(result.state.contracts.some((contract) => contract.name === 'Evil')).toBe(false);
  });

  it('refuses a symlinked file that resolves outside the root (FATAL RootEscape)', async () => {
    const base = tempRoot('recon-sec-');
    const root = join(base, 'project');
    mkdirSync(root);
    writeFileSync(join(root, 'A.sol'), 'contract A {}');
    const outside = join(base, 'Evil.sol');
    writeFileSync(outside, 'contract Evil {}');
    symlinkSync(outside, join(root, 'Escape.sol'));

    const config = parseReconConfig({ root, recordGit: false, timestamp: '2026-01-01T00:00:00.000Z' });
    await expectReconCode(() => analyzeProject(config), 'RootEscape');
  });

  it('skips oversized files with a RECOVERABLE issue and keeps analyzing', async () => {
    const root = tempRoot('recon-sec-');
    writeFileSync(join(root, 'G.sol'), 'contract G{function f()external pure returns(uint256){return 1;}}');
    writeFileSync(join(root, 'Big.sol'), `contract Big { uint256 pad = 0; // ${'x'.repeat(400)}\n}`);

    const config = parseReconConfig({
      root,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      limits: { maxFileBytes: 100 },
    });
    const result = await analyzeProject(config);

    expect(result.meta.fileCount).toBe(1);
    expect(result.state.contracts.map((contract) => contract.name)).toEqual(['G']);
    const oversized = result.issues.filter((issue) => issue.code === 'file_too_large');
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.severity).toBe('RECOVERABLE');
    expect(oversized[0]?.file).toBe('Big.sol');
  });

  it('aborts when the file count cap is exceeded (FATAL SourceLimitExceeded)', async () => {
    const root = tempRoot('recon-sec-');
    writeFileSync(join(root, 'A.sol'), 'contract A {}');
    writeFileSync(join(root, 'B.sol'), 'contract B {}');

    const config = parseReconConfig({
      root,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      limits: { maxFiles: 1 },
    });
    await expectReconCode(() => analyzeProject(config), 'SourceLimitExceeded');
  });

  it('rejects a tampered cached compiler before use (FATAL ChecksumMismatch)', async () => {
    const root = tempRoot('recon-sec-');
    writeFileSync(join(root, 'A.sol'), 'contract A {}');
    const bin = join(root, '.recon-cache', 'solc', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'soljson-v0.8.31+commit.aaaa0000.js'), 'TAMPERED!');
    const pristine = 'CLEAN-COMPILER-BYTES';
    writeFileSync(
      join(root, '.recon-cache', 'solc', 'list.json'),
      JSON.stringify({
        builds: [
          {
            path: 'soljson-v0.8.31+commit.aaaa0000.js',
            version: '0.8.31',
            longVersion: '0.8.31+commit.aaaa0000',
            sha256: createHash('sha256').update(pristine).digest('hex'),
          },
        ],
        releases: { '0.8.31': 'soljson-v0.8.31+commit.aaaa0000.js' },
        latestRelease: '0.8.31',
      }),
    );

    const config = parseReconConfig({
      root,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      compilerSource: 'cache-only',
      solcVersion: '0.8.31',
    });
    await expectReconCode(() => analyzeProject(config), 'ChecksumMismatch');
    expect(verifyChecksum(createHash('sha256').update(pristine).digest('hex'), Buffer.from(pristine))).toBe(true);
    expect(verifyChecksum(createHash('sha256').update(pristine).digest('hex'), Buffer.from('TAMPERED!'))).toBe(false);
  });

  it('never reaches for the network in cache-only mode with an uncached pin (FATAL CompilerUnavailable)', async () => {
    const root = tempRoot('recon-sec-');
    writeFileSync(join(root, 'A.sol'), 'pragma solidity ^0.8.0;\ncontract A {}');

    const config = parseReconConfig({
      root,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      compilerSource: 'cache-only',
      solcVersion: '0.9.9',
    });
    await expectReconCode(() => analyzeProject(config), 'CompilerUnavailable');
  });

  it('uses only the bundled compiler offline in cache-only mode', async () => {
    const root = tempRoot('recon-sec-');
    writeFileSync(join(root, 'A.sol'), 'pragma solidity ^0.8.0;\ncontract A {}');

    const config = parseReconConfig({
      root,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      compilerSource: 'cache-only',
    });
    const result = await analyzeProject(config);

    expect(result.meta.fidelity).toBe('semantic');
    expect(result.meta.solcLongVersion).toBe(solc.version());
    expect(result.state.contracts.map((contract) => contract.name)).toEqual(['A']);
  });

  it('drops malformed solidity with RECOVERABLE issues and keeps the healthy file semantic', async () => {
    const config = parseReconConfig({
      root: BROKEN_ROOT,
      recordGit: false,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const result = await analyzeProject(config);

    expect(result.meta.fidelity).toBe('semantic');
    expect(result.state.contracts.map((contract) => contract.name)).toEqual(['Good']);
    const recoverable = result.issues.filter((issue) => issue.severity === 'RECOVERABLE');
    expect(recoverable.length).toBeGreaterThanOrEqual(1);
    expect(recoverable.every((issue) => issue.file === 'Broken.sol')).toBe(true);
    expect(recoverable.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['compilation_failed']),
    );
    expect(result.issues.some((issue) => issue.severity === 'FATAL')).toBe(false);
  });
});
