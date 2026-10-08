import { describe, expect, it } from 'vitest';
import { esmContentId } from '../../../src/semantic/esm/ids.js';
import { ESM_UNKNOWN_REASONS, makeEsmUnknown } from '../../../src/semantic/esm/unknown.js';

describe('makeEsmUnknown', () => {
  it('throws on empty basis', () => {
    expect(() => makeEsmUnknown('some-scope', 'no_evidence', [])).toThrow();
  });

  it('stores unsorted basis sorted in code-unit order', () => {
    const record = makeEsmUnknown('some-scope', 'no_evidence', ['c', 'a', 'b']);
    expect(record.basis).toEqual(['a', 'b', 'c']);
  });

  it('id is stable across runs and covers (scope, reason, sorted basis)', () => {
    const first = makeEsmUnknown('some-scope', 'bound-hit', ['y', 'x']);
    const second = makeEsmUnknown('some-scope', 'bound-hit', ['x', 'y']);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(
      esmContentId('seme:', { scope: 'some-scope', reason: 'bound-hit', basis: ['x', 'y'] }),
    );
  });

  it('rejects reasons outside the frozen taxonomy', () => {
    expect(() =>
      makeEsmUnknown('some-scope', 'not-a-reason' as 'no_evidence', ['x']),
    ).toThrow();
  });

  it('freezes the exact §13.2 reason strings', () => {
    expect([...ESM_UNKNOWN_REASONS]).toEqual([
      'no_evidence',
      'unresolved_call',
      'unsupported_assembly',
      'out_of_scope_target',
      'syntactic_fidelity',
      'dropped_file',
      'no-return-linkage',
      'no-branch-evidence',
      'sub-path-unobservable',
      'location-unidentified',
      'alias-possible',
      'value-unobservable',
      'ordering-unobservable',
      'ambiguous-source-kind',
      'runtime-unobservable',
      'context-shift',
      'bound-hit',
      'cyclic',
    ]);
  });
});
