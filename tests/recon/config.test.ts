import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseReconConfig } from '../../src/recon/config.js';
import { createReconIssue, sortIssues } from '../../src/recon/issues.js';
import { resolveTimestamp } from '../../src/recon/timestamp.js';
import { ReconError } from '../../src/errors/errors.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initGitRepo(dir: string, isoDate: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
    GIT_AUTHOR_NAME: 'recon-test',
    GIT_AUTHOR_EMAIL: 'recon@test.local',
    GIT_COMMITTER_NAME: 'recon-test',
    GIT_COMMITTER_EMAIL: 'recon@test.local',
  };
  execFileSync('git', ['init'], { cwd: dir, env });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: dir, env });
}

describe('parseReconConfig', () => {
  it('applies documented defaults', () => {
    const config = parseReconConfig({ root: 'C:/repos/vault' });
    expect(config.root).toBe('C:/repos/vault');
    expect(config.compilerSource).toBe('auto');
    expect(config.recordGit).toBe(true);
    expect(config.limits?.maxFileBytes).toBe(2 * 1024 * 1024);
    expect(config.limits?.maxFiles).toBe(5000);
    expect(config.limits?.timeoutMs).toBe(60_000);
    expect(config.includes).toEqual(['**/*.sol']);
  });

  it('rejects a missing root', () => {
    expect(() => parseReconConfig({})).toThrow(ReconError);
  });

  it('rejects an unknown compiler source', () => {
    expect(() =>
      parseReconConfig({ root: 'C:/x', compilerSource: 'network' }),
    ).toThrow(ReconError);
  });

  it('rejects an unparseable explicit timestamp', () => {
    expect(() => parseReconConfig({ root: 'C:/x', timestamp: 'yesterday' })).toThrow(ReconError);
  });

  it('keeps explicit limits and excludes', () => {
    const config = parseReconConfig({
      root: 'C:/x',
      excludes: ['test/**'],
      limits: { maxFiles: 10 },
    });
    expect(config.excludes).toEqual(['test/**']);
    expect(config.limits?.maxFiles).toBe(10);
    expect(config.limits?.maxFileBytes).toBe(2 * 1024 * 1024);
  });
});

describe('createReconIssue / sortIssues', () => {
  it('accepts a well-formed issue', () => {
    const issue = createReconIssue({
      severity: 'RECOVERABLE',
      code: 'compilation_failed',
      message: 'file dropped after semantic and syntactic retry',
      file: 'src/Bad.sol',
      line_start: 3,
      line_end: 3,
    });
    expect(issue.code).toBe('compilation_failed');
    expect(issue.file).toBe('src/Bad.sol');
  });

  it('rejects an unknown severity', () => {
    expect(() =>
      createReconIssue({ severity: 'WARNING', code: 'x', message: 'y' }),
    ).toThrow(ReconError);
  });

  it('sorts deterministically by severity, code, file, line', () => {
    const issues = [
      createReconIssue({ severity: 'UNKNOWN', code: 'b', message: 'm' }),
      createReconIssue({ severity: 'FATAL', code: 'z', message: 'm' }),
      createReconIssue({ severity: 'RECOVERABLE', code: 'a', message: 'm', file: 'b.sol' }),
      createReconIssue({ severity: 'RECOVERABLE', code: 'a', message: 'm', file: 'a.sol' }),
    ];
    const sorted = sortIssues([...issues]);
    expect(sorted.map((issue) => issue.code)).toEqual(['z', 'a', 'a', 'b']);
    expect(sorted[1]?.file).toBe('a.sol');
    expect(sorted[2]?.file).toBe('b.sol');
  });
});

describe('resolveTimestamp', () => {
  let nonGitDir: string;

  beforeEach(() => {
    nonGitDir = makeTempDir('recon-nogit-');
  });

  afterEach(() => {
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it('prefers the explicit config timestamp (normalized to UTC Z)', () => {
    const config = parseReconConfig({
      root: nonGitDir,
      timestamp: '2026-10-03T12:00:00+07:00',
    });
    const resolved = resolveTimestamp(config);
    expect(resolved.source).toBe('config');
    expect(resolved.timestamp).toBe('2026-10-03T05:00:00.000Z');
    expect(resolved.issue).toBeUndefined();
  });

  it('falls back to epoch outside a git repo, with a RECOVERABLE issue', () => {
    const config = parseReconConfig({ root: nonGitDir });
    const resolved = resolveTimestamp(config);
    expect(resolved.source).toBe('epoch');
    expect(resolved.timestamp).toBe('1970-01-01T00:00:00Z');
    expect(resolved.issue?.severity).toBe('RECOVERABLE');
    expect(resolved.issue?.code).toBe('git_unavailable');
  });

  it('uses git HEAD committer time when the root is the git root', () => {
    const repoDir = makeTempDir('recon-git-');
    try {
      initGitRepo(repoDir, '2026-01-02T03:04:05+00:00');
      const config = parseReconConfig({ root: repoDir });
      const resolved = resolveTimestamp(config);
      expect(resolved.source).toBe('git');
      expect(resolved.timestamp).toBe('2026-01-02T03:04:05.000Z');
      expect(resolved.issue).toBeUndefined();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('treats a nested directory inside a larger repo as NOT the git root', () => {
    const repoDir = makeTempDir('recon-nested-');
    try {
      initGitRepo(repoDir, '2026-01-02T03:04:05+00:00');
      const nested = join(repoDir, 'packages');
      mkdirSync(nested, { recursive: true });
      const config = parseReconConfig({ root: resolve(nested) });
      const resolved = resolveTimestamp(config);
      expect(resolved.source).toBe('epoch');
      expect(resolved.issue?.code).toBe('git_unavailable');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('never touches git when recordGit is false', () => {
    const repoDir = makeTempDir('recon-nogitcfg-');
    try {
      initGitRepo(repoDir, '2026-01-02T03:04:05+00:00');
      const config = parseReconConfig({ root: repoDir, recordGit: false });
      const resolved = resolveTimestamp(config);
      expect(resolved.source).toBe('epoch');
      expect(resolved.issue).toBeUndefined();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
