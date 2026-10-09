import { describe, expect, it } from 'vitest';
import { buildVaultState } from '../../fixtures/vault.js';
import { isReconError } from '../../src/errors/errors.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import { createReconState } from '../../src/recon-state/state.js';
import {
  buildEvidenceIndex,
  type IndexedIssue,
  type SemanticInput,
} from '../../src/semantic/evidence.js';

function vaultInput(issues: ReconIssue[] = []): SemanticInput {
  return {
    state: createReconState(structuredClone(buildVaultState())),
    issues,
    meta: { fidelity: 'semantic', fileCount: 1 },
  };
}

function constructIssue(code: string, file: string, lineStart: number, lineEnd = lineStart): ReconIssue {
  return {
    severity: 'UNSUPPORTED',
    code,
    message: `${code} construct present`,
    file,
    line_start: lineStart,
    line_end: lineEnd,
  };
}

describe('buildEvidenceIndex issue identity', () => {
  it('attaches stable issue: ids without mutating the input records', () => {
    const raw = constructIssue('unsupported_assembly', 'src/Vault.sol', 13);
    const first = buildEvidenceIndex(vaultInput([raw]));
    const second = buildEvidenceIndex(vaultInput([constructIssue('unsupported_assembly', 'src/Vault.sol', 13)]));

    const indexed = first.issuesByFile.get('src/Vault.sol')!;
    expect(indexed).toHaveLength(1);
    const record = indexed[0] as IndexedIssue;
    expect(record.id).toMatch(/^issue:[0-9a-f]{16}$/);
    expect(second.issuesByFile.get('src/Vault.sol')![0]!.id).toBe(record.id);
    expect('id' in raw).toBe(false);
  });

  it('shares one id across duplicate payloads and resolves every match in order', () => {
    const first = constructIssue('unsupported_assembly', 'src/Vault.sol', 13);
    const second = constructIssue('unsupported_assembly', 'src/Vault.sol', 13);
    second.message = 'worded differently';
    const index = buildEvidenceIndex(vaultInput([first, second]));

    const bucket = index.issuesByFile.get('src/Vault.sol')!;
    expect(bucket).toHaveLength(2);
    expect(bucket[0]!.id).toBe(bucket[1]!.id);
    const resolved = index.issuesById.get(bucket[0]!.id)!;
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toBe(bucket[0]);
    expect(resolved[1]).toBe(bucket[1]);
  });

  it('resolves the same id across buckets whose raw files normalize equally', () => {
    const index = buildEvidenceIndex(
      vaultInput([
        constructIssue('unsupported_assembly', 'a//b.sol', 5),
        constructIssue('unsupported_assembly', 'a/b.sol', 5),
      ]),
    );

    expect(index.issuesByFile.has('a//b.sol')).toBe(true);
    expect(index.issuesByFile.has('a/b.sol')).toBe(true);
    const left = index.issuesByFile.get('a//b.sol')![0]!.id;
    const right = index.issuesByFile.get('a/b.sol')![0]!.id;
    expect(left).toBe(right);
    expect(index.issuesById.get(left)).toHaveLength(2);
  });

  it('rejects absolute issue paths at the intake boundary', () => {
    const input = vaultInput([constructIssue('unsupported_assembly', '/abs/Vault.sol', 13)]);
    let caught: unknown;
    try {
      buildEvidenceIndex(input);
    } catch (error) {
      caught = error;
    }
    expect(isReconError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('InvalidIdentifier');
  });

  it('preserves existing issuesByFile grouping behavior', () => {
    const index = buildEvidenceIndex(
      vaultInput([
        constructIssue('unsupported_assembly', 'src/A.sol', 3),
        { severity: 'RECOVERABLE', code: 'b', message: 'b note' },
        constructIssue('unsupported_assembly', 'src/A.sol', 7),
      ]),
    );

    expect([...index.issuesByFile.keys()]).toEqual(['src/A.sol', '']);
    expect(index.issuesByFile.get('src/A.sol')!.map((issue) => issue.code)).toEqual([
      'unsupported_assembly',
      'unsupported_assembly',
    ]);
    expect(index.issuesByFile.get('')!.map((issue) => issue.code)).toEqual(['b']);
  });
});
