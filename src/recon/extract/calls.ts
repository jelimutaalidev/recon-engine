import { bucketIssue, flushIssues, type IssueBuckets } from '../issue-buckets.js';
import { createFact } from '../../epistemic/fact.js';
import { createRelationship, type Relationship } from '../../relationships/relationship.js';
import { createReconIssue, type ReconIssue } from '../issues.js';
import type { CallKind, Span } from '../ir/types.js';
import { contractScope, functionEntityId, patchOf, type Extractor } from './types.js';

const RESOLVED_KINDS: ReadonlySet<CallKind> = new Set<CallKind>([
  'internal',
  'external',
  'super',
  'self-external',
  'new',
]);

interface MarkerSpec {
  value: string;
  predicate: 'CALLS' | 'DELEGATES_TO';
  code: string;
  message: string;
}

const MARKERS: Record<string, MarkerSpec> = {
  delegatecall: {
    value: 'unresolved-delegatecall',
    predicate: 'DELEGATES_TO',
    code: 'unresolved_delegatecall',
    message: 'delegatecall target cannot be determined from compiler evidence',
  },
  staticcall: {
    value: 'unresolved-staticcall',
    predicate: 'CALLS',
    code: 'unresolved_staticcall',
    message: 'staticcall target cannot be determined from compiler evidence',
  },
  lowlevel: {
    value: 'unresolved-lowlevel-call',
    predicate: 'CALLS',
    code: 'unresolved_lowlevel_call',
    message: 'low-level call target cannot be determined from compiler evidence',
  },
  indirect: {
    value: 'unresolved-indirect-call',
    predicate: 'CALLS',
    code: 'unresolved_indirect_call',
    message: 'indirect call target cannot be determined from compiler evidence',
  },
};

const TARGET_ISSUES = {
  outside: {
    code: 'call_target_outside_sources',
    message: 'call target contract is outside the analyzed source set',
  },
  unresolved: {
    code: 'call_target_unresolved',
    message: 'call target signature does not resolve to a source function',
  },
} as const;

function pushMarker(
  markers: Map<string, { subject_id: string; predicate: 'CALLS' | 'DELEGATES_TO'; value: string; spans: Span[] }>,
  spec: MarkerSpec,
  subject: string,
  span: Span,
): void {
  const key = `${subject} ${spec.value}`;
  const group = markers.get(key);
  if (group === undefined) {
    markers.set(key, { subject_id: subject, predicate: spec.predicate, value: spec.value, spans: [span] });
  } else {
    group.spans.push(span);
  }
}

export const callsExtractor: Extractor = (ctx) => {
  const scope = contractScope(ctx.ir);
  const targets = new Map<string, Map<string, string>>();
  for (const contract of scope.values()) {
    const bySignature = new Map<string, string>();
    for (const fn of contract.functions) {
      const id = functionEntityId(contract, fn);
      if (!bySignature.has(fn.canonicalSignature)) bySignature.set(fn.canonicalSignature, id);
      if (fn.methodIdentifier !== undefined && !bySignature.has(fn.methodIdentifier)) {
        bySignature.set(fn.methodIdentifier, id);
      }
    }
    targets.set(contract.fqn, bySignature);
  }

  const edges = new Map<
    string,
    { source_id: string; target_id: string; kind: CallKind; spans: Span[] }
  >();
  const markers = new Map<
    string,
    { subject_id: string; predicate: 'CALLS' | 'DELEGATES_TO'; value: string; spans: Span[] }
  >();
  const issueBuckets: IssueBuckets = new Map();

  for (const contract of scope.values()) {
    for (const fn of contract.functions) {
      const subject = functionEntityId(contract, fn);
      for (const site of fn.callSites) {
        const marker = MARKERS[site.kind];
        if (marker !== undefined || !RESOLVED_KINDS.has(site.kind) || site.resolvedRef === undefined) {
          const spec = marker ?? (MARKERS.indirect as MarkerSpec);
          pushMarker(markers, spec, subject, site.span);
          bucketIssue(issueBuckets, spec, site.span);
          continue;
        }
        const target = targets.get(site.resolvedRef.fqn)?.get(site.resolvedRef.signature);
        if (target === undefined) {
          bucketIssue(
            issueBuckets,
            scope.has(site.resolvedRef.fqn) ? TARGET_ISSUES.unresolved : TARGET_ISSUES.outside,
            site.span,
          );
          continue;
        }
        const edgeKey = `${subject} ${target}`;
        const group = edges.get(edgeKey);
        if (group === undefined) {
          edges.set(edgeKey, {
            source_id: subject,
            target_id: target,
            kind: site.kind,
            spans: [site.span],
          });
        } else {
          group.spans.push(site.span);
        }
      }
    }
  }

  const relationships: Relationship[] = [];
  for (const group of edges.values()) {
    relationships.push(
      createRelationship({
        type: 'CALLS',
        source_id: group.source_id,
        target_id: group.target_id,
        metadata: { call_kind: group.kind },
        provenance: group.spans.map((span) => ctx.provenance(span)),
        ...(ctx.config.timestamp !== undefined ? { created_at: ctx.config.timestamp } : {}),
      }),
    );
  }

  const facts = [...markers.values()].map((group) =>
    createFact({
      subject_id: group.subject_id,
      predicate: group.predicate,
      value: group.value,
      provenance: group.spans.map((span) => ctx.provenance(span)),
      ...(ctx.config.timestamp !== undefined ? { created_at: ctx.config.timestamp } : {}),
    }),
  );

  const issues: ReconIssue[] = flushIssues(issueBuckets, 'UNKNOWN');

  return patchOf({ relationships, facts, issues });
};
