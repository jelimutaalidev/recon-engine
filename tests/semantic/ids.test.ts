import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReconError } from '../../src/errors/errors.js';
import { SEMANTIC_ID_PREFIXES, semanticContentId } from '../../src/semantic/ids.js';
import { stableStringify } from '../../src/util/canonical.js';

describe('semanticContentId', () => {
  it('matches <prefix>:<16 lowercase hex>', () => {
    expect(semanticContentId('semc', { a: 1 })).toMatch(/^semc:[0-9a-f]{16}$/);
  });

  it('is key-order independent', () => {
    expect(semanticContentId('semt', { a: 1, b: 2 })).toBe(semanticContentId('semt', { b: 2, a: 1 }));
  });

  it('distinct prefixes yield distinct ids for the same payload', () => {
    const payload = { a: 1 };
    expect(semanticContentId('semc', payload)).not.toBe(semanticContentId('semt', payload));
  });

  it('is byte-identical to sha256(stableStringify(payload)) hex-sliced to 16 chars', () => {
    const payload = { b: [1, 2, { c: true }], a: 'x', z: null, n: 3 };
    const digest = createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16);
    expect(semanticContentId('semc', payload)).toBe(`semc:${digest}`);
  });

  it('declares unique prefixes, each matching /^sem[a-z]+$/', () => {
    expect(new Set(SEMANTIC_ID_PREFIXES).size).toBe(SEMANTIC_ID_PREFIXES.length);
    for (const prefix of SEMANTIC_ID_PREFIXES) {
      expect(prefix).toMatch(/^sem[a-z]+$/);
    }
  });

  it('InvalidSemanticModel is a ReconErrorCode', () => {
    expect(new ReconError('InvalidSemanticModel', 'x', { reason: 'schema' }).code).toBe('InvalidSemanticModel');
  });
});
