import { describe, expect, it } from 'vitest';
import type { ReconIssue } from '../../src/recon/issues.js';
import { deriveEntries, type DeriveOutcome } from '../../src/scope/derive.js';
import type { FileRecord, NotFoundRecord, ScopeInventory } from '../../src/scope/inventory.js';
import type { EmbeddedIssue, ScopeEvidence } from '../../src/scope/model.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const RUN_MESSAGE = 'solidity compilation failed: unexpected token';

const RUN_ERROR: ScopeEvidence = {
  kind: 'run_error',
  stage: 'compile',
  error_class: 'CompilationFailed',
  message: RUN_MESSAGE,
};

function onDisk(path: string, sha256 = SHA_A): FileRecord {
  return { path, sha256, bytes: 1024, excluded_rule: null };
}

function excludedFile(path: string, excluded_rule: string, limit_bytes?: number): FileRecord {
  const record: FileRecord = { path, sha256: '', bytes: 0, excluded_rule };
  if (limit_bytes !== undefined) record.limit_bytes = limit_bytes;
  return record;
}

function inventory(files: FileRecord[], not_found: NotFoundRecord[] = []): ScopeInventory {
  return { files, not_found };
}

function reconIssue(over: Partial<ReconIssue> = {}): ReconIssue {
  return { severity: 'RECOVERABLE', code: 'note', message: 'issue message', ...over };
}

function completedOutcome(issues: readonly ReconIssue[] = []): DeriveOutcome {
  return { kind: 'completed', issues, fidelity: 'semantic' };
}

function failedOutcome(
  over: Partial<Extract<DeriveOutcome, { kind: 'failed' }>> = {},
): Extract<DeriveOutcome, { kind: 'failed' }> {
  return {
    kind: 'failed',
    stage: 'compile',
    error_class: 'CompilationFailed',
    message: RUN_MESSAGE,
    ...over,
  };
}

function issueEvidence(issue: EmbeddedIssue): ScopeEvidence {
  return { kind: 'issue', issue };
}

describe('deriveEntries — truth table: one fixture per status', () => {
  it('excluded file derives EXCLUDED with exclude_rule evidence', () => {
    const entries = deriveEntries(
      inventory([excludedFile('vendor/V.sol', 'config:excludes:vendor/**')]),
      completedOutcome(),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'vendor/V.sol',
        status: 'EXCLUDED',
        evidence: [{ kind: 'exclude_rule', rule: 'config:excludes:vendor/**' }],
      },
    ]);
  });

  it('dir marker and type:non-file records derive EXCLUDED with exclude_rule evidence', () => {
    const entries = deriveEntries(
      inventory([
        excludedFile('node_modules', 'always:node_modules'),
        excludedFile('contracts/sub', 'type:non-file'),
      ]),
      completedOutcome(),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'contracts/sub',
        status: 'EXCLUDED',
        evidence: [{ kind: 'exclude_rule', rule: 'type:non-file' }],
      },
      {
        target_type: 'source_file',
        path: 'node_modules',
        status: 'EXCLUDED',
        evidence: [{ kind: 'exclude_rule', rule: 'always:node_modules' }],
      },
    ]);
  });

  it('limit:maxFileBytes exclusion derives EXCLUDED with size_limit evidence carrying limit_bytes', () => {
    const entries = deriveEntries(
      inventory([excludedFile('contracts/Big.sol', 'limit:maxFileBytes', 1_000_000)]),
      completedOutcome(),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'contracts/Big.sol',
        status: 'EXCLUDED',
        evidence: [{ kind: 'size_limit', limit_bytes: 1_000_000 }],
      },
    ]);
  });

  it('literal include miss derives NOT_FOUND with walk_miss evidence', () => {
    const entries = deriveEntries(
      inventory([], [{ path: 'contracts/Ghost.sol', include: 'contracts/Ghost.sol' }]),
      completedOutcome(),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'contracts/Ghost.sol',
        status: 'NOT_FOUND',
        evidence: [{ kind: 'walk_miss', include: 'contracts/Ghost.sol' }],
      },
    ]);
  });

  it('on-disk file in a completed run derives ANALYZED with analysis evidence', () => {
    const entries = deriveEntries(inventory([onDisk('src/A.sol', SHA_A)]), completedOutcome());
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'ANALYZED',
        evidence: [{ kind: 'analysis', sha256: SHA_A }],
      },
    ]);
  });

  it('attributable UNKNOWN issue derives UNRESOLVED with all attributable issues and analysis', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A), onDisk('src/B.sol', SHA_B)]),
      completedOutcome([
        reconIssue({ file: 'src/A.sol', severity: 'UNKNOWN', code: 'call_target_unresolved' }),
        reconIssue({ file: 'src/A.sol', code: 'unused_import' }),
        reconIssue({ file: 'src/B.sol', severity: 'UNKNOWN', code: 'other_file_unknown' }),
      ]),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'UNRESOLVED',
        evidence: [
          { kind: 'analysis', sha256: SHA_A },
          issueEvidence({
            code: 'call_target_unresolved',
            severity: 'UNKNOWN',
            message: 'issue message',
            file: 'src/A.sol',
            count: 1,
          }),
          issueEvidence({
            code: 'unused_import',
            severity: 'RECOVERABLE',
            message: 'issue message',
            file: 'src/A.sol',
            count: 1,
          }),
        ],
      },
      {
        target_type: 'source_file',
        path: 'src/B.sol',
        status: 'UNRESOLVED',
        evidence: [
          { kind: 'analysis', sha256: SHA_B },
          issueEvidence({
            code: 'other_file_unknown',
            severity: 'UNKNOWN',
            message: 'issue message',
            file: 'src/B.sol',
            count: 1,
          }),
        ],
      },
    ]);
  });

  it('attributable compilation_failed issue derives UNSUPPORTED with issue evidence and no analysis', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      completedOutcome([
        reconIssue({
          file: 'src/A.sol',
          code: 'compilation_failed',
          severity: 'RECOVERABLE',
          message: 'dropping src/A.sol: syntax errors prevent parsing',
        }),
      ]),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'UNSUPPORTED',
        evidence: [
          issueEvidence({
            code: 'compilation_failed',
            severity: 'RECOVERABLE',
            message: 'dropping src/A.sol: syntax errors prevent parsing',
            file: 'src/A.sol',
            count: 1,
          }),
        ],
      },
    ]);
    expect(
      entries.every((entry) => entry.evidence.every((item) => item.kind !== 'analysis')),
    ).toBe(true);
  });

  it('failed outcome with no attribution derives FAILED with verbatim run_error', () => {
    const entries = deriveEntries(inventory([onDisk('src/A.sol', SHA_A)]), failedOutcome());
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'FAILED',
        evidence: [RUN_ERROR],
      },
    ]);
    const evidence = entries[0]?.evidence[0];
    if (evidence?.kind !== 'run_error') throw new Error('expected run_error evidence');
    expect(evidence.message).toBe(RUN_MESSAGE);
  });
});

describe('deriveEntries — absence pins', () => {
  it('zero-findings file derives ANALYZED', () => {
    const entries = deriveEntries(inventory([onDisk('src/Empty.sol', SHA_A)]), completedOutcome());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('ANALYZED');
    expect(entries[0]?.evidence).toEqual([{ kind: 'analysis', sha256: SHA_A }]);
  });

  it('syntactic_fallback without attributable UNKNOWN derives ANALYZED with fidelity marker (OD-4)', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      completedOutcome([
        reconIssue({
          file: 'src/A.sol',
          code: 'syntactic_fallback',
          severity: 'RECOVERABLE',
          message: 'semantic compilation failed for src/A.sol; analysing its syntax only',
        }),
      ]),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'ANALYZED',
        evidence: [
          { kind: 'analysis', sha256: SHA_A },
          issueEvidence({
            code: 'syntactic_fallback',
            severity: 'RECOVERABLE',
            message: 'semantic compilation failed for src/A.sol; analysing its syntax only',
            file: 'src/A.sol',
            count: 1,
          }),
        ],
      },
    ]);
  });

  it('syntactic_fallback with attributable UNKNOWN derives UNRESOLVED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      completedOutcome([
        reconIssue({ file: 'src/A.sol', code: 'syntactic_fallback' }),
        reconIssue({ file: 'src/A.sol', severity: 'UNKNOWN', code: 'storage_slot_unresolved' }),
      ]),
    );
    const entry = entries[0];
    expect(entry?.status).toBe('UNRESOLVED');
    expect(entry?.evidence).toEqual([
      { kind: 'analysis', sha256: SHA_A },
      issueEvidence({
        code: 'storage_slot_unresolved',
        severity: 'UNKNOWN',
        message: 'issue message',
        file: 'src/A.sol',
        count: 1,
      }),
      issueEvidence({
        code: 'syntactic_fallback',
        severity: 'RECOVERABLE',
        message: 'issue message',
        file: 'src/A.sol',
        count: 1,
      }),
    ]);
  });

  it('run-level (file-less) UNKNOWN does not flip any entry [INV-13]', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      completedOutcome([reconIssue({ severity: 'UNKNOWN', code: 'run_level_unresolved' })]),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'ANALYZED',
        evidence: [{ kind: 'analysis', sha256: SHA_A }],
      },
    ]);
  });

  it('other-file UNKNOWN does not flip this entry', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A), onDisk('src/B.sol', SHA_B)]),
      completedOutcome([reconIssue({ file: 'src/B.sol', severity: 'UNKNOWN' })]),
    );
    expect(entries[0]?.status).toBe('ANALYZED');
    expect(entries[0]?.evidence).toEqual([{ kind: 'analysis', sha256: SHA_A }]);
    expect(entries[1]?.status).toBe('UNRESOLVED');
    expect(entries[1]?.evidence).toEqual([
      { kind: 'analysis', sha256: SHA_B },
      issueEvidence({
        code: 'note',
        severity: 'UNKNOWN',
        message: 'issue message',
        file: 'src/B.sol',
        count: 1,
      }),
    ]);
  });

  it('unsupported_* findings in a completed run leave the entry ANALYZED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      completedOutcome([
        reconIssue({
          file: 'src/A.sol',
          severity: 'UNSUPPORTED',
          code: 'unsupported_delegatecall',
          message: 'delegatecall pattern not modeled',
        }),
      ]),
    );
    expect(entries).toEqual([
      {
        target_type: 'source_file',
        path: 'src/A.sol',
        status: 'ANALYZED',
        evidence: [{ kind: 'analysis', sha256: SHA_A }],
      },
    ]);
  });
});

describe('deriveEntries — failed-outcome attribution (RF3, OD-3)', () => {
  it('unattributable CompilationFailed derives FAILED for every on-disk target, never UNSUPPORTED', () => {
    const messageNamingB = 'solidity compilation failed: src/B.sol: unexpected token';
    const entries = deriveEntries(
      inventory(
        [
          onDisk('src/A.sol', SHA_A),
          onDisk('src/B.sol', SHA_B),
          excludedFile('src/C.sol', 'config:excludes:src/C.sol'),
        ],
        [{ path: 'src/Ghost.sol', include: 'src/Ghost.sol' }],
      ),
      failedOutcome({
        dropped: [],
        issues: [
          reconIssue({
            file: 'src/Other.sol',
            code: 'compilation_failed',
            severity: 'RECOVERABLE',
            message: 'dropping src/Other.sol: syntax errors prevent parsing',
          }),
        ],
        message: messageNamingB,
      }),
    );

    expect(entries.map((entry) => [entry.path, entry.status])).toEqual([
      ['src/A.sol', 'FAILED'],
      ['src/B.sol', 'FAILED'],
      ['src/C.sol', 'EXCLUDED'],
      ['src/Ghost.sol', 'NOT_FOUND'],
    ]);
    expect(entries.some((entry) => entry.status === 'UNSUPPORTED')).toBe(false);
    expect(entries[1]?.evidence).toEqual([
      {
        kind: 'run_error',
        stage: 'compile',
        error_class: 'CompilationFailed',
        message: messageNamingB,
      },
    ]);
    expect(entries[0]?.evidence).toEqual([
      {
        kind: 'run_error',
        stage: 'compile',
        error_class: 'CompilationFailed',
        message: messageNamingB,
      },
    ]);
    expect(entries[2]?.evidence).toEqual([
      { kind: 'exclude_rule', rule: 'config:excludes:src/C.sol' },
    ]);
    expect(entries[3]?.evidence).toEqual([
      { kind: 'walk_miss', include: 'src/Ghost.sol' },
    ]);
  });

  it('partially attributed CompilationFailed: dropped path UNSUPPORTED, rest FAILED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A), onDisk('src/B.sol', SHA_B)]),
      failedOutcome({
        dropped: ['src/B.sol'],
        issues: [
          reconIssue({
            file: 'src/B.sol',
            code: 'compilation_failed',
            severity: 'RECOVERABLE',
            message: 'dropping src/B.sol: syntax errors prevent parsing',
          }),
        ],
      }),
    );
    expect(entries[0]).toEqual({
      target_type: 'source_file',
      path: 'src/A.sol',
      status: 'FAILED',
      evidence: [RUN_ERROR],
    });
    expect(entries[1]).toEqual({
      target_type: 'source_file',
      path: 'src/B.sol',
      status: 'UNSUPPORTED',
      evidence: [
        issueEvidence({
          code: 'compilation_failed',
          severity: 'RECOVERABLE',
          message: 'dropping src/B.sol: syntax errors prevent parsing',
          file: 'src/B.sol',
          count: 1,
        }),
      ],
    });
  });

  it('failed outcome with an attributable fallback issue derives FAILED, never ANALYZED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      failedOutcome({ issues: [reconIssue({ file: 'src/A.sol', code: 'syntactic_fallback' })] }),
    );
    expect(entries[0]?.status).toBe('FAILED');
    expect(entries[0]?.evidence).toEqual([RUN_ERROR]);
  });
});

describe('deriveEntries — precedence (§5.2)', () => {
  it('dropped path with attributable UNKNOWN issue derives UNSUPPORTED, not UNRESOLVED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A), onDisk('src/B.sol', SHA_B)]),
      failedOutcome({
        dropped: ['src/B.sol'],
        issues: [
          reconIssue({ file: 'src/B.sol', severity: 'UNKNOWN', code: 'call_target_unresolved' }),
        ],
      }),
    );
    expect(entries[1]).toEqual({
      target_type: 'source_file',
      path: 'src/B.sol',
      status: 'UNSUPPORTED',
      evidence: [
        issueEvidence({
          code: 'call_target_unresolved',
          severity: 'UNKNOWN',
          message: 'issue message',
          file: 'src/B.sol',
          count: 1,
        }),
      ],
    });
    expect(
      entries[1]?.evidence.every((item) => item.kind !== 'analysis'),
    ).toBe(true);
    expect(entries[0]?.status).toBe('FAILED');
  });

  it('failed outcome with attributable UNKNOWN (not dropped) derives FAILED, never UNRESOLVED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      failedOutcome({
        dropped: [],
        issues: [reconIssue({ file: 'src/A.sol', severity: 'UNKNOWN' })],
      }),
    );
    expect(entries[0]?.status).toBe('FAILED');
    expect(entries[0]?.evidence).toEqual([RUN_ERROR]);
  });

  it('completed outcome with compilation_failed issue derives UNSUPPORTED, never UNRESOLVED', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A)]),
      completedOutcome([
        reconIssue({ file: 'src/A.sol', code: 'compilation_failed' }),
        reconIssue({ file: 'src/A.sol', severity: 'UNKNOWN', code: 'call_target_unresolved' }),
      ]),
    );
    expect(entries[0]).toEqual({
      target_type: 'source_file',
      path: 'src/A.sol',
      status: 'UNSUPPORTED',
      evidence: [
        issueEvidence({
          code: 'call_target_unresolved',
          severity: 'UNKNOWN',
          message: 'issue message',
          file: 'src/A.sol',
          count: 1,
        }),
        issueEvidence({
          code: 'compilation_failed',
          severity: 'RECOVERABLE',
          message: 'issue message',
          file: 'src/A.sol',
          count: 1,
        }),
      ],
    });
    expect(
      entries[0]?.evidence.every((item) => item.kind !== 'analysis'),
    ).toBe(true);
  });
});

describe('deriveEntries — shape and determinism invariants', () => {
  it('output is sorted by compareCodeUnits(path) across files and not_found', () => {
    const entries = deriveEntries(
      inventory(
        [onDisk('src/b.sol', SHA_B), onDisk('src/A.sol', SHA_A), onDisk('src/a.sol', SHA_C)],
        [
          { path: 'src/C.sol', include: 'src/C.sol' },
          { path: 'src/Z.sol', include: 'src/Z.sol' },
        ],
      ),
      completedOutcome(),
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      'src/A.sol',
      'src/C.sol',
      'src/Z.sol',
      'src/a.sol',
      'src/b.sol',
    ]);
  });

  it('analysis.sha256 is the inventory file sha256 for each entry', () => {
    const entries = deriveEntries(
      inventory([onDisk('src/a.sol', SHA_A), onDisk('src/b.sol', SHA_B)]),
      completedOutcome(),
    );
    expect(entries[0]?.evidence).toEqual([{ kind: 'analysis', sha256: SHA_A }]);
    expect(entries[1]?.evidence).toEqual([{ kind: 'analysis', sha256: SHA_B }]);
  });

  it('every entry carries at least one evidence record', () => {
    const entries = deriveEntries(
      inventory(
        [
          onDisk('src/A.sol', SHA_A),
          excludedFile('src/B.sol', 'limit:maxFileBytes', 10),
          excludedFile('src/C.sol', 'type:non-file'),
        ],
        [{ path: 'src/D.sol', include: 'src/D.sol' }],
      ),
      completedOutcome(),
    );
    const failedEntries = deriveEntries(
      inventory([onDisk('src/A.sol', SHA_A), onDisk('src/B.sol', SHA_B)], [
        { path: 'src/D.sol', include: 'src/D.sol' },
      ]),
      failedOutcome({
        dropped: ['src/B.sol'],
        issues: [reconIssue({ file: 'src/B.sol', code: 'compilation_failed' })],
      }),
    );
    for (const entry of [...entries, ...failedEntries]) {
      expect(entry.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });
});
