import { isReconError } from '../errors/errors.js';
import type { ReconConfig } from '../recon/config.js';
import { analyzeProject, type AnalysisResult } from '../recon/index.js';
import { analyzeProjectScoped } from '../scope/analyze.js';
import type { ScopeReport } from '../scope/model.js';
import { computeOutputIdentity } from '../traceability/identities.js';
import { compareCodeUnits } from '../util/canonical.js';
import { deriveAccounting } from './accounting.js';
import { deriveAuthority } from './authority.js';
import { deriveAssets } from './custody.js';
import { buildEvidenceIndex, type SemanticInput } from './evidence.js';
import { deriveLadder } from './ladder.js';
import type { SemanticModel, SemanticStage } from './model.js';
import { finalizeSemanticModel } from './report.js';
import { deriveTransitions } from './transitions.js';
import { deriveTrust } from './trust.js';
import { validateSemanticModel } from './validate.js';

export interface AnalyzeSemanticDeps {
  analyze?: (c: ReconConfig) => Promise<AnalysisResult>;
}

function degradationFor(
  fidelity: 'semantic' | 'syntactic',
  scopeReport: ScopeReport | undefined,
): string[] {
  const parts: string[] = [];
  if (fidelity === 'syntactic') parts.push('syntactic_fidelity');
  if (scopeReport !== undefined) {
    for (const entry of scopeReport.entries) {
      if (entry.status === 'UNRESOLVED') parts.push(`unresolved:${entry.path}`);
      else if (entry.status === 'UNSUPPORTED') parts.push(`unsupported:${entry.path}`);
    }
  }
  return [...new Set(parts)].sort(compareCodeUnits);
}

function bindingFor(
  state: AnalysisResult['state'],
  outputHash: string,
  scopeReport: ScopeReport | undefined,
): { run_id?: string; input_manifest_hash?: string; scope_hash?: string } {
  const binding: { run_id?: string; input_manifest_hash?: string; scope_hash?: string } = {};
  const current = state.traceability?.runs.find(
    (run) => run.output_identity?.output_hash === outputHash,
  );
  if (current !== undefined) {
    binding.run_id = current.id;
    if (current.input_manifest_hash !== undefined) {
      binding.input_manifest_hash = current.input_manifest_hash;
    }
  }
  if (scopeReport !== undefined) {
    binding.scope_hash = scopeReport.scope_hash;
  }
  return binding;
}

export async function analyzeProjectSemantic(
  config: ReconConfig,
  opts?: { withScope?: boolean },
  deps?: AnalyzeSemanticDeps,
): Promise<{ analysis: AnalysisResult; scopeReport?: ScopeReport; semantic: SemanticModel }> {
  let analysis: AnalysisResult;
  let scopeReport: ScopeReport | undefined;
  if (opts?.withScope === true) {
    const scoped =
      deps?.analyze !== undefined
        ? await analyzeProjectScoped(config, { analyze: deps.analyze })
        : await analyzeProjectScoped(config);
    analysis = scoped.result;
    scopeReport = scoped.report;
  } else {
    analysis = await (deps?.analyze ?? analyzeProject)(config);
  }

  const state = analysis.state;
  const outputHash = computeOutputIdentity(state).output_hash;
  const degradation = degradationFor(analysis.meta.fidelity, scopeReport);
  const binding = bindingFor(state, outputHash, scopeReport);

  let stage: SemanticStage = 'intake';
  try {
    const input: SemanticInput = {
      state,
      issues: analysis.issues,
      meta: { fidelity: analysis.meta.fidelity, fileCount: analysis.meta.fileCount },
      ...(scopeReport !== undefined ? { scopeReport } : {}),
    };

    stage = 'intake';
    const index = buildEvidenceIndex(input);

    stage = 'transitions';
    const transitions = deriveTransitions(index);

    stage = 'custody';
    const assets = deriveAssets(index);

    stage = 'accounting';
    const accounting = deriveAccounting(index, { assets: assets.assets });

    stage = 'authority';
    const authority = deriveAuthority(index, transitions.transitions);

    stage = 'trust';
    const trust = deriveTrust(index, transitions.transitions);

    stage = 'ladder';
    const ladder = deriveLadder(index, {
      transitions: transitions.transitions,
      assets: assets.assets,
      custody: assets.custody,
      claims: assets.claims,
      accounting: accounting.accounting,
      authority: authority.authority,
      trust: {
        dependencies: trust.dependencies,
        capabilities: trust.capabilities,
        assumptions: trust.assumptions,
        // Layer F exposes no observations (frozen) — do not synthesize any here; Task 13 owns the gap.
        observations: [],
      },
    });

    const unknowns = [
      ...transitions.unknowns,
      ...assets.unknowns,
      ...accounting.unknowns,
      ...authority.unknowns,
      ...trust.unknowns,
      ...ladder.unknowns,
    ];

    let status: 'COMPLETE' | 'PARTIAL' = degradation.length > 0 ? 'PARTIAL' : 'COMPLETE';
    if (status === 'COMPLETE') {
      const flagged =
        unknowns.some(
          (entry) =>
            entry.reason === 'dropped_file' ||
            entry.reason === 'unsupported_assembly' ||
            entry.reason === 'syntactic_fidelity',
        ) || transitions.transitions.some((record) => record.fidelity_flags.length > 0);
      if (flagged) status = 'PARTIAL';
    }

    const draft = {
      schema_version: 'semantic-model/v1' as const,
      status,
      input: {
        fidelity: analysis.meta.fidelity,
        state_output_hash: outputHash,
        file_count: analysis.meta.fileCount,
        ...(degradation.length > 0 ? { degradation } : {}),
      },
      binding,
      contracts: [],
      transitions: transitions.transitions,
      assets: assets.assets,
      custody: assets.custody,
      claims: assets.claims,
      accounting: accounting.accounting,
      authority: authority.authority,
      trust: { dependencies: trust.dependencies, capabilities: trust.capabilities },
      epistemic: {
        observations: ladder.observations,
        assumptions: ladder.assumptions,
        hypotheses: ladder.hypotheses,
        invariants: ladder.invariants,
      },
      unknowns,
    };

    stage = 'finalize';
    const finalized = finalizeSemanticModel(draft);

    stage = 'validate';
    const validated = validateSemanticModel(
      finalized,
      scopeReport !== undefined ? { state, scopeReport } : { state },
    );

    return scopeReport !== undefined
      ? { analysis, scopeReport, semantic: validated }
      : { analysis, semantic: validated };
  } catch (error) {
    const code = isReconError(error) ? error.code : 'InvalidSemanticModel';
    const failedDraft = {
      schema_version: 'semantic-model/v1' as const,
      status: 'FAILED' as const,
      failure: { code, stage },
      input: {
        fidelity: analysis.meta.fidelity,
        state_output_hash: outputHash,
        file_count: analysis.meta.fileCount,
        ...(degradation.length > 0 ? { degradation } : {}),
      },
      binding,
      contracts: [],
      transitions: [],
      assets: [],
      custody: [],
      claims: [],
      accounting: [],
      authority: [],
      trust: { dependencies: [], capabilities: [] },
      epistemic: { observations: [], assumptions: [], hypotheses: [], invariants: [] },
      unknowns: [],
    };
    const failed = finalizeSemanticModel(failedDraft);
    return scopeReport !== undefined
      ? { analysis, scopeReport, semantic: failed }
      : { analysis, semantic: failed };
  }
}
