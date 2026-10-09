import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import type { Fact } from '../../epistemic/fact.js';
import type { Relationship } from '../../relationships/relationship.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import { makeEsmUnknown, type UnknownReason, type UnknownRecord } from './unknown.js';

const CONTEXT_ID_PREFIX: EsmIdPrefix = 'seme:';

const UNKNOWN_LITERAL = 'unknown' as const;

const DELEGATECALL_KIND = 'delegatecall';
const UNRESOLVED_DELEGATECALL = 'unresolved-delegatecall';
const SHIFT_PREFIX = 'context-shift:';

const MARKER_VALUES: ReadonlySet<string> = new Set<string>([
  'unresolved-delegatecall',
  'unresolved-staticcall',
  'unresolved-lowlevel-call',
  'unresolved-indirect-call',
]);

const ACTOR_SCOPE = 'execution-actor';
const ORIGIN_SCOPE = 'execution-origin';
const VALUE_SCOPE = 'execution-value';
const BLOCK_SCOPE = 'execution-block';
const ORDER_SCOPE = 'execution-order';
const STORAGE_SUBJECT_SCOPE = 'storage-subject';
const TARGET_SCOPE = 'execution-target';
const CALL_KIND_SCOPE = 'execution-call-kind';

const RUNTIME_SCOPES: readonly string[] = [
  ACTOR_SCOPE,
  ORIGIN_SCOPE,
  VALUE_SCOPE,
  BLOCK_SCOPE,
  ORDER_SCOPE,
];

export const ExecutionContextSchema = z
  .strictObject({
    id: z.string().regex(/^seme:.+/),
    entry: z.string().min(1),
    chain: z.array(z.string().min(1)).min(1),
    callKinds: z.array(z.string().min(1)),
    gates: z.array(z.string().min(1)),
    unknown: z.strictObject({
      actor: z.literal(UNKNOWN_LITERAL),
      origin: z.literal(UNKNOWN_LITERAL),
      value: z.literal(UNKNOWN_LITERAL),
      block: z.literal(UNKNOWN_LITERAL),
      order: z.literal(UNKNOWN_LITERAL),
    }),
  })
  .refine((context) => context.callKinds.length === context.chain.length - 1, {
    message: 'callKinds must hold one entry per chain hop',
  });

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

interface Frame {
  node: string;
  chain: string[];
  kinds: string[];
  hops: string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function deriveContexts(index: EvidenceIndex): {
  contexts: ExecutionContext[];
  unknowns: UnknownRecord[];
} {
  const outgoing = new Map<string, Relationship[]>();
  for (const edge of index.relationshipsById.values()) {
    if (edge.type !== 'CALLS') continue;
    const bucket = outgoing.get(edge.source_id);
    if (bucket === undefined) outgoing.set(edge.source_id, [edge]);
    else bucket.push(edge);
  }
  for (const bucket of outgoing.values()) {
    bucket.sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  const markersBySubject = new Map<string, Fact[]>();
  for (const fact of index.factsById.values()) {
    if (fact.predicate !== 'CALLS' && fact.predicate !== 'DELEGATES_TO') continue;
    if (typeof fact.value !== 'string' || !MARKER_VALUES.has(fact.value)) continue;
    if (!index.functionsById.has(fact.subject_id)) continue;
    const bucket = markersBySubject.get(fact.subject_id);
    if (bucket === undefined) markersBySubject.set(fact.subject_id, [fact]);
    else bucket.push(fact);
  }
  for (const bucket of markersBySubject.values()) {
    bucket.sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  const functions = [...index.functionsById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  const entries = functions.filter(
    (fn) => fn.visibility === 'public' || fn.visibility === 'external',
  );

  const byId = new Map<string, ExecutionContext>();
  const unknowns: UnknownRecord[] = [];
  const seenUnknowns = new Set<string>();

  const pushUnknown = (scope: string, reason: UnknownReason, basis: string[]): void => {
    const record = makeEsmUnknown(scope, reason, basis);
    if (seenUnknowns.has(record.id)) return;
    seenUnknowns.add(record.id);
    unknowns.push(record);
  };

  const gatesOf = (functionId: string): string[] => {
    const fn = index.functionsById.get(functionId);
    if (fn === undefined) return [];
    return sortedUnique(fn.modifiers);
  };

  const pushContext = (
    entry: string,
    chain: string[],
    kinds: string[],
    gates: string[],
    hops: string[],
  ): void => {
    const id = esmContentId(CONTEXT_ID_PREFIX, { entry, chain, gates });
    if (byId.has(id)) return;
    byId.set(
      id,
      ExecutionContextSchema.parse({
        id,
        entry,
        chain,
        callKinds: kinds,
        gates,
        unknown: {
          actor: UNKNOWN_LITERAL,
          origin: UNKNOWN_LITERAL,
          value: UNKNOWN_LITERAL,
          block: UNKNOWN_LITERAL,
          order: UNKNOWN_LITERAL,
        },
      }),
    );
    const runtimeBasis = hops.length > 0 ? sortedUnique(hops) : [entry];
    for (const scope of RUNTIME_SCOPES) {
      pushUnknown(scope, 'runtime-unobservable', runtimeBasis);
    }
  };

  const expandMarkers = (entry: string, frame: Frame): void => {
    const markers = markersBySubject.get(frame.node) ?? [];
    for (const fact of markers) {
      const value = fact.value as string;
      const shifted = value === UNRESOLVED_DELEGATECALL;
      const kind = shifted ? `${SHIFT_PREFIX}${value}` : value;
      const chain = [...frame.chain, fact.id];
      const kinds = [...frame.kinds, kind];
      const hops = [...frame.hops, fact.id];
      pushContext(entry, chain, kinds, gatesOf(frame.node), hops);
      if (shifted) pushUnknown(STORAGE_SUBJECT_SCOPE, 'context-shift', [fact.id]);
      else pushUnknown(TARGET_SCOPE, 'unresolved_call', [fact.id]);
    }
  };

  const expandEdges = (
    entry: string,
    frame: Frame,
    visited: Set<string>,
    queue: Frame[],
  ): void => {
    const edges = outgoing.get(frame.node) ?? [];
    for (const edge of edges) {
      const rawKind = edge.metadata?.call_kind;
      if (typeof rawKind !== 'string' || rawKind.length === 0) {
        pushUnknown(CALL_KIND_SCOPE, 'no_evidence', [edge.id]);
        continue;
      }
      const target = index.functionsById.get(edge.target_id);
      if (target === undefined) {
        if (rawKind === DELEGATECALL_KIND) {
          pushUnknown(STORAGE_SUBJECT_SCOPE, 'context-shift', [edge.id]);
        } else {
          pushUnknown(TARGET_SCOPE, 'out_of_scope_target', [edge.id]);
        }
        continue;
      }
      if (visited.has(target.id)) continue;
      visited.add(target.id);
      const shifted = rawKind === DELEGATECALL_KIND;
      if (shifted) pushUnknown(STORAGE_SUBJECT_SCOPE, 'context-shift', [edge.id]);
      const next: Frame = {
        node: target.id,
        chain: [...frame.chain, target.id],
        kinds: [...frame.kinds, shifted ? `${SHIFT_PREFIX}${rawKind}` : rawKind],
        hops: [...frame.hops, edge.id],
      };
      pushContext(entry, next.chain, next.kinds, gatesOf(target.id), next.hops);
      queue.push(next);
    }
  };

  const reached = new Set<string>();
  for (const entryFn of entries) {
    const visited = new Set<string>([entryFn.id]);
    const queue: Frame[] = [{ node: entryFn.id, chain: [entryFn.id], kinds: [], hops: [] }];
    pushContext(entryFn.id, [entryFn.id], [], gatesOf(entryFn.id), []);
    while (queue.length > 0) {
      const frame = queue.shift() as Frame;
      expandEdges(entryFn.id, frame, visited, queue);
      expandMarkers(entryFn.id, frame);
    }
    for (const id of visited) reached.add(id);
  }

  for (const fn of functions) {
    if (reached.has(fn.id)) continue;
    const frame: Frame = { node: fn.id, chain: [fn.id], kinds: [], hops: [] };
    pushContext(fn.id, [fn.id], [], gatesOf(fn.id), []);
    expandMarkers(fn.id, frame);
  }

  const contexts = [...byId.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { contexts, unknowns };
}
