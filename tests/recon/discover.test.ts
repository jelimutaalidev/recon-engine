import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { ReconError } from '../../src/errors/errors.js';

describe('discoverSources', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recon-discover-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, '.recon-cache'), { recursive: true });
    writeFileSync(join(root, 'src', 'Vault.sol'), 'contract Vault {}');
    writeFileSync(join(root, 'src', 'IERC20.sol'), 'interface IERC20 {}');
    writeFileSync(join(root, 'test', 'VaultTest.sol'), 'contract VaultTest {}');
    writeFileSync(join(root, 'Top.sol'), 'contract Top {}');
    writeFileSync(join(root, 'src', 'skip.txt'), 'not solidity');
    writeFileSync(join(root, '.git', 'hook.sol'), 'contract InGit {}');
    writeFileSync(join(root, 'node_modules', 'dep', 'Dep.sol'), 'contract InDeps {}');
    writeFileSync(join(root, '.recon-cache', 'C.sol'), 'contract InCache {}');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds solidity files with posix relative paths, sorted, with sha256 and byte size', async () => {
    const config = parseReconConfig({ root, excludes: ['test/**'] });
    const { files, issues } = await discoverSources(config);

    expect(issues).toEqual([]);
    expect(files.map((file) => file.path)).toEqual([
      'Top.sol',
      'src/IERC20.sol',
      'src/Vault.sol',
    ]);
    const vault = files.find((file) => file.path === 'src/Vault.sol');
    const expectedHash = createHash('sha256').update('contract Vault {}').digest('hex');
    expect(vault?.sha256).toBe(expectedHash);
    expect(vault?.bytes).toBe('contract Vault {}'.length);
    expect(vault?.absolute.startsWith(root)).toBe(true);
  });

  it('never crosses .git, node_modules, or .recon-cache', async () => {
    const config = parseReconConfig({ root });
    const { files } = await discoverSources(config);
    const paths = files.map((file) => file.path);
    expect(paths).not.toContain('.git/hook.sol');
    expect(paths).not.toContain('node_modules/dep/Dep.sol');
    expect(paths).not.toContain('.recon-cache/C.sol');
  });

  it('applies default **/*.sol include and config excludes', async () => {
    const config = parseReconConfig({ root, excludes: ['test/**'] });
    const { files } = await discoverSources(config);
    expect(files.some((file) => file.path.startsWith('test/'))).toBe(false);
    expect(files.some((file) => file.path.endsWith('.sol'))).toBe(true);
  });

  it('skips oversized files with a RECOVERABLE issue', async () => {
    const config = parseReconConfig({ root, limits: { maxFileBytes: 5 } });
    const { files, issues } = await discoverSources(config);
    expect(files).toEqual([]);
    expect(issues).toHaveLength(4);
    expect(issues.every((issue) => issue.code === 'file_too_large')).toBe(true);
    expect(issues.every((issue) => issue.severity === 'RECOVERABLE')).toBe(true);
    expect(issues[0]?.file).toBeDefined();
  });

  it('throws FATAL when the file count cap is exceeded', async () => {
    const config = parseReconConfig({ root, limits: { maxFiles: 2 } });
    await expect(discoverSources(config)).rejects.toThrow(ReconError);
    await expect(discoverSources(config)).rejects.toThrow(/too many|SourceLimitExceeded/i);
  });

  it('throws FATAL when no solidity sources exist', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'recon-empty-'));
    try {
      const config = parseReconConfig({ root: empty });
      await expect(discoverSources(config)).rejects.toThrow(/NoSourcesFound|no solidity/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('throws FATAL when a junction symlink escapes the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'recon-outside-'));
    try {
      writeFileSync(join(outside, 'Evil.sol'), 'contract Evil {}');
      symlinkSync(outside, join(root, 'linkdir'), 'junction');
      const config = parseReconConfig({ root });
      await expect(discoverSources(config)).rejects.toThrow(/RootEscape|escape/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns absolute paths using the platform separator check', async () => {
    const config = parseReconConfig({ root });
    const { files } = await discoverSources(config);
    for (const file of files) {
      expect(file.absolute.startsWith(root + sep) || file.absolute === root).toBe(true);
      expect(file.path.includes('\\')).toBe(false);
    }
  });
});
