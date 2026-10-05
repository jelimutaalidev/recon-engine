import { compileProject } from './backend/solc/compile.js';
import { buildState, resolveGitContext, resolveProjectRepository } from './build.js';
import type { ReconConfig } from './config.js';
import { discoverSources } from './discover.js';
import { createProvenanceFactory, runExtractorsWithLineage } from './extract/index.js';
import { buildIr } from './ir/build.js';
import { sortIssues, type ReconIssue } from './issues.js';
import type { ReconState } from '../recon-state/schema.js';
import { resolveTimestamp } from './timestamp.js';

export interface AnalysisResult {
  state: ReconState;
  issues: ReconIssue[];
  meta: {
    solcLongVersion: string;
    timestamp: string;
    fidelity: 'semantic' | 'syntactic';
    fileCount: number;
  };
}

export async function analyzeProject(config: ReconConfig): Promise<AnalysisResult> {
  const time = resolveTimestamp(config);
  const git = resolveGitContext(config);
  const repository = resolveProjectRepository(config, git);
  const effective: ReconConfig = { ...config, timestamp: time.timestamp };

  const discovered = await discoverSources(effective);
  const compiled = await compileProject(effective, discovered.files);
  const { ir, issues: irIssues } = buildIr(compiled, discovered.files);
  const { patch, perExtractor } = runExtractorsWithLineage({
    ir,
    config: effective,
    provenance: createProvenanceFactory({
      ...(repository !== undefined ? { repository } : {}),
      ...(git.commit !== undefined ? { commit: git.commit } : {}),
    }),
  });
  const state = buildState({
    config: effective,
    patch,
    perExtractor,
    git,
    repository,
    timestamp: time.timestamp,
    files: discovered.files,
    solcLongVersion: compiled.longVersion,
    fidelity: compiled.fidelity,
  });
  const issues = sortIssues([
    ...(time.issue !== undefined ? [time.issue] : []),
    ...discovered.issues,
    ...compiled.issues,
    ...irIssues,
    ...patch.issues,
  ]);
  return {
    state,
    issues,
    meta: {
      solcLongVersion: compiled.longVersion,
      timestamp: time.timestamp,
      fidelity: compiled.fidelity,
      fileCount: discovered.files.length,
    },
  };
}
