import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { ReconError } from '../errors/errors.js';
import type { ReconConfig } from '../recon/config.js';
import {
  ALWAYS_EXCLUDED_DIRS,
  assertInsideRoot,
  globToRegExp,
  sortPaths,
} from '../recon/discover.js';
import { compareCodeUnits } from '../util/canonical.js';

export interface FileRecord {
  path: string;
  sha256: string;
  bytes: number;
  excluded_rule: string | null;
  limit_bytes?: number;
}

export interface NotFoundRecord {
  path: string;
  include: string;
}

export interface ScopeInventory {
  files: FileRecord[];
  not_found: NotFoundRecord[];
}

function toPosixRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function isLiteralPattern(pattern: string): boolean {
  return !pattern.includes('*') && !pattern.includes('?');
}

function normalizeLiteral(pattern: string): string {
  const posixPattern = pattern.replace(/\\/g, '/');
  let stripped = posixPattern;
  while (stripped.startsWith('./')) {
    stripped = stripped.slice(2);
  }
  return posix.normalize(stripped);
}

function escapesRoot(normalized: string): boolean {
  return normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized);
}

export async function buildInventory(config: ReconConfig): Promise<ScopeInventory> {
  const literals: string[] = [];
  const seenLiterals = new Set<string>();
  for (const pattern of config.includes) {
    if (!isLiteralPattern(pattern)) continue;
    const normalized = normalizeLiteral(pattern);
    if (escapesRoot(normalized)) {
      throw new ReconError('RootEscape', `include pattern escapes the analysis root: ${pattern}`, {
        path: normalized,
        include: pattern,
      });
    }
    if (!seenLiterals.has(normalized)) {
      seenLiterals.add(normalized);
      literals.push(normalized);
    }
  }

  const not_found: NotFoundRecord[] = [];
  for (const literal of literals) {
    let exists = false;
    try {
      statSync(join(config.root, literal));
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      not_found.push({ path: literal, include: literal });
    }
  }

  const realRoot = realpathSync(config.root);
  const includeMatchers = config.includes.map(globToRegExp);
  const excludeMatchers = config.excludes.map((pattern) => ({
    pattern,
    matcher: globToRegExp(pattern),
  }));

  const records: FileRecord[] = [];
  let matched = 0;
  const visitedDirs = new Set<string>([realRoot]);
  const queue: string[] = [config.root];

  const matchesInclude = (path: string): boolean =>
    includeMatchers.some((matcher) => matcher.test(path));

  const excludedBy = (path: string): string | undefined =>
    excludeMatchers.find((entry) => entry.matcher.test(path))?.pattern;

  const unreadRecord = (path: string, excluded_rule: string): FileRecord => ({
    path,
    sha256: '',
    bytes: 0,
    excluded_rule,
  });

  const declineRecord = (absolute: string, path: string): void => {
    if (!matchesInclude(path)) return;
    const pattern = excludedBy(path);
    if (pattern !== undefined) {
      records.push(unreadRecord(path, `config:excludes:${pattern}`));
      return;
    }
    assertInsideRoot(realRoot, realpathSync(absolute), path);
    records.push(unreadRecord(path, 'type:non-file'));
  };

  while (queue.length > 0) {
    const dir = queue.pop() as string;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of sortPaths(entries, (item) => item.name)) {
      const absolute = join(dir, entry.name);
      const path = toPosixRelative(config.root, absolute);

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (ALWAYS_EXCLUDED_DIRS.has(entry.name)) {
          records.push(unreadRecord(path, `always:${entry.name}`));
          continue;
        }
        const real = realpathSync(absolute);
        const stats = statSync(real);
        if (stats.isDirectory()) {
          if (visitedDirs.has(real)) continue;
          visitedDirs.add(real);
          if (matchesInclude(path)) {
            const pattern = excludedBy(path);
            if (pattern !== undefined) {
              records.push(unreadRecord(path, `config:excludes:${pattern}`));
            } else {
              assertInsideRoot(realRoot, real, path);
              records.push(unreadRecord(path, 'type:non-file'));
            }
          }
          queue.push(absolute);
          continue;
        }
        if (!stats.isFile()) {
          declineRecord(absolute, path);
          continue;
        }
      } else if (!entry.isFile()) {
        declineRecord(absolute, path);
        continue;
      }

      if (!matchesInclude(path)) continue;
      const pattern = excludedBy(path);
      if (pattern !== undefined) {
        records.push(unreadRecord(path, `config:excludes:${pattern}`));
        continue;
      }
      const real = realpathSync(absolute);
      assertInsideRoot(realRoot, real, path);
      const buffer = readFileSync(real);
      const bytes = buffer.byteLength;
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      if (bytes > config.limits.maxFileBytes) {
        records.push({
          path,
          sha256,
          bytes,
          excluded_rule: 'limit:maxFileBytes',
          limit_bytes: config.limits.maxFileBytes,
        });
      } else {
        records.push({ path, sha256, bytes, excluded_rule: null });
      }
      matched += 1;
      if (matched > config.limits.maxFiles) {
        throw new ReconError(
          'SourceLimitExceeded',
          `more than ${config.limits.maxFiles} solidity sources found under the root`,
          { max_files: config.limits.maxFiles },
        );
      }
    }
  }

  records.sort((a, b) => compareCodeUnits(a.path, b.path));
  not_found.sort((a, b) => compareCodeUnits(a.path, b.path));
  return { files: records, not_found };
}
