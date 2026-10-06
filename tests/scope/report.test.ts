import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeCounts, computeMetrics } from '../../src/scope/metrics.js';
import type {
  EmbeddedIssue,
  ScopeEntry,
  ScopeEvidence,
  ScopeReport,
} from '../../src/scope/model.js';
import {
  computeScopeHash,
  finalizeScopeReport,
  serializeScopeReport,
} from '../../src/scope/report.js';
import { validateScopeReport } from '../../src/scope/validate.js';
import { stableStringify } from '../../src/util/canonical.js';

const SHA = 'a'.repeat(64);
const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TMP = tmpdir();
const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TIMESTAMP_KEY = /timestamp|generated_at|date/i;

function issueEvidence(over: Partial<EmbeddedIssue> & { file: string }): ScopeEvidence {
  return {
    kind: 'issue',
    issue: { code: 'call_target_unresolved', severity: 'RECOVERABLE', message: 'msg', count: 1, ...over },
  };
}

function entry(
  status: ScopeEntry['status'],
  entryPath: string,
  evidence: readonly ScopeEvidence[],
): ScopeEntry {
  return { target_type: 'source_file', path: entryPath, status, evidence: [...evidence] };
}

const ANALYZED = entry('ANALYZED', 'contracts/A.sol', [{ kind: 'analysis', sha256: SHA }]);
const EXCLUDED = entry('EXCLUDED', 'vendor/V.sol', [
  { kind: 'exclude_rule', rule: 'config:excludes:vendor/**' },
]);
const NOT_FOUND = entry('NOT_FOUND', 'contracts/Ghost.sol', [
  { kind: 'walk_miss', include: 'contracts/Ghost.sol' },
]);
const UNSUPPORTED = entry('UNSUPPORTED', 'contracts/C.sol', [
  issueEvidence({ file: 'contracts/C.sol', code: 'compilation_failed' }),
]);
const ANALYZED_BECOMES_UNSUPPORTED = entry('UNSUPPORTED', 'contracts/A.sol', [
  issueEvidence({ file: 'contracts/A.sol', code: 'compilation_failed' }),
]);

function draft(entries: readonly ScopeEntry[]): Omit<ScopeReport, 'scope_hash'> {
  const list = [...entries];
  return {
    schema_version: 'scope-report/v1',
    run: { run_id: 'run:1', input_manifest_hash: 'manifest', output_hash: 'output' },
    run_status: 'COMPLETED',
    run_fidelity: 'semantic',
    counts: computeCounts(list),
    entries: list,
    metrics: computeMetrics(list),
  };
}

function fourStatuses(): ScopeEntry[] {
  return [ANALYZED, EXCLUDED, NOT_FOUND, UNSUPPORTED];
}

function withoutHash(report: ScopeReport): Omit<ScopeReport, 'scope_hash'> {
  const { scope_hash: _omit, ...rest } = report;
  return rest;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

describe('computeScopeHash', () => {
  it('is sha256 over stableStringify of the report without scope_hash', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    const input = stableStringify(withoutHash(finalized));
    const expected = createHash('sha256').update(input, 'utf8').digest('hex');
    expect(finalized.scope_hash).toBe(expected);
    expect(computeScopeHash(withoutHash(finalized))).toBe(expected);
  });

  it('excludes the scope_hash field entirely from the hash input', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    const withField = createHash('sha256')
      .update(stableStringify(finalized), 'utf8')
      .digest('hex');
    expect(withField).not.toBe(finalized.scope_hash);
    expect(stableStringify(withoutHash(finalized))).not.toContain('scope_hash');
  });

  it('hash changes when a status changes', () => {
    const before = finalizeScopeReport(draft([ANALYZED, EXCLUDED, NOT_FOUND]));
    const after = finalizeScopeReport(draft([ANALYZED_BECOMES_UNSUPPORTED, EXCLUDED, NOT_FOUND]));
    expect(before.entries[0]?.status).toBe('ANALYZED');
    expect(after.entries[0]?.status).toBe('UNSUPPORTED');
    expect(after.scope_hash).not.toBe(before.scope_hash);
  });

  it('identical inputs give identical hashes', () => {
    const first = draft(fourStatuses());
    const second = draft(fourStatuses());
    expect(computeScopeHash(first)).toBe(computeScopeHash(second));
    expect(finalizeScopeReport(first).scope_hash).toBe(finalizeScopeReport(second).scope_hash);
  });

  it('stays recomputable after validateScopeReport', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    const validated = validateScopeReport(finalized);
    expect(computeScopeHash(validated)).toBe(finalized.scope_hash);
  });
});

describe('finalizeScopeReport', () => {
  it('sets a 64-hex hash recomputable from the report without hash', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    expect(finalized.scope_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(finalized.scope_hash).toBe(computeScopeHash(withoutHash(finalized)));
    expect(finalized.schema_version).toBe('scope-report/v1');
  });

  it('validate round trip passes', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    expect(validateScopeReport(finalized)).toEqual(finalized);
  });
});

describe('serializeScopeReport', () => {
  it('double serialize is byte-identical', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    expect(serializeScopeReport(finalized)).toBe(serializeScopeReport(finalized));
  });

  it('round-trips byte-identically through parse', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    const once = serializeScopeReport(finalized);
    expect(serializeScopeReport(JSON.parse(once))).toBe(once);
  });

  it('serialized report contains no absolute path', () => {
    const serialized = serializeScopeReport(finalizeScopeReport(draft(fourStatuses())));
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain(TMP);
    for (const value of collectStrings(JSON.parse(serialized))) {
      expect(value.startsWith('/')).toBe(false);
      expect(value).not.toContain('\\');
    }
  });

  it('serialized report contains no timestamp-shaped key or ISO date', () => {
    const serialized = serializeScopeReport(finalizeScopeReport(draft(fourStatuses())));
    for (const key of collectKeys(JSON.parse(serialized))) {
      expect(key).not.toMatch(TIMESTAMP_KEY);
    }
    expect(serialized).not.toMatch(ISO_DATE);
  });

  it('hash input contains no absolute path, ISO date, or backslash', () => {
    const finalized = finalizeScopeReport(draft(fourStatuses()));
    const input = stableStringify(withoutHash(finalized));
    expect(input).not.toContain(ROOT);
    expect(input).not.toContain(TMP);
    expect(input).not.toMatch(ISO_DATE);
    expect(input).not.toContain('\\');
    for (const value of collectStrings(JSON.parse(input))) {
      expect(value.startsWith('/')).toBe(false);
    }
  });
});
