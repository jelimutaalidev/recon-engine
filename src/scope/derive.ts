import type { ReconIssue } from '../recon/issues.js';
import { compareCodeUnits } from '../util/canonical.js';
import {
  attributableIssues,
  hasCompilationFailed,
  hasUnknown,
  FALLBACK_CODE,
} from './evidence.js';
import type { FileRecord, ScopeInventory } from './inventory.js';
import type { EmbeddedIssue, ScopeEntry, ScopeEvidence, Stage } from './model.js';

export type DeriveOutcome =
  | { kind: 'completed'; issues: readonly ReconIssue[]; fidelity: 'semantic' | 'syntactic' }
  | {
      kind: 'failed';
      stage: Stage;
      error_class: string;
      message: string;
      issues?: readonly ReconIssue[];
      dropped?: readonly string[];
    };

const SIZE_LIMIT_RULE = 'limit:maxFileBytes';

function issueEvidence(issues: readonly EmbeddedIssue[]): ScopeEvidence[] {
  return issues.map((issue): ScopeEvidence => ({ kind: 'issue', issue }));
}

function excludedEntry(record: FileRecord, rule: string): ScopeEntry {
  const evidence: ScopeEvidence[] =
    rule === SIZE_LIMIT_RULE && record.limit_bytes !== undefined
      ? [{ kind: 'size_limit', limit_bytes: record.limit_bytes }]
      : [{ kind: 'exclude_rule', rule }];
  return { target_type: 'source_file', path: record.path, status: 'EXCLUDED', evidence };
}

function onDiskEntry(record: FileRecord, outcome: DeriveOutcome): ScopeEntry {
  const analysis: ScopeEvidence = { kind: 'analysis', sha256: record.sha256 };

  if (outcome.kind === 'completed') {
    const issues = attributableIssues(outcome.issues, record.path);
    if (hasCompilationFailed(issues)) {
      return {
        target_type: 'source_file',
        path: record.path,
        status: 'UNSUPPORTED',
        evidence: issueEvidence(issues),
      };
    }
    if (hasUnknown(issues)) {
      return {
        target_type: 'source_file',
        path: record.path,
        status: 'UNRESOLVED',
        evidence: [analysis, ...issueEvidence(issues)],
      };
    }
    const fallback = issues.filter((issue) => issue.code === FALLBACK_CODE);
    return {
      target_type: 'source_file',
      path: record.path,
      status: 'ANALYZED',
      evidence: [analysis, ...issueEvidence(fallback)],
    };
  }

  const issues = attributableIssues(outcome.issues ?? [], record.path);
  const dropped = outcome.dropped ?? [];
  if (dropped.includes(record.path) || hasCompilationFailed(issues)) {
    return {
      target_type: 'source_file',
      path: record.path,
      status: 'UNSUPPORTED',
      evidence: issueEvidence(issues),
    };
  }
  return {
    target_type: 'source_file',
    path: record.path,
    status: 'FAILED',
    evidence: [
      {
        kind: 'run_error',
        stage: outcome.stage,
        error_class: outcome.error_class,
        message: outcome.message,
      },
    ],
  };
}

export function deriveEntries(inventory: ScopeInventory, outcome: DeriveOutcome): ScopeEntry[] {
  const entries: ScopeEntry[] = [];

  for (const record of inventory.files) {
    if (record.excluded_rule !== null) {
      entries.push(excludedEntry(record, record.excluded_rule));
    } else {
      entries.push(onDiskEntry(record, outcome));
    }
  }

  for (const miss of inventory.not_found) {
    entries.push({
      target_type: 'source_file',
      path: miss.path,
      status: 'NOT_FOUND',
      evidence: [{ kind: 'walk_miss', include: miss.include }],
    });
  }

  entries.sort((a, b) => compareCodeUnits(a.path, b.path));
  return entries;
}
