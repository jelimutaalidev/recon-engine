import { z } from 'zod';
import { compareCodeUnits } from '../../util/canonical.js';
import type { EvidenceIndex } from '../evidence.js';
import type { Fact } from '../../epistemic/fact.js';
import type { Relationship } from '../../relationships/relationship.js';
import type { Condition } from './conditions.js';
import type { InfluenceEdge } from './influence.js';
import { esmContentId, type EsmIdPrefix } from './ids.js';
import { createUnknownCollector, type UnknownRecord } from './unknown.js';

const PATH_ID_PREFIX: EsmIdPrefix = 'seme:';

export const PATH_HEADER =
  'structural route only; not executable, feasible, minimal, or complete' as const;

const UNKNOWN_LITERAL = 'unknown' as const;

const MAX_ROUTES_PER_ANCHOR = 128;

const STEP_CONDITION_SCOPE = 'path-step-condition';
const UNRESOLVED_HOP_SCOPE = 'path-unresolved-hop';
const UNRESOLVED_SOURCE_SCOPE = 'path-unresolved-source';
const DELEGATE_HOP_SCOPE = 'path-delegate-hop';
const UNKNOWN_BASE_SCOPE = 'path-unknown-base';
const TRUNCATED_ROUTES_SCOPE = 'truncated-routes';

const MARKER_VALUES: ReadonlySet<string> = new Set<string>([
  'unresolved-delegatecall',
  'unresolved-staticcall',
  'unresolved-lowlevel-call',
  'unresolved-indirect-call',
]);

const PathStepSchema = z.strictObject({
  node: z.string().min(1),
  via: z.string().min(1),
  condition: z.string().min(1),
});

export type PathStep = z.infer<typeof PathStepSchema>;

export const SemPathSchema = z.strictObject({
  id: z.string().regex(/^seme:.+/),
  steps: z.array(PathStepSchema).min(2),
  basis: z.array(z.string().min(1)).min(1),
  header: z.literal(PATH_HEADER),
});

export type SemPath = z.infer<typeof SemPathSchema>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

type TerminalKind = 'call' | 'edge-target' | 'marker';

export function derivePaths(
  index: EvidenceIndex,
  parts: { influence: InfluenceEdge[]; conditions: Condition[] },
): { paths: SemPath[]; unknowns: UnknownRecord[] } {
  // parts.influence is accepted for pipeline uniformity (E7 consumes paths
  // alongside influence) but intentionally derives no hop: admissible route
  // evidence is resolved CALLS edges, inheritance bases, delegate markers,
  // and P2 records (spec section 7.2). Influence neither adds nor removes
  // routes; paths stay structural while influence stays capability-level.
  const { conditions } = parts;

  const byId = new Map<string, SemPath>();
  const collector = createUnknownCollector();
  const unknowns = collector.unknowns;

  const pushUnknown = collector.pushUnknown.bind(collector);

  const gatesByFunction = new Map<string, string[]>();
  const orderedConditions = [...conditions].sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const condition of orderedConditions) {
    const bucket = gatesByFunction.get(condition.function);
    if (bucket === undefined) gatesByFunction.set(condition.function, [condition.id]);
    else bucket.push(condition.id);
  }
  for (const bucket of gatesByFunction.values()) {
    bucket.sort(compareCodeUnits);
  }

  const conditionFor = (
    node: string,
    hopId: string,
    terminal: TerminalKind,
    isLast: boolean,
  ): { text: string; ids: string[] } => {
    if (isLast && terminal === 'edge-target') {
      pushUnknown(UNRESOLVED_HOP_SCOPE, 'out_of_scope_target', [hopId]);
      return { text: UNKNOWN_LITERAL, ids: [] };
    }
    if (isLast && terminal === 'marker') {
      pushUnknown(DELEGATE_HOP_SCOPE, 'unresolved_call', [hopId]);
      return { text: UNKNOWN_LITERAL, ids: [] };
    }
    const gates = gatesByFunction.get(node) ?? [];
    if (gates.length === 0) {
      pushUnknown(STEP_CONDITION_SCOPE, 'no_evidence', [hopId]);
      return { text: UNKNOWN_LITERAL, ids: [] };
    }
    return { text: gates.join(','), ids: [...gates] };
  };

  const recordRoute = (nodes: string[], hops: string[], terminal: TerminalKind): void => {
    // via evidences route membership: the incoming hop for non-anchors, the
    // route's first hop for the anchor (the hop putting the anchor in play).
    const condIds: string[] = [];
    const steps = nodes.map((node, position) => {
      const hopId = (position === 0 ? hops[0] : hops[position - 1]) as string;
      const rendered = conditionFor(node, hopId, terminal, position === nodes.length - 1);
      condIds.push(...rendered.ids);
      return { node, via: hopId, condition: rendered.text };
    });
    const id = esmContentId(PATH_ID_PREFIX, { steps });
    if (byId.has(id)) return;
    byId.set(
      id,
      SemPathSchema.parse({
        id,
        steps,
        basis: [...hops, ...sortedUnique(condIds)],
        header: PATH_HEADER,
      }),
    );
  };

  const resolvedBySource = new Map<string, Relationship[]>();
  const unresolvedBySource = new Map<string, Relationship[]>();
  const callsEdges = [...index.relationshipsById.values()]
    .filter((edge) => edge.type === 'CALLS')
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const edge of callsEdges) {
    const sourceKnown = index.functionsById.has(edge.source_id);
    const targetKnown = index.functionsById.has(edge.target_id);
    if (!sourceKnown) {
      pushUnknown(UNRESOLVED_SOURCE_SCOPE, 'unresolved_call', [edge.id]);
      continue;
    }
    const bucket = targetKnown ? resolvedBySource : unresolvedBySource;
    const members = bucket.get(edge.source_id);
    if (members === undefined) bucket.set(edge.source_id, [edge]);
    else members.push(edge);
  }

  const markersBySubject = new Map<string, Fact[]>();
  for (const fact of index.factsById.values()) {
    if (fact.predicate !== 'CALLS' && fact.predicate !== 'DELEGATES_TO') continue;
    if (typeof fact.value !== 'string' || !MARKER_VALUES.has(fact.value)) continue;
    if (!index.functionsById.has(fact.subject_id)) continue;
    const members = markersBySubject.get(fact.subject_id);
    if (members === undefined) markersBySubject.set(fact.subject_id, [fact]);
    else members.push(fact);
  }
  for (const members of markersBySubject.values()) {
    members.sort((a, b) => compareCodeUnits(a.id, b.id));
  }

  const visit = (chain: string[], hops: string[]): void => {
    const current = chain[chain.length - 1] as string;
    for (const edge of resolvedBySource.get(current) ?? []) {
      // Cycle collapse: the prefix route already stands as the record; the
      // revisit adds no step, so one node per function always holds.
      if (chain.includes(edge.target_id)) continue;
      const nodes = [...chain, edge.target_id];
      const trail = [...hops, edge.id];
      recordRoute(nodes, trail, 'call');
      visit(nodes, trail);
    }
    for (const edge of unresolvedBySource.get(current) ?? []) {
      recordRoute([...chain, edge.target_id], [...hops, edge.id], 'edge-target');
    }
    for (const fact of markersBySubject.get(current) ?? []) {
      recordRoute([...chain, UNKNOWN_LITERAL], [...hops, fact.id], 'marker');
    }
  };

  const anchors = [...index.functionsById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  for (const anchor of anchors) {
    visit([anchor.id], []);
  }

  const baseEdges = [...index.relationshipsById.values()]
    .filter((edge) => edge.type === 'INHERITS' || edge.type === 'IMPLEMENTS')
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const edge of baseEdges) {
    // Inheritance hops stay single-hop contract-granularity routes: chaining
    // them with call hops would invent cross-granularity ordering.
    if (index.contractsById.has(edge.source_id) && index.contractsById.has(edge.target_id)) {
      recordRoute([edge.source_id, edge.target_id], [edge.id], 'call');
    } else {
      pushUnknown(UNKNOWN_BASE_SCOPE, 'out_of_scope_target', [edge.id]);
    }
  }

  const groups = new Map<string, SemPath[]>();
  for (const route of byId.values()) {
    const anchor = (route.steps[0] as PathStep).node;
    const members = groups.get(anchor);
    if (members === undefined) groups.set(anchor, [route]);
    else members.push(route);
  }

  const paths: SemPath[] = [];
  for (const routes of groups.values()) {
    routes.sort((a, b) => compareCodeUnits(a.id, b.id));
    if (routes.length > MAX_ROUTES_PER_ANCHOR) {
      paths.push(...routes.slice(0, MAX_ROUTES_PER_ANCHOR));
      const dropped = routes.slice(MAX_ROUTES_PER_ANCHOR);
      pushUnknown(
        TRUNCATED_ROUTES_SCOPE,
        'bound-hit',
        sortedUnique(dropped.flatMap((route) => route.steps.map((step) => step.via))),
      );
    } else {
      paths.push(...routes);
    }
  }

  paths.sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { paths, unknowns };
}
