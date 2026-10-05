import { basename } from 'node:path';
import { createProject } from '../domain/project.js';
import type { ReconState, ReconStateInput } from '../recon-state/schema.js';
import { createReconState } from '../recon-state/state.js';
import { buildTraceability } from '../traceability/build.js';
import {
  computeCompilerIdentity,
  computeConfigHash,
  computeInputManifestHash,
  computeOutputIdentity,
  computeSourceIdentity,
  createRunId,
  type InputManifestPayload,
} from '../traceability/identities.js';
import { ANALYZER_VERSION } from '../version.js';
import type { ReconConfig } from './config.js';
import type { StatePatch } from './extract/index.js';
import { gitToplevelMatches, runGit } from './git.js';

export interface GitContext {
  repository?: string | undefined;
  commit?: string | undefined;
}

export function resolveGitContext(config: ReconConfig): GitContext {
  if (!config.recordGit || !gitToplevelMatches(config.root)) return {};
  let commit: string | undefined;
  try {
    const value = runGit(config.root, ['rev-parse', 'HEAD']).trim();
    if (value.length > 0) commit = value;
  } catch {
    commit = undefined;
  }
  if (commit === undefined) return {};
  const context: GitContext = { commit };
  try {
    const remote = runGit(config.root, ['remote', 'get-url', 'origin']).trim();
    if (remote.length > 0) context.repository = remote;
  } catch {
    // no origin remote; repository identity stays absent
  }
  return context;
}

export function resolveProjectRepository(
  config: ReconConfig,
  git: GitContext,
): string | undefined {
  if (config.repository !== undefined) return config.repository;
  return git.repository;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export interface BuildStateInput {
  config: ReconConfig;
  patch: StatePatch;
  perExtractor: readonly { operation: string; patch: StatePatch }[];
  git: GitContext;
  repository: string | undefined;
  timestamp: string;
  files: readonly { path: string; sha256: string; bytes: number }[];
  solcLongVersion: string;
  fidelity: 'semantic' | 'syntactic';
}

export function buildState(input: BuildStateInput): ReconState {
  const project = createProject({
    name: input.config.projectName ?? basename(input.config.root),
    ...(input.repository !== undefined ? { repository: input.repository } : {}),
    ...(input.git.commit !== undefined ? { commit: input.git.commit } : {}),
    created_at: input.timestamp,
    updated_at: input.timestamp,
  });
  const baseInput: ReconStateInput = {
    project,
    contracts: sortById(input.patch.contracts),
    functions: sortById(input.patch.functions),
    state_variables: sortById(input.patch.state_variables),
    relationships: sortById(input.patch.relationships),
    facts: sortById(input.patch.facts),
    assets: [],
    roles: [],
    dependencies: [],
    observations: [],
    assumptions: [],
    hypotheses: [],
    evidence: [],
  };
  const base = createReconState(baseInput);

  const sourceIdentity = computeSourceIdentity(input.files, input.git, basename(input.config.root));
  const compilerIdentity = computeCompilerIdentity(input.solcLongVersion);
  const configurationIdentity = { config_hash: computeConfigHash(input.config) };
  const manifestPayload: InputManifestPayload = {
    sourceIdentity,
    configHash: configurationIdentity.config_hash,
    compilerIdentity,
    analyzerVersion: ANALYZER_VERSION,
    schemaVersion: base.schema_version,
  };
  const traceability = buildTraceability({
    projectId: project.id,
    startedAt: input.timestamp,
    schemaVersion: base.schema_version,
    sourceIdentity,
    compilerIdentity,
    configurationIdentity,
    inputManifestHash: computeInputManifestHash(manifestPayload),
    runId: createRunId(manifestPayload),
    outputIdentity: computeOutputIdentity(base),
    perExtractor: input.perExtractor,
    mergedPatch: input.patch,
    fidelity: input.fidelity,
  });

  return createReconState({ ...baseInput, traceability });
}
