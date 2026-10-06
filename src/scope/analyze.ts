import { isReconError, ReconError } from '../errors/errors.js';
import type { ReconConfig } from '../recon/config.js';
import { analyzeProject, type AnalysisResult } from '../recon/index.js';
import type { ReconIssue } from '../recon/issues.js';
import { computeOutputIdentity } from '../traceability/identities.js';
import { buildInventory } from './inventory.js';
import { deriveEntries } from './derive.js';
import { computeCounts, computeMetrics } from './metrics.js';
import type { ScopeReport, Stage } from './model.js';
import { finalizeScopeReport } from './report.js';
import { validateScopeReport } from './validate.js';

const SCHEMA_VERSION = 'scope-report/v1';

export function mapErrorToStage(error: unknown): Stage {
  if (!isReconError(error)) return 'analysis';
  switch (error.code) {
    case 'NoSourcesFound':
    case 'SourceLimitExceeded':
    case 'RootEscape':
      return 'discover';
    case 'CompilationFailed':
    case 'CompilerUnavailable':
      return 'compile';
    default:
      return 'analysis';
  }
}

export interface AnalyzeScopedDeps {
  analyze?: (config: ReconConfig) => Promise<AnalysisResult>; // tests only; default analyzeProject
}

export interface AnalyzeScopedResult {
  result: AnalysisResult;
  report: ScopeReport;
}

function messageWithoutCodePrefix(error: ReconError): string {
  const prefix = `[${error.code}] `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

export async function analyzeProjectScoped(
  config: ReconConfig,
  deps?: AnalyzeScopedDeps,
): Promise<AnalyzeScopedResult> {
  const inventory = await buildInventory(config);

  let result: AnalysisResult;
  try {
    result = await (deps?.analyze ?? analyzeProject)(config);
  } catch (error) {
    if (!isReconError(error)) throw error;

    const stage = mapErrorToStage(error);
    const dropped = (error.details.dropped as string[] | undefined) ?? [];
    const issues = (error.details.issues as ReconIssue[] | undefined) ?? [];
    const entries = deriveEntries(inventory, {
      kind: 'failed',
      stage,
      error_class: error.code,
      message: error.message,
      issues,
      dropped,
    });
    const counts = computeCounts(entries);
    const metrics = computeMetrics(entries);
    const draft: Omit<ScopeReport, 'scope_hash'> = {
      schema_version: SCHEMA_VERSION,
      run: null,
      run_status: 'FAILED',
      failed_stage: stage,
      counts,
      entries,
      metrics,
    };
    const report = finalizeScopeReport(draft);
    validateScopeReport(report);
    throw new ReconError(error.code, messageWithoutCodePrefix(error), {
      ...error.details,
      scope_report: report,
    });
  }

  const entries = deriveEntries(inventory, {
    kind: 'completed',
    issues: result.issues,
    fidelity: result.meta.fidelity,
  });
  const counts = computeCounts(entries);
  const metrics = computeMetrics(entries);

  const outputHash = computeOutputIdentity(result.state).output_hash;
  const currentRun = result.state.traceability?.runs.find(
    (run) => run.output_identity?.output_hash === outputHash,
  );
  const run =
    currentRun !== undefined && currentRun.output_identity !== undefined
      ? {
          run_id: currentRun.id,
          input_manifest_hash: currentRun.input_manifest_hash,
          output_hash: currentRun.output_identity.output_hash,
        }
      : null;

  const draft: Omit<ScopeReport, 'scope_hash'> = {
    schema_version: SCHEMA_VERSION,
    run,
    run_status: 'COMPLETED',
    run_fidelity: result.meta.fidelity,
    counts,
    entries,
    metrics,
  };
  const report = finalizeScopeReport(draft);
  validateScopeReport(report);
  return { result, report };
}
