import { ReconError } from '../errors/errors.js';
import { spanFile } from '../recon/extract/types.js';
import type { ReconState } from '../recon-state/schema.js';
import { compareCodeUnits } from '../util/canonical.js';
import { computeOutputIdentity } from '../traceability/identities.js';
import { hasCompilationFailed, hasUnknown } from './evidence.js';
import { computeCounts, computeMetrics } from './metrics.js';
import type { EmbeddedIssue, ScopeEvidence, ScopeEntry, ScopeReport } from './model.js';
import { scopeReportSchema } from './model.js';

type Reason =
  | 'schema'
  | 'counts_inconsistent'
  | 'duplicate_entry'
  | 'path_not_root_relative'
  | 'issue_attribution'
  | 'evidence_missing'
  | 'evidence_contradicted'
  | 'run_binding'
  | 'rollup_mismatch'
  | 'file_count_mismatch'
  | 'provenance_mismatch'
  | 'fidelity_mismatch';

const EXCLUDE_RULE_PREFIXES = ['config:excludes:', 'always:', 'type:'];

function fail(reason: Reason, message: string): never {
  throw new ReconError('InvalidScopeReport', message, { reason });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

function isWellFormedExcludeRule(rule: string): boolean {
  return EXCLUDE_RULE_PREFIXES.some((prefix) => rule.startsWith(prefix));
}

function assertRootRelativePath(path: string): void {
  if (path.startsWith('/')) {
    fail('path_not_root_relative', `entry path must be root-relative posix, got absolute path: ${path}`);
  }
  if (path.includes('\\')) {
    fail('path_not_root_relative', `entry path must be root-relative posix, contains backslash: ${path}`);
  }
  if (path.split('/').includes('..')) {
    fail('path_not_root_relative', `entry path must not contain a '..' segment: ${path}`);
  }
}

function validateEntry(entry: ScopeEntry): void {
  assertRootRelativePath(entry.path);

  const issues: EmbeddedIssue[] = [];
  for (const item of entry.evidence) {
    if (item.kind !== 'issue') continue;
    if (item.issue.file !== entry.path) {
      fail(
        'issue_attribution',
        `entry ${entry.path} carries an issue attributed to ${item.issue.file} (INV-13)`,
      );
    }
    issues.push(item.issue);
  }

  const has = (kind: ScopeEvidence['kind']): boolean =>
    entry.evidence.some((item) => item.kind === kind);

  switch (entry.status) {
    case 'ANALYZED': {
      if (!has('analysis')) {
        fail('evidence_missing', `ANALYZED entry ${entry.path} lacks analysis evidence (5.1)`);
      }
      if (hasUnknown(issues)) {
        fail(
          'evidence_contradicted',
          `ANALYZED entry ${entry.path} carries target-attributable UNKNOWN evidence (INV-3)`,
        );
      }
      if (hasCompilationFailed(issues)) {
        fail(
          'evidence_contradicted',
          `ANALYZED entry ${entry.path} carries compilation_failed evidence (INV-3)`,
        );
      }
      if (has('run_error')) {
        fail('evidence_contradicted', `ANALYZED entry ${entry.path} carries run_error evidence (INV-3)`);
      }
      break;
    }
    case 'UNRESOLVED': {
      if (!hasUnknown(issues)) {
        fail(
          'evidence_missing',
          `UNRESOLVED entry ${entry.path} lacks an attributable UNKNOWN-severity issue (5.1, INV-13)`,
        );
      }
      break;
    }
    case 'UNSUPPORTED': {
      if (!hasCompilationFailed(issues)) {
        fail(
          'evidence_missing',
          `UNSUPPORTED entry ${entry.path} lacks a compilation_failed issue naming it (5.1, INV-13)`,
        );
      }
      break;
    }
    case 'FAILED': {
      if (!has('run_error')) {
        fail('evidence_missing', `FAILED entry ${entry.path} lacks run_error evidence (5.1)`);
      }
      break;
    }
    case 'EXCLUDED': {
      let rules = 0;
      for (const item of entry.evidence) {
        if (item.kind !== 'exclude_rule') continue;
        rules += 1;
        if (!isWellFormedExcludeRule(item.rule)) {
          fail(
            'evidence_contradicted',
            `EXCLUDED entry ${entry.path} carries a malformed exclude rule: ${item.rule}`,
          );
        }
      }
      if (rules === 0 && !has('size_limit')) {
        fail('evidence_missing', `EXCLUDED entry ${entry.path} lacks exclude_rule or size_limit evidence (5.1)`);
      }
      break;
    }
    case 'NOT_FOUND': {
      if (!has('walk_miss')) {
        fail('evidence_missing', `NOT_FOUND entry ${entry.path} lacks walk_miss evidence (5.1)`);
      }
      break;
    }
  }
}

export function validateScopeReport(report: unknown): ScopeReport {
  // scope_hash SYNTAX only (regex) is enforced here via the strict schema; full
  // recomputation (sha256 over stableStringify(report without scope_hash)) is
  // report.ts's boundary (Task 8), deliberately not performed in this module.
  const parsed = scopeReportSchema.safeParse(report);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    fail('schema', `scope report failed schema validation: ${detail}`);
  }
  const scopeReport = parsed.data;
  const { counts, entries, metrics, run, run_status, run_fidelity, failed_stage } = scopeReport;

  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.target_type} ${entry.path}`;
    if (seen.has(key)) {
      fail('duplicate_entry', `duplicate entry for (${entry.target_type}, ${entry.path}) (INV-1)`);
    }
    seen.add(key);
  }

  const statusSum =
    counts.analyzed +
    counts.excluded +
    counts.not_found +
    counts.unresolved +
    counts.unsupported +
    counts.failed;
  if (statusSum !== entries.length) {
    fail(
      'counts_inconsistent',
      `counts sum ${statusSum} does not equal entries.length ${entries.length} (INV-1)`,
    );
  }
  if (counts.expected !== entries.length - counts.excluded) {
    fail(
      'counts_inconsistent',
      `counts.expected ${counts.expected} does not equal entries.length - counts.excluded ${
        entries.length - counts.excluded
      } (INV-1)`,
    );
  }

  for (const entry of entries) {
    validateEntry(entry);
  }

  if (!deepEqual(counts, computeCounts(entries))) {
    fail('rollup_mismatch', 'stored counts do not deep-equal counts recomputed from entries (INV-14)');
  }
  if (!deepEqual(metrics, computeMetrics(entries))) {
    fail('rollup_mismatch', 'stored metrics do not deep-equal metrics recomputed from entries (INV-14)');
  }

  // INV-9 structural run/entry orthogonality (neither inferred from the other).
  // State cross-checks (INV-8/INV-11 with ctx) are out of scope here — Task 10.
  if (run_status === 'COMPLETED') {
    if (run === null) {
      fail('run_binding', 'COMPLETED report must bind a run identity (INV-9)');
    }
    // schema enforces run_id/input_manifest_hash/output_hash as non-empty strings
    if (run_fidelity === undefined) {
      fail('run_binding', 'COMPLETED report must carry run_fidelity (INV-9, INV-14)');
    }
    if (counts.failed !== 0) {
      fail('run_binding', 'COMPLETED report must have counts.failed === 0 (INV-9)');
    }
  } else {
    if (run !== null) {
      fail('run_binding', 'FAILED report must have run === null (INV-9)');
    }
    if (failed_stage === undefined) {
      fail('run_binding', 'FAILED report must carry failed_stage (INV-9)');
    }
    if (counts.analyzed !== 0 || counts.unresolved !== 0) {
      fail(
        'run_binding',
        'FAILED report must have counts.analyzed === 0 and counts.unresolved === 0 (INV-9)',
      );
    }
  }

  return scopeReport;
}

function collectProvenanceSpanFiles(state: ReconState): Set<string> {
  const files = new Set<string>();
  const addFile = (file: string | undefined): void => {
    if (file !== undefined && file.length > 0) files.add(file);
  };
  const visitEntity = (entity: { source?: unknown; provenance?: unknown }): void => {
    if (Array.isArray(entity.provenance)) {
      for (const record of entity.provenance as { file?: unknown }[]) {
        if (typeof record.file === 'string') addFile(record.file);
      }
    }
    if (typeof entity.source === 'string') addFile(spanFile(entity.source));
  };
  const entities: unknown[] = [
    state.project,
    ...state.contracts,
    ...state.functions,
    ...state.state_variables,
    ...state.assets,
    ...state.roles,
    ...state.dependencies,
    ...state.relationships,
    ...state.facts,
    ...state.observations,
    ...state.assumptions,
    ...state.hypotheses,
    ...state.evidence,
  ];
  for (const entity of entities) {
    if (entity === undefined || entity === null) continue;
    visitEntity(entity as { source?: unknown; provenance?: unknown });
  }
  for (const record of state.provenance) addFile(record.file);
  const traceability = state.traceability;
  if (traceability !== undefined) {
    for (const derivation of traceability.derivations) {
      for (const span of derivation.provenance) addFile(spanFile(span));
      for (const ref of derivation.inputs) {
        if (ref.entity_type === 'source_file') addFile(ref.entity_id);
      }
    }
  }
  return files;
}

export function validateScopeReportWithState(
  report: ScopeReport,
  state: ReconState,
  meta: { fileCount: number; fidelity?: 'semantic' | 'syntactic' },
): void {
  const { counts } = report;

  const onDiskOutcomes =
    counts.analyzed + counts.unresolved + counts.unsupported + counts.failed;
  if (meta.fileCount !== onDiskOutcomes) {
    fail(
      'file_count_mismatch',
      `meta.fileCount ${meta.fileCount} does not equal analyzed+unresolved+unsupported+failed ${onDiskOutcomes} (INV-11)`,
    );
  }

  const allowedPaths = new Set<string>();
  for (const entry of report.entries) {
    if (entry.status === 'ANALYZED' || entry.status === 'UNRESOLVED') {
      allowedPaths.add(entry.path);
    }
  }
  const violations = [...collectProvenanceSpanFiles(state)]
    .filter((file) => !allowedPaths.has(file))
    .sort(compareCodeUnits);
  if (violations.length > 0) {
    fail(
      'provenance_mismatch',
      `provenance cites file ${String(violations[0])} with no ANALYZED/UNRESOLVED entry (8.1, INV-11)`,
    );
  }

  const outputHash = computeOutputIdentity(state).output_hash;
  const currentRun = state.traceability?.runs.find(
    (run) => run.output_identity?.output_hash === outputHash,
  );
  const currentBinding =
    currentRun !== undefined && currentRun.output_identity !== undefined
      ? {
          run_id: currentRun.id,
          input_manifest_hash: currentRun.input_manifest_hash,
          output_hash: currentRun.output_identity.output_hash,
        }
      : null;
  if (report.run_status === 'COMPLETED') {
    if (!deepEqual(report.run, currentBinding)) {
      fail(
        'run_binding',
        'COMPLETED report run must equal the state current run found by the computeOutputIdentity rule (8.1, INV-9)',
      );
    }
  } else if (report.run !== null) {
    fail('run_binding', 'FAILED report must bind no run (8.1, INV-9)');
  }

  if (report.run_fidelity !== meta.fidelity) {
    fail(
      'fidelity_mismatch',
      `run_fidelity ${String(report.run_fidelity)} does not equal meta.fidelity ${String(meta.fidelity)} (INV-11)`,
    );
  }
}
