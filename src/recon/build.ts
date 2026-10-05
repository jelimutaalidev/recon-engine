import { basename } from 'node:path';
import { createProject } from '../domain/project.js';
import type { ReconState } from '../recon-state/schema.js';
import { createReconState } from '../recon-state/state.js';
import type { ReconConfig } from './config.js';
import type { StatePatch } from './extract/index.js';
import { gitToplevelMatches, runGit } from './timestamp.js';

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
  git: GitContext;
  repository: string | undefined;
  timestamp: string;
}

export function buildState(input: BuildStateInput): ReconState {
  const project = createProject({
    name: input.config.projectName ?? basename(input.config.root),
    ...(input.repository !== undefined ? { repository: input.repository } : {}),
    ...(input.git.commit !== undefined ? { commit: input.git.commit } : {}),
    created_at: input.timestamp,
    updated_at: input.timestamp,
  });
  return createReconState({
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
  });
}
