import { createHash } from 'node:crypto';
import { contentId } from '../ids/ids.js';
import type { ReconConfig } from '../recon/config.js';
import { computeSourceHash } from '../recon/source-hash.js';
import type { ReconState } from '../recon-state/schema.js';
import { serializeReconState } from '../recon-state/state.js';
import { stableStringify } from '../util/canonical.js';
import type {
  CompilerIdentity,
  OutputIdentity,
  SourceIdentity,
  TraceReference,
} from './types.js';

const OUTPUT_SERIALIZATION = 'recon-state-json/v1';

export interface InputManifestPayload {
  sourceIdentity: SourceIdentity;
  configHash: string;
  compilerIdentity: CompilerIdentity;
  analyzerVersion: string;
  schemaVersion: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function computeManifestHash(
  files: readonly { path: string; sha256: string; bytes: number }[],
): string {
  return sha256Hex(stableStringify([...files].sort(byPath)));
}

export function computeConfigHash(config: ReconConfig): string {
  const { root: _root, timestamp: _timestamp, includes, excludes, ...rest } = config;
  return stableStringify({
    ...rest,
    includes: [...includes].sort(),
    excludes: [...excludes].sort(),
  });
}

export function computeCompilerIdentity(
  longVersion: string,
  binarySha256?: string,
): CompilerIdentity {
  return {
    compiler: 'solc',
    version: longVersion,
    backend: 'solc-js',
    ...(binarySha256 !== undefined ? { binary_hash: `sha256:${binarySha256}` } : {}),
  };
}

export function computeSourceIdentity(
  files: readonly { path: string; sha256: string; bytes: number }[],
  git: { repository?: string; commit?: string },
  sourceRoot: string,
): SourceIdentity {
  return {
    source_hash: computeSourceHash(files),
    manifest_hash: computeManifestHash(files),
    ...(git.repository !== undefined ? { repository: git.repository } : {}),
    ...(git.commit !== undefined ? { commit: git.commit } : {}),
    ...(sourceRoot.length > 0 ? { source_root: sourceRoot } : {}),
  };
}

export function computeInputManifestHash(payload: InputManifestPayload): string {
  return sha256Hex(stableStringify(payload));
}

export function createRunId(payload: InputManifestPayload): string {
  return contentId('run', payload);
}

export function derivationId(
  runId: string,
  operation: string,
  inputs: readonly TraceReference[],
  provenance: readonly string[],
): string {
  const canonical = {
    inputs: [...inputs].sort((left, right) => {
      const a = stableStringify(left);
      const b = stableStringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    provenance: [...provenance].sort(),
  };
  return `derivation:${runId}:${operation}:${sha256Hex(stableStringify(canonical)).slice(0, 16)}`;
}

export function entityContentHash(entity: unknown): string {
  return sha256Hex(stableStringify(entity));
}

export function computeOutputIdentity(state: ReconState): OutputIdentity {
  return {
    output_hash: sha256Hex(serializeReconState(state, { omitTraceability: true })),
    serialization: OUTPUT_SERIALIZATION,
  };
}
