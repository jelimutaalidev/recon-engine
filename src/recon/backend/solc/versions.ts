import { createHash } from 'node:crypto';
import { ReconError } from '../../../errors/errors.js';
import type { ReconConfig } from '../../config.js';

export type VersionSource = 'bundled' | 'cache' | 'download';

export interface VersionSelection {
  shortVersion: string;
  source: VersionSource;
}

export interface AvailableVersions {
  bundled?: string | undefined;
  cached: readonly string[];
  released: readonly string[];
}

type SemVer = [number, number, number];

function parseSemVer(value: string): SemVer | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemVer(left: SemVer, right: SemVer): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}

function compareVersionStringsDesc(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (a !== undefined && b !== undefined) return compareSemVer(b, a);
  if (a !== undefined) return -1;
  if (b !== undefined) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parsePragmas(source: string): string[] {
  const pragmas: string[] = [];
  const pattern = /\bpragma\s+solidity\s+([^;]+);/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[1];
    if (text === undefined) continue;
    const trimmed = text.trim();
    if (trimmed.length > 0) pragmas.push(trimmed);
  }
  return pragmas;
}

function caretUpperBound(target: SemVer): SemVer {
  if (target[0] > 0) return [target[0] + 1, 0, 0];
  if (target[1] > 0) return [0, target[1] + 1, 0];
  return [0, 0, target[2] + 1];
}

function satisfiesConstraint(version: SemVer, token: string): boolean {
  const match = /^(\^|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token.trim());
  if (match === null) return false;
  const operator = match[1] ?? '=';
  const target = parseSemVer(match[2] as string);
  if (target === undefined) return false;
  const order = compareSemVer(version, target);
  switch (operator) {
    case '=':
      return order === 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '^': {
      if (order < 0) return false;
      return compareSemVer(version, caretUpperBound(target)) < 0;
    }
    default:
      return false;
  }
}

export function satisfies(version: string, pragmaRange: string): boolean {
  const parsed = parseSemVer(version);
  if (parsed === undefined) return false;
  const groups = pragmaRange.split('||');
  return groups.some((group) => {
    const tokens = group.split(/\s+/).filter((token) => token.length > 0 && token !== '&&');
    if (tokens.length === 0) return false;
    return tokens.every((token) => satisfiesConstraint(parsed, token));
  });
}

function unavailable(message: string, details: Record<string, unknown>): ReconError {
  return new ReconError('CompilerUnavailable', message, details);
}

export function selectVersion(
  config: Pick<ReconConfig, 'solcVersion' | 'compilerSource'>,
  pragmas: readonly string[],
  available: AvailableVersions,
): VersionSelection {
  const constraints = pragmas.map((pragma) => pragma.trim()).filter((pragma) => pragma.length > 0);

  if (config.solcVersion !== undefined) {
    const pinned = config.solcVersion;
    if (available.bundled === pinned) return { shortVersion: pinned, source: 'bundled' };
    if (available.cached.includes(pinned)) return { shortVersion: pinned, source: 'cache' };
    if (config.compilerSource === 'cache-only') {
      throw unavailable(`compiler ${pinned} is not available in cache-only mode`, {
        version: pinned,
        compilerSource: 'cache-only',
      });
    }
    return { shortVersion: pinned, source: 'download' };
  }

  const local: VersionSelection[] = [];
  if (available.bundled !== undefined) {
    local.push({ shortVersion: available.bundled, source: 'bundled' });
  }
  for (const cached of [...available.cached].sort(compareVersionStringsDesc)) {
    if (cached !== available.bundled) local.push({ shortVersion: cached, source: 'cache' });
  }
  const sortedLocal = local.sort((a, b) =>
    a.shortVersion === b.shortVersion
      ? 0
      : compareVersionStringsDesc(a.shortVersion, b.shortVersion) ||
        (a.source === 'bundled' ? -1 : b.source === 'bundled' ? 1 : 0),
  );

  const satisfyingLocal = sortedLocal.filter((selection) =>
    constraints.every((constraint) => satisfies(selection.shortVersion, constraint)),
  );
  const bestLocal = satisfyingLocal[0];
  if (bestLocal !== undefined) return bestLocal;

  if (constraints.length === 0) {
    const fallback = sortedLocal[0];
    if (fallback !== undefined) return fallback;
    throw unavailable('no solidity compiler is available for this analysis', {});
  }

  if (config.compilerSource === 'cache-only') {
    throw unavailable('no cached solidity compiler satisfies the source pragmas', {
      pragmas: [...constraints],
      compilerSource: 'cache-only',
    });
  }

  const satisfyingReleased = [...available.released]
    .sort(compareVersionStringsDesc)
    .find((released) => constraints.every((constraint) => satisfies(released, constraint)));
  if (satisfyingReleased !== undefined) {
    return { shortVersion: satisfyingReleased, source: 'download' };
  }

  throw new ReconError(
    'VersionConflict',
    'no released solidity version satisfies all source pragmas',
    { pragmas: [...constraints] },
  );
}

export function verifyChecksum(expectedSha256: string, bytes: Buffer): boolean {
  const actual = createHash('sha256').update(bytes).digest('hex');
  const expected = expectedSha256.trim().replace(/^0x/i, '').toLowerCase();
  return actual === expected;
}

export function longVersionFromBuildPath(buildPath: string): string {
  const fileName = buildPath.split('/').pop() ?? buildPath;
  return fileName.replace(/^soljson-v/, '').replace(/\.js$/, '');
}
