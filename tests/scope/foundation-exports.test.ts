import { describe, expect, it } from 'vitest';
import { assertInsideRoot, ALWAYS_EXCLUDED_DIRS, globToRegExp, sortPaths } from '../../src/recon/discover.js';
import { ReconError } from '../../src/errors/errors.js';

describe('foundation exports for scope accounting', () => {
  it('globToRegExp matches discovery semantics', () => {
    expect(globToRegExp('**/*.sol').test('src/A.sol')).toBe(true);
    expect(globToRegExp('**/*.sol').test('src/A.txt')).toBe(false);
  });
  it('ALWAYS_EXCLUDED_DIRS contains the canonical set', () => {
    expect([...ALWAYS_EXCLUDED_DIRS].sort()).toEqual(['.git', '.recon-cache', 'node_modules']);
  });
  it('sortPaths sorts by the picked key in code-unit order', () => {
    expect(sortPaths([{ p: 'b' }, { p: 'a' }], (r) => r.p).map((r) => r.p)).toEqual(['a', 'b']);
  });
  it('assertInsideRoot throws RootEscape outside the root', () => {
    const realRoot = '/tmp/root';
    expect(() => assertInsideRoot(realRoot, '/tmp/other/x', '../x')).toThrowError(ReconError);
    try {
      assertInsideRoot(realRoot, '/tmp/other/x', '../x');
    } catch (e) {
      expect((e as ReconError).code).toBe('RootEscape');
    }
  });
  it('InvalidScopeReport is a ReconErrorCode', () => {
    expect(new ReconError('InvalidScopeReport', 'x').code).toBe('InvalidScopeReport');
  });
});
