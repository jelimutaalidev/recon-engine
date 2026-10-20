import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { esmContentId } from '../../../src/semantic/esm/ids.js';
import { stableStringify } from '../../../src/util/canonical.js';

describe('esmContentId', () => {
  it('known-answer: esmContentId(\'seme:\', {}) equals sha256(stableStringify({})) first-16 with seme: prefix', () => {
    const digest = createHash('sha256').update(stableStringify({})).digest('hex').slice(0, 16);
    expect(esmContentId('seme:', {})).toBe(`seme:${digest}`);
  });

  it('matches /^seme:[0-9a-f]{16}$/', () => {
    expect(esmContentId('seme:', { a: 1 })).toMatch(/^seme:[0-9a-f]{16}$/);
  });

  it('is key-order independent', () => {
    expect(esmContentId('seme:', { a: 1, b: 2 })).toBe(esmContentId('seme:', { b: 2, a: 1 }));
  });

  it('distinct payloads differ', () => {
    expect(esmContentId('seme:', { a: 1 })).not.toBe(esmContentId('seme:', { a: 2 }));
  });
});
