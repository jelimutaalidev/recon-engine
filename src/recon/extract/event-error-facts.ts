import { bucketIssue, flushIssues, type IssueBuckets } from '../issue-buckets.js';
import { createFact } from '../../epistemic/fact.js';
import { createReconIssue, type ReconIssue } from '../issues.js';
import type { Span } from '../ir/types.js';
import { functionEntityId, patchOf, sourceFileSet, type Extractor } from './types.js';

const UNRESOLVED_EVENT = {
  code: 'unresolved_event_emit',
  message: 'event emission has no resolvable event signature',
} as const;

const UNRESOLVED_ERROR = {
  code: 'unresolved_custom_error',
  message: 'custom error use has no resolvable error signature',
} as const;

export const eventErrorFactsExtractor: Extractor = (ctx) => {
  const files = sourceFileSet(ctx.ir);
  const facts = [];
  const issueBuckets: IssueBuckets = new Map();

  for (const contract of ctx.ir.contracts) {
    if (!files.has(contract.span.file)) continue;
    for (const fn of contract.functions) {
      const subject = functionEntityId(contract, fn);
      const groups = new Map<string, { predicate: 'EMITS' | 'USES'; value: string; spans: Span[] }>();
      for (const emit of fn.eventEmits) {
        if (emit.signature === undefined) {
          bucketIssue(issueBuckets, UNRESOLVED_EVENT, emit.span);
          continue;
        }
        const key = `EMITS ${emit.signature}`;
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, { predicate: 'EMITS', value: emit.signature, spans: [emit.span] });
        } else {
          group.spans.push(emit.span);
        }
      }
      for (const use of fn.customErrorUses) {
        if (use.signature === undefined) {
          bucketIssue(issueBuckets, UNRESOLVED_ERROR, use.span);
          continue;
        }
        const value = `custom-error:${use.signature}`;
        const key = `USES ${value}`;
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, { predicate: 'USES', value, spans: [use.span] });
        } else {
          group.spans.push(use.span);
        }
      }
      for (const group of groups.values()) {
        facts.push(
          createFact({
            subject_id: subject,
            predicate: group.predicate,
            value: group.value,
            provenance: group.spans.map((span) => ctx.provenance(span)),
            ...(ctx.config.timestamp !== undefined ? { created_at: ctx.config.timestamp } : {}),
          }),
        );
      }
    }
  }

  const issues: ReconIssue[] = flushIssues(issueBuckets, 'UNKNOWN');

  return patchOf({ facts, issues });
};
