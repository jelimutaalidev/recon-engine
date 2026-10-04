import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ReconError } from '../errors/errors.js';
import type { ReconConfig } from './config.js';
import { createReconIssue, type ReconIssue } from './issues.js';

export interface DiscoveredFile {
  path: string;
  absolute: string;
  sha256: string;
  bytes: number;
}

const ALWAYS_EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.recon-cache']);

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

function toPosixRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function escapeIssue(relativePath: string): ReconIssue {
  return createReconIssue({
    severity: 'FATAL',
    code: 'path_escape',
    message: `path resolves outside the analysis root: ${relativePath}`,
    file: relativePath,
  });
}

function assertInsideRoot(realRoot: string, absolutePath: string, relativePath: string): void {
  if (absolutePath !== realRoot && !absolutePath.startsWith(realRoot + sep)) {
    const issue = escapeIssue(relativePath);
    throw new ReconError('RootEscape', issue.message, { path: relativePath, issue });
  }
}

function sortPaths<T>(records: readonly T[], pick: (record: T) => string): T[] {
  return [...records].sort((a, b) => {
    const left = pick(a);
    const right = pick(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export async function discoverSources(
  config: ReconConfig,
): Promise<{ files: DiscoveredFile[]; issues: ReconIssue[] }> {
  const realRoot = realpathSync(config.root);
  const includeMatchers = config.includes.map(globToRegExp);
  const excludeMatchers = [
    ...config.excludes.map(globToRegExp),
    ...[...ALWAYS_EXCLUDED_DIRS].sort().map((name) => globToRegExp(`${name}/**`)),
  ];

  const matched: { path: string; absolute: string }[] = [];
  const visitedDirs = new Set<string>([realRoot]);
  const queue: string[] = [config.root];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of sortPaths(entries, (item) => item.name)) {
      const absolute = join(dir, entry.name);
      const path = toPosixRelative(config.root, absolute);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (ALWAYS_EXCLUDED_DIRS.has(entry.name)) continue;
        const real = realpathSync(absolute);
        const stats = statSync(real);
        if (stats.isDirectory()) {
          if (visitedDirs.has(real)) continue;
          visitedDirs.add(real);
          queue.push(absolute);
          continue;
        }
        if (!stats.isFile()) continue;
      } else if (!entry.isFile()) {
        continue;
      }
      if (!includeMatchers.some((matcher) => matcher.test(path))) continue;
      if (excludeMatchers.some((matcher) => matcher.test(path))) continue;
      const real = realpathSync(absolute);
      assertInsideRoot(realRoot, real, path);
      matched.push({ path, absolute });
      if (matched.length > config.limits.maxFiles) {
        const issue = createReconIssue({
          severity: 'FATAL',
          code: 'too_many_files',
          message: `more than ${config.limits.maxFiles} solidity sources found under the root`,
        });
        throw new ReconError('SourceLimitExceeded', issue.message, { issue });
      }
    }
  }

  if (matched.length === 0) {
    const issue = createReconIssue({
      severity: 'FATAL',
      code: 'no_sources',
      message: 'no solidity sources matched the configured includes under the analysis root',
    });
    throw new ReconError('NoSourcesFound', issue.message, { issue });
  }

  const issues: ReconIssue[] = [];
  const files: DiscoveredFile[] = [];
  for (const candidate of sortPaths(matched, (record) => record.path)) {
    const absolute = realpathSync(candidate.absolute);
    assertInsideRoot(realRoot, absolute, candidate.path);
    const buffer = readFileSync(absolute);
    if (buffer.byteLength > config.limits.maxFileBytes) {
      issues.push(
        createReconIssue({
          severity: 'RECOVERABLE',
          code: 'file_too_large',
          message: `file exceeds the ${config.limits.maxFileBytes} byte limit and was skipped`,
          file: candidate.path,
        }),
      );
      continue;
    }
    files.push({
      path: candidate.path,
      absolute,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.byteLength,
    });
  }

  issues.sort((a, b) =>
    (a.file ?? '') < (b.file ?? '')
      ? -1
      : (a.file ?? '') > (b.file ?? '')
        ? 1
        : a.code < b.code
          ? -1
          : a.code > b.code
            ? 1
            : 0,
  );
  return { files, issues };
}
