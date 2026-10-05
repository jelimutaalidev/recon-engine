import type { Contract } from '../../domain/contract.js';
import type { SolidityFunction } from '../../domain/function.js';
import type { StateVariable } from '../../domain/state-variable.js';
import type { Fact } from '../../epistemic/fact.js';
import type { ProvenanceInput } from '../../epistemic/provenance.js';
import type { Relationship } from '../../relationships/relationship.js';
import type { ReconConfig } from '../config.js';
import type { ReconIssue } from '../issues.js';
import type { NormalizedProject, Span } from '../ir/types.js';

export interface StatePatch {
  contracts: Contract[];
  functions: SolidityFunction[];
  state_variables: StateVariable[];
  relationships: Relationship[];
  facts: Fact[];
  issues: ReconIssue[];
}

export type ProvenanceFactory = (span: Span, description?: string) => ProvenanceInput;

export interface ExtractorContext {
  ir: NormalizedProject;
  config: ReconConfig;
  provenance: ProvenanceFactory;
}

export type Extractor = (ctx: ExtractorContext) => StatePatch;

export function createProvenanceFactory(
  git?: { repository?: string; commit?: string },
): ProvenanceFactory {
  return (span, description) => ({
    source_type: 'source_code',
    file: span.file,
    line_start: span.lineStart,
    line_end: span.lineEnd,
    ...(git?.repository !== undefined ? { repository: git.repository } : {}),
    ...(git?.commit !== undefined ? { commit: git.commit } : {}),
    ...(description !== undefined ? { description } : {}),
  });
}

export function emptyPatch(): StatePatch {
  return {
    contracts: [],
    functions: [],
    state_variables: [],
    relationships: [],
    facts: [],
    issues: [],
  };
}

export function sourceFileSet(ir: NormalizedProject): Set<string> {
  return new Set(ir.files.map((file) => file.path));
}

export function spanString(span: Span): string {
  return `${span.file}:${span.lineStart}-${span.lineEnd}`;
}

export function patchOf(partial: Partial<StatePatch>): StatePatch {
  return { ...emptyPatch(), ...partial };
}
