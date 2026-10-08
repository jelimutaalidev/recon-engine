import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Phrase gate over the user-facing record (spec §16.2.5, §2.1, §6).
// Reads docs/phase-4-ssem.md and pins required/forbidden phrasing.
const DOC = fileURLToPath(new URL('../../docs/phase-4-ssem.md', import.meta.url));

const FORBIDDEN = /vulnerable|exploit|severity|critical|finding|attack|PoC/;

function lines(): string[] {
  return readFileSync(DOC, 'utf8').split('\n');
}

// Forbidden vocabulary may appear only inside the explicitly allowed
// `## Non-goals` section: from its heading line up to (not including)
// the next `## ` heading line.
function nonGoalsRange(ls: string[]): { start: number; end: number } {
  const start = ls.findIndex((l) => /^##\s+Non-goals/.test(l));
  if (start === -1) throw new Error('docs/phase-4-ssem.md has no `## Non-goals` section');
  let end = ls.length;
  for (let i = start + 1; i < ls.length; i++) {
    const line: string = ls[i] ?? '';
    if (/^##\s+/.test(line)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

describe('docs/phase-4-ssem.md phrase gate', () => {
  it('states the honesty sentence (not symbolic execution + structural function summaries)', () => {
    const text = readFileSync(DOC, 'utf8');
    expect(text).toContain('not symbolic execution');
    expect(text).toContain('structural function summaries');
  });

  it('names the four-way distinction terms', () => {
    const text = readFileSync(DOC, 'utf8');
    for (const term of ['Asset', 'Custody', 'accounting representation', 'Claim']) {
      expect(text).toContain(term);
    }
  });

  it('confines forbidden vocabulary to the Non-goals section', () => {
    const ls = lines();
    const { start, end } = nonGoalsRange(ls);
    const offenders: string[] = [];
    ls.forEach((line, i) => {
      if (FORBIDDEN.test(line) && !(i >= start && i < end)) {
        offenders.push(`${i + 1}: ${line}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('pairs `candidate` with `not a finding` phrasing', () => {
    const ls = lines();
    const hit = ls.some((line) => line.includes('candidate') && line.includes('not a finding'));
    expect(hit).toBe(true);
  });
});
