import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { ReconConfig } from './config.js';
import { createReconIssue, type ReconIssue } from './issues.js';

const EPOCH_TIMESTAMP = '1970-01-01T00:00:00Z';

export interface ResolvedTimestamp {
  timestamp: string;
  source: 'config' | 'git' | 'epoch';
  issue?: ReconIssue | undefined;
}

export function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    windowsHide: true,
  });
}

export function normalizePathForCompare(path: string): string {
  const real = realpathSync(path);
  return real.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function readGitHeadTime(root: string): string | undefined {
  try {
    const toplevel = runGit(root, ['rev-parse', '--show-toplevel']).trim();
    if (normalizePathForCompare(toplevel) !== normalizePathForCompare(root)) {
      return undefined;
    }
    const iso = runGit(root, ['log', '-1', '--format=%cI']).trim();
    if (iso.length === 0) return undefined;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  } catch {
    return undefined;
  }
}

export function gitToplevelMatches(root: string): boolean {
  try {
    const toplevel = runGit(root, ['rev-parse', '--show-toplevel']).trim();
    return normalizePathForCompare(toplevel) === normalizePathForCompare(root);
  } catch {
    return false;
  }
}

export function resolveTimestamp(config: ReconConfig): ResolvedTimestamp {
  if (config.timestamp !== undefined) {
    return { timestamp: new Date(config.timestamp).toISOString(), source: 'config' };
  }
  if (config.recordGit) {
    const gitTime = readGitHeadTime(config.root);
    if (gitTime !== undefined) {
      return { timestamp: gitTime, source: 'git' };
    }
    return {
      timestamp: EPOCH_TIMESTAMP,
      source: 'epoch',
      issue: createReconIssue({
        severity: 'RECOVERABLE',
        code: 'git_unavailable',
        message:
          'git HEAD committer time unavailable (not a git root or git failed); using epoch fallback',
      }),
    };
  }
  return { timestamp: EPOCH_TIMESTAMP, source: 'epoch' };
}
