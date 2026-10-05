import { ReconError } from '../../errors/errors.js';
import { stableStringify } from '../../util/canonical.js';
import { sortIssues, type ReconIssue } from '../issues.js';
import { callsExtractor } from './calls.js';
import { contractsExtractor } from './contracts.js';
import { eventErrorFactsExtractor } from './event-error-facts.js';
import { functionsExtractor } from './functions.js';
import { inheritanceExtractor } from './inheritance.js';
import { stateVariablesExtractor } from './state-variables.js';
import { storageAccessExtractor } from './storage-access.js';
import type { Extractor, ExtractorContext, StatePatch } from './types.js';

export { createProvenanceFactory } from './types.js';
export type { Extractor, ExtractorContext, ProvenanceFactory, StatePatch } from './types.js';

export interface NamedExtractor {
  operation: string;
  run: Extractor;
}

export const EXTRACTORS: readonly NamedExtractor[] = [
  { operation: 'extract.contracts', run: contractsExtractor },
  { operation: 'extract.functions', run: functionsExtractor },
  { operation: 'extract.state_variables', run: stateVariablesExtractor },
  { operation: 'extract.inheritance', run: inheritanceExtractor },
  { operation: 'extract.calls', run: callsExtractor },
  { operation: 'extract.storage_access', run: storageAccessExtractor },
  { operation: 'extract.event_error_facts', run: eventErrorFactsExtractor },
];

export function runExtractorsWithLineage(ctx: ExtractorContext): {
  patch: StatePatch;
  perExtractor: { operation: string; patch: StatePatch }[];
} {
  const perExtractor = EXTRACTORS.map(({ operation, run }) => ({
    operation,
    patch: run(ctx),
  }));
  return {
    patch: mergePatches(perExtractor.map((entry) => entry.patch)),
    perExtractor,
  };
}

export function runExtractors(ctx: ExtractorContext): StatePatch {
  return runExtractorsWithLineage(ctx).patch;
}

export function mergePatches(patches: readonly StatePatch[]): StatePatch {
  return {
    contracts: dedupeEntities(
      patches.flatMap((patch) => patch.contracts),
      'Contract',
    ),
    functions: dedupeEntities(
      patches.flatMap((patch) => patch.functions),
      'Function',
    ),
    state_variables: dedupeEntities(
      patches.flatMap((patch) => patch.state_variables),
      'StateVariable',
    ),
    relationships: keepFirstById(patches.flatMap((patch) => patch.relationships)),
    facts: keepFirstById(patches.flatMap((patch) => patch.facts)),
    issues: sortIssues(dedupeIssues(patches.flatMap((patch) => patch.issues))),
  };
}

function dedupeEntities<T extends { id: string }>(records: readonly T[], label: string): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (existing === undefined) {
      byId.set(record.id, record);
      continue;
    }
    if (stableStringify(existing) !== stableStringify(record)) {
      throw new ReconError(
        'DuplicateCanonicalEntity',
        `${label} id ${record.id} has conflicting content`,
        { entity: label, id: record.id },
      );
    }
  }
  return [...byId.values()];
}

function keepFirstById<T extends { id: string }>(records: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function dedupeIssues(records: readonly ReconIssue[]): ReconIssue[] {
  const seen = new Set<string>();
  const unique: ReconIssue[] = [];
  for (const issue of records) {
    const key = JSON.stringify(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}
