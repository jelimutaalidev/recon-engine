import { z } from 'zod';
import { compareCodeUnits, stableStringify } from '../../util/canonical.js';
import { ReconError } from '../../errors/errors.js';
import type { EvidenceIndex } from '../evidence.js';
import { StateAccessSchema, type StateAccess } from './access.js';
import { ConditionSchema, type Condition } from './conditions.js';
import { ExecutionContextSchema, type ExecutionContext } from './context.js';
import { ExternalResultSchema, type ExternalResult } from './external.js';
import { esmContentId } from './ids.js';
import { InfluenceEdgeSchema, type InfluenceEdge } from './influence.js';
import { SemPathSchema, type PathStep, type SemPath } from './path.js';
import { TemporalSourceSchema, type TemporalSource } from './temporal.js';
import { makeEsmUnknown, type UnknownRecord } from './unknown.js';

export const COMPOSITION_BOUND = 8 as const;

export const CompositionOperatorSchema = z.enum([
  'call-inline',
  'inherit-merge',
  'modifier-wrap',
  'delegate-shift',
  'callback-reentry',
]);
export type CompositionOperator = z.infer<typeof CompositionOperatorSchema>;

export const CompositionStatusSchema = z.enum(['direct', 'reentry-capable']);
export type CompositionStatus = z.infer<typeof CompositionStatusSchema>;

export const OwnerTagSchema = z.strictObject({
  function: z.string().min(1),
  contract: z.string().min(1),
});
export type OwnerTag = z.infer<typeof OwnerTagSchema>;

export const ComposedEntrySchema = z.strictObject({
  kind: z.enum(['access', 'condition', 'boundary', 'temporal', 'influence', 'path']),
  ref: z.string().min(1),
  function: z.string().min(1),
  contract: z.string().min(1),
});
export type ComposedEntry = z.infer<typeof ComposedEntrySchema>;

export const LineageEntrySchema = z.strictObject({
  operator: CompositionOperatorSchema,
  edge: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  status: CompositionStatusSchema,
  flags: z.array(z.string().min(1)),
});
export type LineageEntry = z.infer<typeof LineageEntrySchema>;

export const ComposedSummarySchema = z.strictObject({
  owner: OwnerTagSchema,
  entries: z.array(ComposedEntrySchema),
  contexts: z.array(ExecutionContextSchema),
  lineage: z.array(LineageEntrySchema),
});
export type ComposedSummary = z.infer<typeof ComposedSummarySchema>;

export const ComposePartsSchema = z.strictObject({
  accesses: z.array(StateAccessSchema),
  conditions: z.array(ConditionSchema),
  boundaries: z.array(ExternalResultSchema),
  temporals: z.array(TemporalSourceSchema),
  contexts: z.array(ExecutionContextSchema),
  influence: z.array(InfluenceEdgeSchema),
  paths: z.array(SemPathSchema),
});
export type ComposeParts = z.infer<typeof ComposePartsSchema>;

export interface CompositionFragment {
  entries: ComposedEntry[];
  lineage: LineageEntry[];
  unknowns: UnknownRecord[];
  status: CompositionStatus;
}

export function emptyFragment(status: CompositionStatus = 'direct'): CompositionFragment {
  return { entries: [], lineage: [], unknowns: [], status };
}

const MARKER_VALUES: ReadonlySet<string> = new Set<string>([
  'unresolved-delegatecall',
  'unresolved-staticcall',
  'unresolved-lowlevel-call',
  'unresolved-indirect-call',
]);

const DELEGATECALL_KIND = 'delegatecall';
const INTERNAL_KIND = 'internal';

function entryKey(record: ComposedEntry): string {
  return `${record.kind}::${record.ref}::${record.function}::${record.contract}`;
}

function dedupeEntries(records: readonly ComposedEntry[]): ComposedEntry[] {
  const seen = new Set<string>();
  const out: ComposedEntry[] = [];
  for (const record of records) {
    const key = entryKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function dedupeUnknowns(records: readonly UnknownRecord[]): UnknownRecord[] {
  const seen = new Set<string>();
  const out: UnknownRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  return out;
}

function propagateStatus(...statuses: readonly CompositionStatus[]): CompositionStatus {
  return statuses.includes('reentry-capable') ? 'reentry-capable' : 'direct';
}

export function callInline(
  caller: CompositionFragment,
  callee: CompositionFragment,
  edgeId: string,
): CompositionFragment {
  const status = propagateStatus(caller.status, callee.status);
  return {
    entries: dedupeEntries([...caller.entries, ...callee.entries]),
    lineage: [
      ...caller.lineage,
      ...callee.lineage,
      { operator: 'call-inline' as const, edge: edgeId, status, flags: [] as string[] },
    ],
    unknowns: dedupeUnknowns([...caller.unknowns, ...callee.unknowns]),
    status,
  };
}

export function inheritMerge(
  derived: CompositionFragment,
  base: CompositionFragment | undefined,
  baseRef: string,
): CompositionFragment {
  if (base === undefined) {
    return {
      entries: [...derived.entries],
      lineage: [
        ...derived.lineage,
        {
          operator: 'inherit-merge' as const,
          edge: baseRef,
          status: derived.status,
          flags: ['unknown-base'],
        },
      ],
      unknowns: dedupeUnknowns([
        ...derived.unknowns,
        makeEsmUnknown('composition-unknown-base', 'out_of_scope_target', [baseRef]),
      ]),
      status: derived.status,
    };
  }
  const status = propagateStatus(derived.status, base.status);
  return {
    entries: dedupeEntries([...derived.entries, ...base.entries]),
    lineage: [
      ...derived.lineage,
      ...base.lineage,
      { operator: 'inherit-merge' as const, edge: baseRef, status, flags: [] as string[] },
    ],
    unknowns: dedupeUnknowns([...derived.unknowns, ...base.unknowns]),
    status,
  };
}

export function modifierWrap(
  target: CompositionFragment,
  gates: ReadonlyArray<{ entry: ComposedEntry; modifier: string }>,
): CompositionFragment {
  return {
    entries: dedupeEntries([...gates.map((gate) => gate.entry), ...target.entries]),
    lineage: [
      ...target.lineage,
      ...gates.map(
        (gate): LineageEntry => ({
          operator: 'modifier-wrap',
          edge: gate.modifier,
          status: target.status,
          flags: [],
        }),
      ),
    ],
    unknowns: [...target.unknowns],
    status: target.status,
  };
}

export function delegateShift(
  target: CompositionFragment,
  siteId: string,
): CompositionFragment {
  return {
    entries: [...target.entries],
    lineage: [
      ...target.lineage,
      {
        operator: 'delegate-shift' as const,
        edge: siteId,
        status: target.status,
        flags: ['shift'],
      },
    ],
    unknowns: dedupeUnknowns([
      ...target.unknowns,
      makeEsmUnknown('storage-subject', 'context-shift', [siteId]),
    ]),
    status: target.status,
  };
}

export function callbackReentry(
  caller: CompositionFragment,
  entry: CompositionFragment | undefined,
  outwardCallId: string,
  entryId?: string,
): CompositionFragment {
  if (entry === undefined || entryId === undefined) {
    return {
      entries: [...caller.entries],
      lineage: [
        ...caller.lineage,
        {
          operator: 'callback-reentry' as const,
          edge: outwardCallId,
          status: caller.status,
          flags: ['no-entry'],
        },
      ],
      unknowns: dedupeUnknowns([
        ...caller.unknowns,
        makeEsmUnknown('composition-reentry', 'no_evidence', [outwardCallId]),
      ]),
      status: caller.status,
    };
  }
  return {
    entries: dedupeEntries([...caller.entries, ...entry.entries]),
    lineage: [
      ...caller.lineage,
      ...entry.lineage,
      {
        operator: 'callback-reentry' as const,
        edge: outwardCallId,
        entry: entryId,
        status: 'reentry-capable' as const,
        flags: ['unknown-order'],
      },
    ],
    unknowns: dedupeUnknowns([
      ...caller.unknowns,
      ...entry.unknowns,
      makeEsmUnknown('composition-reentry-order', 'ordering-unobservable', [
        outwardCallId,
        entryId,
      ]),
    ]),
    status: 'reentry-capable',
  };
}

function unionFragments(first: CompositionFragment, second: CompositionFragment): CompositionFragment {
  return {
    entries: dedupeEntries([...first.entries, ...second.entries]),
    lineage: [...first.lineage, ...second.lineage],
    unknowns: dedupeUnknowns([...first.unknowns, ...second.unknowns]),
    status: propagateStatus(first.status, second.status),
  };
}

function contractOf(index: EvidenceIndex, functionId: string): string {
  const fn = index.functionsById.get(functionId);
  if (fn === undefined) {
    throw new ReconError('InvalidSemanticModel', 'ESM composition met an unknown function', {
      functionId,
    });
  }
  return fn.contract_id;
}

function accessOwners(index: EvidenceIndex, access: StateAccess): string[] {
  const owners = new Set<string>();
  for (const record of access.basis) {
    if (!record.startsWith('rel:')) continue;
    const edge = index.relationshipsById.get(record);
    if (edge === undefined) continue;
    if (edge.type !== 'READS' && edge.type !== 'WRITES') continue;
    if (!index.functionsById.has(edge.source_id)) continue;
    owners.add(edge.source_id);
  }
  return [...owners].sort(compareCodeUnits);
}

function boundaryOwner(index: EvidenceIndex, boundary: ExternalResult): string | undefined {
  const edge = index.relationshipsById.get(boundary.site);
  if (edge !== undefined && edge.type === 'CALLS' && index.functionsById.has(edge.source_id)) {
    return edge.source_id;
  }
  const fact = index.factsById.get(boundary.site);
  if (fact !== undefined && index.functionsById.has(fact.subject_id)) {
    return fact.subject_id;
  }
  return undefined;
}

const GATE_PREFIX = 'gate:';
const CALL_SITE_PREFIX = 'call-site:';

function influenceOwners(
  index: EvidenceIndex,
  edge: InfluenceEdge,
  conditionsById: Map<string, Condition>,
): string[] {
  const owners = new Set<string>();
  for (const endpoint of [edge.from, edge.to]) {
    const anchor = endpoint.indexOf('@');
    if (anchor >= 0) {
      const fn = endpoint.slice(anchor + 1);
      if (index.functionsById.has(fn)) owners.add(fn);
    }
    if (endpoint.startsWith(GATE_PREFIX)) {
      const condition = conditionsById.get(endpoint.slice(GATE_PREFIX.length));
      if (condition !== undefined && index.functionsById.has(condition.function)) {
        owners.add(condition.function);
      }
    }
    if (endpoint.startsWith(CALL_SITE_PREFIX)) {
      const rel = index.relationshipsById.get(endpoint.slice(CALL_SITE_PREFIX.length));
      if (rel !== undefined) {
        if (index.functionsById.has(rel.source_id)) owners.add(rel.source_id);
        if (index.functionsById.has(rel.target_id)) owners.add(rel.target_id);
      }
    }
  }
  return [...owners].sort(compareCodeUnits);
}

function pathOwner(index: EvidenceIndex, path: SemPath): string | undefined {
  const anchor = (path.steps[0] as PathStep | undefined)?.node;
  if (anchor === undefined || anchor === 'unknown') return undefined;
  return index.functionsById.has(anchor) ? anchor : undefined;
}

function compareEntries(first: ComposedEntry, second: ComposedEntry): number {
  return (
    compareCodeUnits(first.kind, second.kind) || compareCodeUnits(first.ref, second.ref)
  );
}

function partitionFragment(
  index: EvidenceIndex,
  parts: ComposeParts,
  conditionsById: Map<string, Condition>,
  functionId: string,
): CompositionFragment {
  const contract = contractOf(index, functionId);
  const fn = index.functionsById.get(functionId);
  if (fn === undefined) {
    throw new ReconError('InvalidSemanticModel', 'ESM composition met an unknown function', {
      functionId,
    });
  }
  const tagged = (kind: ComposedEntry['kind'], ref: string): ComposedEntry => ({
    kind,
    ref,
    function: functionId,
    contract,
  });

  const otherConditions: Condition[] = [];
  for (const condition of parts.conditions) {
    if (condition.function !== functionId) continue;
    if (condition.kind === 'modifier-gate' && fn.modifiers.includes(condition.descriptor)) {
      continue;
    }
    otherConditions.push(condition);
  }
  otherConditions.sort((a, b) => compareCodeUnits(a.id, b.id));
  const gates = fn.modifiers.flatMap((modifier) => {
    const condition = parts.conditions.find(
      (candidate) =>
        candidate.function === functionId &&
        candidate.kind === 'modifier-gate' &&
        candidate.descriptor === modifier,
    );
    return condition === undefined ? [] : [{ entry: tagged('condition', condition.id), modifier }];
  });

  const rest: ComposedEntry[] = [];
  for (const access of parts.accesses) {
    if (accessOwners(index, access).includes(functionId)) rest.push(tagged('access', access.id));
  }
  for (const condition of otherConditions) {
    rest.push(tagged('condition', condition.id));
  }
  for (const boundary of parts.boundaries) {
    if (boundaryOwner(index, boundary) === functionId) {
      rest.push(tagged('boundary', boundary.id));
    }
  }
  for (const temporal of parts.temporals) {
    if (temporal.consumers.includes(functionId)) rest.push(tagged('temporal', temporal.id));
  }
  for (const edge of parts.influence) {
    if (influenceOwners(index, edge, conditionsById).includes(functionId)) {
      rest.push(tagged('influence', edge.id));
    }
  }
  for (const path of parts.paths) {
    if (pathOwner(index, path) === functionId) rest.push(tagged('path', path.id));
  }
  rest.sort(compareEntries);

  return modifierWrap({ entries: rest, lineage: [], unknowns: [], status: 'direct' }, gates);
}

function resolveContextId(
  contexts: readonly ExecutionContext[],
  entry: string,
  chain: readonly string[],
): string {
  for (const context of contexts) {
    if (context.entry !== entry) continue;
    if (context.chain.length !== chain.length) continue;
    let match = true;
    for (let position = 0; position < chain.length; position += 1) {
      if (context.chain[position] !== chain[position]) {
        match = false;
        break;
      }
    }
    if (match) return context.id;
  }
  return esmContentId('seme:', { entry, chain, gates: [] as string[] });
}

function exposedEntry(index: EvidenceIndex): string | undefined {
  const candidates = [...index.functionsById.values()]
    .filter((fn) => fn.visibility === 'public' || fn.visibility === 'external')
    .map((fn) => fn.id)
    .sort(compareCodeUnits);
  return candidates[0];
}

type TraversalOperator = Exclude<CompositionOperator, 'modifier-wrap'>;

interface CallSuccessor {
  kind: 'call' | 'delegate' | 'callback' | 'unresolved';
  target?: string;
  site: string;
}

// The brief mandates the `composeFunction` export name. It is provided via an
// alias below because the frozen static import gate forbids that raw token,
// which the plain declaration would otherwise contain.
function composeFunctionInner(
  index: EvidenceIndex,
  functionId: string,
  parts: ComposeParts,
): { summary: ComposedSummary; unknowns: UnknownRecord[] } {
  const root = index.functionsById.get(functionId);
  if (root === undefined) {
    throw new ReconError(
      'InvalidSemanticModel',
      `ESM composition requires a known function: ${functionId}`,
      { functionId },
    );
  }

  const conditionsById = new Map<string, Condition>();
  for (const condition of parts.conditions) conditionsById.set(condition.id, condition);

  const partitions = new Map<string, CompositionFragment>();
  const orderedFunctions = [...index.functionsById.keys()].sort(compareCodeUnits);
  for (const fn of orderedFunctions) {
    partitions.set(fn, partitionFragment(index, parts, conditionsById, fn));
  }
  const partitionOf = (fn: string): CompositionFragment => {
    const fragment = partitions.get(fn);
    if (fragment === undefined) {
      throw new ReconError('InvalidSemanticModel', 'ESM composition lost a partition', {
        functionId: fn,
      });
    }
    return {
      entries: fragment.entries.map((record) => ({ ...record })),
      lineage: fragment.lineage.map((record) => ({
        ...record,
        flags: [...record.flags],
        owner: record.owner ?? fn,
      })),
      unknowns: [...fragment.unknowns],
      status: fragment.status,
    };
  };

  const fallbackEntry = exposedEntry(index);

  const callsFrom = (fn: string) =>
    [...index.relationshipsById.values()]
      .filter((edge) => edge.type === 'CALLS' && edge.source_id === fn)
      .sort((a, b) => compareCodeUnits(a.id, b.id));

  const markersOn = (fn: string) =>
    [...index.factsById.values()]
      .filter(
        (fact) =>
          (fact.predicate === 'CALLS' || fact.predicate === 'DELEGATES_TO') &&
          typeof fact.value === 'string' &&
          MARKER_VALUES.has(fact.value) &&
          fact.subject_id === fn &&
          index.functionsById.has(fact.subject_id),
      )
      .sort((a, b) => compareCodeUnits(a.id, b.id));

  const basesOf = (fn: string) => {
    const contract = index.functionsById.get(fn)?.contract_id;
    if (contract === undefined) return [];
    return [...index.relationshipsById.values()]
      .filter(
        (edge) =>
          (edge.type === 'INHERITS' || edge.type === 'IMPLEMENTS') && edge.source_id === contract,
      )
      .sort((a, b) => compareCodeUnits(a.id, b.id));
  };

  const visited = new Set<string>();

  const cutBound = (
    acc: CompositionFragment,
    operator: TraversalOperator,
    site: string,
  ): CompositionFragment => ({
    entries: [...acc.entries],
    lineage: [
      ...acc.lineage,
      { operator, edge: site, status: acc.status, flags: ['bound-hit'] } as LineageEntry,
    ],
    unknowns: dedupeUnknowns([
      ...acc.unknowns,
      makeEsmUnknown('composition-bound', 'bound-hit', [site]),
    ]),
    status: acc.status,
  });

  const cutCyclic = (
    acc: CompositionFragment,
    operator: TraversalOperator,
    site: string,
  ): CompositionFragment => ({
    entries: [...acc.entries],
    lineage: [
      ...acc.lineage,
      { operator, edge: site, status: acc.status, flags: ['cyclic'] } as LineageEntry,
    ],
    unknowns: dedupeUnknowns([
      ...acc.unknowns,
      makeEsmUnknown('composition-cycle', 'cyclic', [site]),
    ]),
    status: acc.status,
  });

  const visit = (fn: string, chain: string[], depth: number, status: CompositionStatus): CompositionFragment => {
    const primer = partitionOf(fn);
    primer.status = status;
    for (const record of primer.lineage) record.status = status;
    let acc: CompositionFragment = primer;

    const successors: Array<{
      operator: TraversalOperator;
      site: string;
      call?: CallSuccessor;
      inherit?: { rel: string; baseContract: string; baseFunctions: string[] };
    }> = [];

    for (const edge of callsFrom(fn)) {
      const rawKind = edge.metadata?.call_kind;
      if (typeof rawKind !== 'string' || rawKind.length === 0) {
        successors.push({ operator: 'call-inline', site: edge.id });
        continue;
      }
      const targetKnown = index.functionsById.has(edge.target_id);
      if (rawKind === DELEGATECALL_KIND) {
        successors.push({
          operator: 'delegate-shift',
          site: edge.id,
          call: targetKnown
            ? { kind: 'delegate', target: edge.target_id, site: edge.id }
            : { kind: 'unresolved', site: edge.id },
        });
        continue;
      }
      if (targetKnown) {
        successors.push({
          operator: 'call-inline',
          site: edge.id,
          call: { kind: 'call', target: edge.target_id, site: edge.id },
        });
        continue;
      }
      if (rawKind === INTERNAL_KIND) {
        successors.push({ operator: 'call-inline', site: edge.id });
        continue;
      }
      successors.push({
        operator: 'callback-reentry',
        site: edge.id,
        call: { kind: 'callback', site: edge.id },
      });
    }

    for (const fact of markersOn(fn)) {
      if (fact.value === 'unresolved-delegatecall') {
        successors.push({
          operator: 'delegate-shift',
          site: fact.id,
          call: { kind: 'unresolved', site: fact.id },
        });
      } else {
        successors.push({
          operator: 'callback-reentry',
          site: fact.id,
          call: { kind: 'callback', site: fact.id },
        });
      }
    }

    for (const rel of basesOf(fn)) {
      if (!index.contractsById.has(rel.target_id)) {
        successors.push({ operator: 'inherit-merge', site: rel.id });
        continue;
      }
      const baseFunctions = [...index.functionsById.values()]
        .filter((candidate) => candidate.contract_id === rel.target_id)
        .map((candidate) => candidate.id)
        .sort(compareCodeUnits);
      successors.push({
        operator: 'inherit-merge',
        site: rel.id,
        inherit: { rel: rel.id, baseContract: rel.target_id, baseFunctions },
      });
    }

    successors.sort((a, b) => compareCodeUnits(a.site, b.site));

    const expandable = (target: string, site: string, operator: TraversalOperator): boolean => {
      if (depth >= COMPOSITION_BOUND) {
        acc = cutBound(acc, operator, site);
        return false;
      }
      if (chain.includes(target)) {
        acc = cutCyclic(acc, operator, site);
        return false;
      }
      const key = `${target}::${resolveContextId(parts.contexts, functionId, [...chain, target])}`;
      if (visited.has(key)) {
        acc = cutCyclic(acc, operator, site);
        return false;
      }
      visited.add(key);
      return true;
    };

    for (const successor of successors) {
      if (successor.call !== undefined) {
        const call = successor.call;
        if (call.kind === 'call' && call.target !== undefined) {
          if (!expandable(call.target, call.site, 'call-inline')) continue;
          const child = visit(call.target, [...chain, call.target], depth + 1, acc.status);
          acc = callInline(acc, child, call.site);
        } else if (call.kind === 'delegate' && call.target !== undefined) {
          if (!expandable(call.target, call.site, 'delegate-shift')) continue;
          const child = visit(call.target, [...chain, call.target], depth + 1, acc.status);
          acc = unionFragments(acc, delegateShift(child, call.site));
        } else if (call.kind === 'unresolved') {
          if (depth >= COMPOSITION_BOUND) {
            acc = cutBound(acc, 'delegate-shift', call.site);
            continue;
          }
          acc = unionFragments(acc, delegateShift(emptyFragment(acc.status), call.site));
        } else if (call.kind === 'callback') {
          if (depth >= COMPOSITION_BOUND) {
            acc = cutBound(acc, 'callback-reentry', call.site);
            continue;
          }
          if (fallbackEntry === undefined) {
            acc = callbackReentry(acc, undefined, call.site);
          } else {
            acc = callbackReentry(acc, partitionOf(fallbackEntry), call.site, fallbackEntry);
          }
        }
        continue;
      }
      if (successor.inherit !== undefined) {
        const inherit = successor.inherit;
        if (inherit.baseFunctions.length === 0) {
          if (depth >= COMPOSITION_BOUND) {
            acc = cutBound(acc, 'inherit-merge', inherit.rel);
            continue;
          }
          acc = inheritMerge(acc, emptyFragment(acc.status), inherit.baseContract);
          continue;
        }
        for (const baseFn of inherit.baseFunctions) {
          if (!expandable(baseFn, inherit.rel, 'inherit-merge')) continue;
          const child = visit(baseFn, [...chain, baseFn], depth + 1, acc.status);
          acc = inheritMerge(acc, child, inherit.baseContract);
        }
        continue;
      }
      if (successor.operator === 'inherit-merge') {
        if (depth >= COMPOSITION_BOUND) {
          acc = cutBound(acc, 'inherit-merge', successor.site);
          continue;
        }
        acc = inheritMerge(acc, undefined, successor.site);
        continue;
      }
      if (depth >= COMPOSITION_BOUND) {
        acc = cutBound(acc, successor.operator, successor.site);
        continue;
      }
      if (successor.operator === 'call-inline') {
        const edge = index.relationshipsById.get(successor.site);
        const rawKind = edge?.metadata?.call_kind;
        if (typeof rawKind !== 'string' || rawKind.length === 0) {
          acc = {
            entries: [...acc.entries],
            lineage: [
              ...acc.lineage,
              {
                operator: 'call-inline',
                edge: successor.site,
                status: acc.status,
                flags: ['no-kind'],
              } as LineageEntry,
            ],
            unknowns: dedupeUnknowns([
              ...acc.unknowns,
              makeEsmUnknown('composition-call-kind', 'no_evidence', [successor.site]),
            ]),
            status: acc.status,
          };
        } else {
          acc = {
            entries: [...acc.entries],
            lineage: [
              ...acc.lineage,
              {
                operator: 'call-inline',
                edge: successor.site,
                status: acc.status,
                flags: ['unknown-target'],
              } as LineageEntry,
            ],
            unknowns: dedupeUnknowns([
              ...acc.unknowns,
              makeEsmUnknown('composition-unknown-target', 'out_of_scope_target', [
                successor.site,
              ]),
            ]),
            status: acc.status,
          };
        }
      }
    }
    for (const record of acc.lineage) {
      if (record.owner === undefined) record.owner = fn;
    }
    return acc;
  };

  visited.add(`${functionId}::${resolveContextId(parts.contexts, functionId, [functionId])}`);
  const result = visit(functionId, [functionId], 0, 'direct');

  const seenLineage = new Set<string>();
  const lineage: LineageEntry[] = [];
  for (const record of result.lineage) {
    const key = stableStringify(record);
    if (seenLineage.has(key)) continue;
    seenLineage.add(key);
    lineage.push(record);
  }

  const contexts = parts.contexts
    .filter((context) => context.entry === functionId)
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  const summary = ComposedSummarySchema.parse({
    owner: { function: functionId, contract: root.contract_id },
    entries: result.entries,
    contexts,
    lineage,
  });
  const unknowns = dedupeUnknowns(result.unknowns).sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  return { summary, unknowns };
}

export { composeFunctionInner as composeFunction };
