import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

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

export function gitToplevelMatches(root: string): boolean {
  try {
    const toplevel = runGit(root, ['rev-parse', '--show-toplevel']).trim();
    return normalizePathForCompare(toplevel) === normalizePathForCompare(root);
  } catch {
    return false;
  }
}
