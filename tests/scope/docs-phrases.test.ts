import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOC_PATH = fileURLToPath(new URL('../../docs/scope-accounting.md', import.meta.url));

const REQUIRED_SENTENCE =
  '`clean_coverage` measures pipeline reach without known target-level gaps. It is not a measure of semantic completeness, security coverage, recon soundness, audit coverage, or risk reduction.';

const FORBIDDEN_ALIASES = [
  'recon completeness',
  'semantic completeness',
  'security coverage',
  'audit coverage',
  'understanding percentage',
  'risk reduction',
];

const STATUSES = ['ANALYZED', 'EXCLUDED', 'NOT_FOUND', 'UNRESOLVED', 'UNSUPPORTED', 'FAILED'];

function readDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('docs/scope-accounting.md phrase pinning [RF2]', () => {
  it('docs state clean_coverage is not semantic completeness', () => {
    const content = readDoc();
    expect(content).toContain(REQUIRED_SENTENCE);
    expect(content.split(REQUIRED_SENTENCE).length - 1).toBe(1);
  });

  it('docs never use coverage as a bare metric name', () => {
    const content = readDoc().replace(REQUIRED_SENTENCE, '');
    expect(/\bcov/i.test(content)).toBe(false);
    for (const alias of FORBIDDEN_ALIASES) {
      expect(content.includes(alias)).toBe(false);
    }
  });

  it('docs document all six statuses and the fallback fidelity rule', () => {
    const content = readDoc();
    for (const status of STATUSES) {
      expect(content).toContain(status);
    }
    expect(content).toContain('fidelity evidence');
  });
});
