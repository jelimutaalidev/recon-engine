import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseReconConfig } from '../../src/recon/config.js';
import {
  longVersionFromBuildPath,
  parsePragmas,
  satisfies,
  selectVersion,
  verifyChecksum,
} from '../../src/recon/backend/solc/versions.js';
import { ReconError } from '../../src/errors/errors.js';

describe('parsePragmas', () => {
  it('extracts solidity pragma constraint text', () => {
    const source = `
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.0;
      contract A {}
    `;
    expect(parsePragmas(source)).toEqual(['^0.8.0']);
  });

  it('extracts multiple pragma statements', () => {
    const source = 'pragma solidity >=0.7.0 <0.9.0;\ncontract A {}\npragma solidity 0.8.30;';
    expect(parsePragmas(source)).toEqual(['>=0.7.0 <0.9.0', '0.8.30']);
  });

  it('returns an empty list when no pragma exists', () => {
    expect(parsePragmas('contract A {}')).toEqual([]);
  });
});

describe('satisfies', () => {
  const cases: [string, string, boolean][] = [
    ['0.8.37', '^0.8.0', true],
    ['0.9.0', '^0.8.0', false],
    ['0.8.0', '^0.8.0', true],
    ['0.8.37', '>=0.8.0 <0.9.0', true],
    ['0.9.0', '>=0.8.0 <0.9.0', false],
    ['0.7.6', '>=0.6.0 <0.8.0', true],
    ['0.8.37', '=0.8.37', true],
    ['0.8.36', '=0.8.37', false],
    ['0.8.37', '0.8.37', true],
    ['0.8.36', '0.8.37', false],
    ['0.8.37', '>=0.7.0 <0.8.0 || >=0.8.2 <0.9.0', true],
    ['0.7.5', '>=0.7.0 <0.8.0 || >=0.8.2 <0.9.0', true],
    ['0.8.1', '>=0.7.0 <0.8.0 || >=0.8.2 <0.9.0', false],
    ['0.8.37', '^0.5.0 || ^0.6.0 || ^0.7.0 || ^0.8.0', true],
    ['0.8.37', 'garbage', false],
    ['0.8.37', '^0.8', false],
  ];
  for (const [version, pragma, expected] of cases) {
    it(`${version} ${expected ? 'satisfies' : 'does not satisfy'} ${pragma}`, () => {
      expect(satisfies(version, pragma)).toBe(expected);
    });
  }
});

describe('selectVersion', () => {
  const auto = parseReconConfig({ root: 'C:/x' });

  it('prefers the bundled compiler when it satisfies all pragmas', () => {
    const selection = selectVersion(auto, ['^0.8.0'], {
      bundled: '0.8.37',
      cached: ['0.8.30', '0.7.6'],
      released: ['0.8.37', '0.8.30', '0.7.6'],
    });
    expect(selection).toEqual({ shortVersion: '0.8.37', source: 'bundled' });
  });

  it('uses the highest cached version when bundled does not satisfy', () => {
    const selection = selectVersion(auto, ['>=0.6.0 <0.7.0'], {
      bundled: '0.8.37',
      cached: ['0.6.12', '0.6.8'],
      released: ['0.8.37', '0.6.12', '0.6.8'],
    });
    expect(selection).toEqual({ shortVersion: '0.6.12', source: 'cache' });
  });

  it('plans a download when auto mode needs a released non-cached version', () => {
    const selection = selectVersion(auto, ['^0.7.0'], {
      bundled: '0.8.37',
      cached: [],
      released: ['0.8.37', '0.7.6', '0.7.0'],
    });
    expect(selection).toEqual({ shortVersion: '0.7.6', source: 'download' });
  });

  it('honours an explicit version pin in cache-only mode when cached', () => {
    const config = parseReconConfig({
      root: 'C:/x',
      compilerSource: 'cache-only',
      solcVersion: '0.8.30',
    });
    const selection = selectVersion(config, [], {
      bundled: '0.8.37',
      cached: ['0.8.30'],
      released: ['0.8.37', '0.8.30'],
    });
    expect(selection).toEqual({ shortVersion: '0.8.30', source: 'cache' });
  });

  it('throws FATAL CompilerUnavailable for a missing pin in cache-only mode', () => {
    const pinnedCacheOnly = parseReconConfig({
      root: 'C:/x',
      compilerSource: 'cache-only',
      solcVersion: '0.8.30',
    });
    expect(() =>
      selectVersion(pinnedCacheOnly, [], {
        bundled: '0.8.37',
        cached: [],
        released: ['0.8.37'],
      }),
    ).toThrow(ReconError);
    try {
      selectVersion(pinnedCacheOnly, [], { bundled: '0.8.37', cached: [], released: ['0.8.37'] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ReconError).code).toBe('CompilerUnavailable');
    }
  });

  it('throws FATAL VersionConflict when no known version satisfies all pragmas', () => {
    try {
      selectVersion(auto, ['^0.5.0'], {
        bundled: '0.8.37',
        cached: [],
        released: ['0.8.37', '0.8.30'],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ReconError).code).toBe('VersionConflict');
    }
  });

  it('falls back to the bundled compiler when no file declares a pragma', () => {
    const selection = selectVersion(auto, [], {
      bundled: '0.8.37',
      cached: ['0.7.6'],
      released: ['0.8.37'],
    });
    expect(selection).toEqual({ shortVersion: '0.8.37', source: 'bundled' });
  });
});

describe('verifyChecksum / longVersionFromBuildPath', () => {
  it('accepts matching sha256', () => {
    const bytes = Buffer.from('soljson bytes');
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(verifyChecksum(expected, bytes)).toBe(true);
    expect(verifyChecksum(expected.toUpperCase(), bytes)).toBe(true);
    expect(verifyChecksum(`0x${expected}`, bytes)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const expected = createHash('sha256').update('original').digest('hex');
    expect(verifyChecksum(expected, Buffer.from('tampered'))).toBe(false);
  });

  it('derives longVersion from a release build path', () => {
    expect(longVersionFromBuildPath('soljson-v0.8.30+commit.73712a01.js')).toBe(
      '0.8.30+commit.73712a01',
    );
  });
});
