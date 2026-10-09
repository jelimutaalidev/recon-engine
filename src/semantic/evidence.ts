import type { Contract } from '../domain/contract.js';
import type { SolidityFunction } from '../domain/function.js';
import type { StateVariable } from '../domain/state-variable.js';
import type { Fact } from '../epistemic/fact.js';
import type { Provenance } from '../epistemic/provenance.js';
import type { ReconIssue } from '../recon/issues.js';
import type { ReconState } from '../recon-state/schema.js';
import type { Relationship } from '../relationships/relationship.js';
import { issueContentId } from '../ids/ids.js';
import { buildGraphIndex, type GraphIndex } from '../relationships/graph.js';
import type { ScopeReport } from '../scope/model.js';
import { computeOutputIdentity } from '../traceability/identities.js';
import { stableStringify } from '../util/canonical.js';

export interface SemanticInput {
  state: ReconState;
  issues: ReconIssue[];
  meta: { fidelity: 'semantic' | 'syntactic'; fileCount: number };
  scopeReport?: ScopeReport;
}

export interface EvidenceIndex {
  factsById: Map<string, Fact>;
  relationshipsById: Map<string, Relationship>;
  functionsById: Map<string, SolidityFunction>;
  contractsById: Map<string, Contract>;
  stateVariablesById: Map<string, StateVariable>;
  issuesByFile: Map<string, IndexedIssue[]>;
  issuesById: Map<string, IndexedIssue[]>;
  graph: GraphIndex;
  provenanceById: Map<string, Provenance>;
  stateHash: string;
  currentRun?: { run_id: string; input_manifest_hash?: string };
  input: SemanticInput;
}

function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    index.set(item.id, item);
  }
  return index;
}

export type IndexedIssue = ReconIssue & { id: string };

function indexIssue(issue: ReconIssue): IndexedIssue {
  return {
    ...issue,
    id: issueContentId({
      severity: issue.severity,
      code: issue.code,
      ...(issue.file !== undefined ? { file: issue.file } : {}),
      ...(issue.line_start !== undefined ? { line_start: issue.line_start } : {}),
      ...(issue.line_end !== undefined ? { line_end: issue.line_end } : {}),
    }),
  };
}

function groupIssuesByFile(issues: readonly ReconIssue[]): Map<string, IndexedIssue[]> {
  const grouped = new Map<string, IndexedIssue[]>();
  for (const issue of issues) {
    const key = issue.file ?? '';
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [indexIssue(issue)]);
    } else {
      bucket.push(indexIssue(issue));
    }
  }
  return grouped;
}

function indexIssuesById(grouped: ReadonlyMap<string, IndexedIssue[]>): Map<string, IndexedIssue[]> {
  const byId = new Map<string, IndexedIssue[]>();
  for (const bucket of grouped.values()) {
    for (const issue of bucket) {
      const matches = byId.get(issue.id);
      if (matches === undefined) {
        byId.set(issue.id, [issue]);
      } else {
        matches.push(issue);
      }
    }
  }
  return byId;
}

export function buildEvidenceIndex(input: SemanticInput): EvidenceIndex {
  const state = input.state;
  const stateHash = computeOutputIdentity(state).output_hash;
  const run = state.traceability?.runs.find(
    (candidate) => candidate.output_identity?.output_hash === stateHash,
  );

  const issuesByFile = groupIssuesByFile(input.issues);
  const index: EvidenceIndex = {
    factsById: indexById(state.facts),
    relationshipsById: indexById(state.relationships),
    functionsById: indexById(state.functions),
    contractsById: indexById(state.contracts),
    stateVariablesById: indexById(state.state_variables),
    issuesByFile,
    issuesById: indexIssuesById(issuesByFile),
    graph: buildGraphIndex(state.relationships),
    provenanceById: indexById(state.provenance),
    stateHash,
    input,
  };
  if (run !== undefined) {
    index.currentRun = {
      run_id: run.id,
      input_manifest_hash: run.input_manifest_hash,
    };
  }
  return index;
}

export function resolveProvenanceCopy(index: EvidenceIndex, prov: Provenance): boolean {
  const target = stableStringify(prov);
  for (const record of index.provenanceById.values()) {
    if (stableStringify(record) === target) return true;
  }
  for (const fact of index.factsById.values()) {
    for (const record of fact.provenance) {
      if (stableStringify(record) === target) return true;
    }
  }
  for (const relationship of index.relationshipsById.values()) {
    for (const record of relationship.provenance) {
      if (stableStringify(record) === target) return true;
    }
  }
  return false;
}
