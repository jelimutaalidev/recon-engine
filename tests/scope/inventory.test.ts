import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReconError } from '../../src/errors/errors.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { buildInventory } from '../../src/scope/inventory.js';

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

describe('buildInventory', () => {
  let root: string;

  const write = (relativePath: string, content: string): void => {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recon-inventory-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('glob matching nothing yields no entry and no NOT_FOUND', async () => {
    write('Unrelated.txt', 'hello');
    const config = parseReconConfig({ root, includes: ['nonexistent/**/*.sol'] });
    const inventory = await buildInventory(config);
    expect(inventory.files).toEqual([]);
    expect(inventory.not_found).toEqual([]);
  });

  it('literal miss yields walk_miss with normalized path', async () => {
    write('contracts/Real.sol', 'contract Real {}');
    const config = parseReconConfig({
      root,
      includes: ['**/*.sol', 'contracts/Ghost.sol', './contracts/Ghost.sol', 'contracts/Ghost.sol'],
    });
    const inventory = await buildInventory(config);
    expect(inventory.not_found).toEqual([
      { path: 'contracts/Ghost.sol', include: 'contracts/Ghost.sol' },
    ]);

    const escapeConfig = parseReconConfig({ root, includes: ['../x.sol'] });
    await expect(buildInventory(escapeConfig)).rejects.toThrow(ReconError);
    await expect(buildInventory(escapeConfig)).rejects.toThrow('RootEscape');
  });

  it('always-excluded dirs yield one marker and never enumerate contents', async () => {
    write('node_modules/dep/Dep.sol', 'contract Dep {}');
    write('vendor/node_modules/Inner.sol', 'contract Inner {}');
    write('src/A.sol', 'contract A {}');
    const config = parseReconConfig({ root });
    const inventory = await buildInventory(config);
    expect(inventory.files).toEqual([
      { path: 'node_modules', sha256: '', bytes: 0, excluded_rule: 'always:node_modules' },
      {
        path: 'src/A.sol',
        sha256: sha256('contract A {}'),
        bytes: 'contract A {}'.length,
        excluded_rule: null,
      },
      { path: 'vendor/node_modules', sha256: '', bytes: 0, excluded_rule: 'always:node_modules' },
    ]);
    for (const record of inventory.files) {
      expect(record.path.startsWith('node_modules/')).toBe(false);
      expect(record.path.startsWith('vendor/node_modules/')).toBe(false);
    }
    expect(inventory.not_found).toEqual([]);
  });

  it('exclude pattern wins over size limit', async () => {
    write('big/Huge.sol', 'this file is definitely over the limit');
    const config = parseReconConfig({ root, excludes: ['big/**'], limits: { maxFileBytes: 8 } });
    const inventory = await buildInventory(config);
    expect(inventory.files).toEqual([
      { path: 'big/Huge.sol', sha256: '', bytes: 0, excluded_rule: 'config:excludes:big/**' },
    ]);
    expect(inventory.files[0]?.limit_bytes).toBeUndefined();
  });

  it('size boundary at-limit eligible limit+1 excluded', async () => {
    const atLimit = 'a'.repeat(20);
    const over = 'b'.repeat(21);
    write('AtLimit.sol', atLimit);
    write('Over.sol', over);
    const config = parseReconConfig({ root, limits: { maxFileBytes: 20 } });
    const inventory = await buildInventory(config);
    expect(inventory.files).toEqual([
      { path: 'AtLimit.sol', sha256: sha256(atLimit), bytes: 20, excluded_rule: null },
      {
        path: 'Over.sol',
        sha256: sha256(over),
        bytes: 21,
        excluded_rule: 'limit:maxFileBytes',
        limit_bytes: 20,
      },
    ]);
  });

  it('directory matching an include records type:non-file and is still traversed', async () => {
    write('contracts/Nested.sol', 'contract Nested {}');
    const config = parseReconConfig({
      root,
      includes: ['contracts', 'contracts/**/*.sol'],
    });
    const inventory = await buildInventory(config);
    expect(inventory.files).toEqual([
      { path: 'contracts', sha256: '', bytes: 0, excluded_rule: 'type:non-file' },
      {
        path: 'contracts/Nested.sol',
        sha256: sha256('contract Nested {}'),
        bytes: 'contract Nested {}'.length,
        excluded_rule: null,
      },
    ]);
    expect(inventory.not_found).toEqual([]);
  });

  it('parity with discoverSources', async () => {
    write('Top.sol', 'contract Top {}');
    write('src/A.sol', 'contract A {}');
    write('src/lib/B.sol', 'contract B {}');
    write('legacy/Old.sol', 'contract Old {}');
    write('node_modules/dep/Dep.sol', 'contract Dep {}');
    write('.git/Hook.sol', 'contract Hook {}');
    write('docs/notes.txt', 'notes');
    write('contracts/Exact.sol', 'contract Exact {}');
    const config = parseReconConfig({
      root,
      includes: ['**/*.sol', 'contracts/Exact.sol', 'contracts/Ghost.sol'],
      excludes: ['legacy/**'],
    });
    const inventory = await buildInventory(config);
    const discovered = (await discoverSources(config)).files.map((file) => file.path).sort();
    const inE = inventory.files
      .filter((record) => record.excluded_rule === null)
      .map((record) => record.path);
    expect(inE).toEqual(discovered);
    expect(inventory.not_found).toEqual([
      { path: 'contracts/Ghost.sol', include: 'contracts/Ghost.sol' },
    ]);
  });

  it('maxFiles exceeded rejects with SourceLimitExceeded', async () => {
    write('A.sol', 'contract A {}');
    write('B.sol', 'contract B {}');
    const config = parseReconConfig({ root, limits: { maxFiles: 1 } });
    await expect(buildInventory(config)).rejects.toThrow(ReconError);
    await expect(buildInventory(config)).rejects.toThrow('SourceLimitExceeded');
  });

  it('symlink escaping root rejects with RootEscape', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'recon-inventory-outside-'));
    try {
      writeFileSync(join(outside, 'Evil.sol'), 'contract Evil {}');
      symlinkSync(outside, join(root, 'linkdir'), 'junction');
      const config = parseReconConfig({ root });
      await expect(buildInventory(config)).rejects.toThrow(ReconError);
      await expect(buildInventory(config)).rejects.toThrow('RootEscape');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('symlink cycle terminates', async () => {
    write('pkg/F.sol', 'contract F {}');
    symlinkSync(root, join(root, 'pkg', 'loop'));
    const config = parseReconConfig({ root });
    const inventory = await buildInventory(config);
    expect(inventory.files.map((record) => record.path)).toEqual(['pkg/F.sol']);
    expect(inventory.not_found).toEqual([]);
  });
});
