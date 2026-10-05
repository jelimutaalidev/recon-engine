import { bucketIssue, flushIssues, type IssueBuckets } from '../issue-buckets.js';
import { createRelationship, type Relationship } from '../../relationships/relationship.js';
import { createReconIssue, type ReconIssue } from '../issues.js';
import type { Span } from '../ir/types.js';
import {
  functionEntityId,
  patchOf,
  contractScope,
  stateVariableEntityId,
  type Extractor,
} from './types.js';

const UNRESOLVED_STORAGE = {
  code: 'unresolved_storage_access',
  message: 'storage access has no compiler declaration identity',
} as const;

const TARGET_ISSUES = {
  outside: {
    code: 'storage_target_outside_sources',
    message: 'storage target contract is outside the analyzed source set',
  },
  unresolved: {
    code: 'storage_target_unresolved',
    message: 'storage target does not resolve to a state variable',
  },
} as const;

export const storageAccessExtractor: Extractor = (ctx) => {
  const scope = contractScope(ctx.ir);

  const edges = new Map<string, { type: 'READS' | 'WRITES'; source_id: string; target_id: string; spans: Span[] }>();
  const issueBuckets: IssueBuckets = new Map();

  for (const contract of scope.values()) {
    for (const fn of contract.functions) {
      const subject = functionEntityId(contract, fn);
      for (const access of fn.storageAccesses) {
        if (access.resolvedRef === undefined) {
          bucketIssue(issueBuckets, UNRESOLVED_STORAGE, access.span);
          continue;
        }
        const targetContract = scope.get(access.resolvedRef.fqn);
        if (targetContract === undefined) {
          bucketIssue(issueBuckets, TARGET_ISSUES.outside, access.span);
          continue;
        }
        const declared = targetContract.stateVars.some(
          (stateVar) => stateVar.name === access.resolvedRef?.name,
        );
        if (!declared) {
          bucketIssue(issueBuckets, TARGET_ISSUES.unresolved, access.span);
          continue;
        }
        const target = stateVariableEntityId(targetContract, access.resolvedRef.name);
        const types: ('READS' | 'WRITES')[] =
          access.op === 'read'
            ? ['READS']
            : access.op === 'write'
              ? ['WRITES']
              : ['READS', 'WRITES'];
        for (const type of types) {
          const key = `${type} ${subject} ${target}`;
          const group = edges.get(key);
          if (group === undefined) {
            edges.set(key, { type, source_id: subject, target_id: target, spans: [access.span] });
          } else {
            group.spans.push(access.span);
          }
        }
      }
    }
  }

  const relationships: Relationship[] = [];
  for (const group of edges.values()) {
    relationships.push(
      createRelationship({
        type: group.type,
        source_id: group.source_id,
        target_id: group.target_id,
        provenance: group.spans.map((span) => ctx.provenance(span)),
        ...(ctx.config.timestamp !== undefined ? { created_at: ctx.config.timestamp } : {}),
      }),
    );
  }

  const issues: ReconIssue[] = flushIssues(issueBuckets, 'UNKNOWN');

  return patchOf({ relationships, issues });
};
