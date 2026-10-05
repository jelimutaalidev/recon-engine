import { ReconError } from '../errors/errors.js';
import type { ReconState } from '../recon-state/schema.js';
import { spanFile } from '../recon/extract/types.js';
import { computeOutputIdentity } from './identities.js';
import { MATERIAL_ENTITY_TYPES } from './types.js';
import type {
  Derivation,
  ReconRun,
  RunComparison,
  RunOutputRecord,
  TraceReference,
  TraceStatus,
} from './types.js';

export const DEFAULT_TRACE_DEPTH = 5;

export type TraceDirection = 'backward' | 'forward' | 'both';

export type TraceNodeKind =
  | 'entity'
  | 'source_file'
  | 'provenance_span'
  | 'derivation'
  | 'source_identity'
  | 'run';

export interface TraceNode {
  kind: TraceNodeKind;
  id: string;
  depth: number;
}

export interface TraceResult {
  root: string;
  direction: TraceDirection;
  status: TraceStatus;
  nodes: TraceNode[];
  truncated: boolean;
}

export interface IncompleteTrace {
  entity_type: string;
  entity_id: string;
  status: TraceStatus;
}

export interface OrphanedTraceReference {
  run_id: string;
  derivation_id: string;
  ref: TraceReference;
}

export interface TraceabilityService {
  getRunById(runId: string): ReconRun | undefined;
  getRun(objectId: string): ReconRun | undefined;
  getProvenance(objectId: string): string[];
  getDerivations(objectId: string): Derivation[];
  traceBackward(objectId: string, options?: { depth?: number }): TraceResult;
  traceForward(ref: TraceReference, options?: { depth?: number }): TraceResult;
  trace(
    entityId: string,
    options: { direction: TraceDirection; depth?: number },
  ): TraceResult;
  findByDerivation(operation: string, operationVersion: string): Derivation[];
  findRunsBySourceIdentity(sourceHash: string): ReconRun[];
  findIncompleteTraces(): IncompleteTrace[];
  findOrphanedTraceReferences(): OrphanedTraceReference[];
  getTraceStatus(objectId: string): TraceStatus;
  getOutputs(runId: string): TraceReference[];
  compareRuns(runIdA: string, runIdB: string): RunComparison;
}

interface EntityInfo {
  type: string;
  material: boolean;
  spans: string[];
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRefs(left: TraceReference, right: TraceReference): number {
  return (
    compareIds(left.entity_type, right.entity_type) || compareIds(left.entity_id, right.entity_id)
  );
}

function refKey(ref: TraceReference): string {
  return `${ref.entity_type}|${ref.entity_id}`;
}

function nodeKey(node: TraceNode): string {
  return `${node.kind}|${node.id}`;
}

function entitySpans(entity: { source?: unknown; provenance?: unknown }): string[] {
  const spans = new Set<string>();
  if (typeof entity.source === 'string' && entity.source.length > 0) {
    spans.add(entity.source);
  }
  if (Array.isArray(entity.provenance)) {
    for (const record of entity.provenance as {
      file?: string | undefined;
      line_start?: number | undefined;
      line_end?: number | undefined;
    }[]) {
      if (record.file === undefined) continue;
      if (record.line_start !== undefined && record.line_end !== undefined) {
        spans.add(`${record.file}:${record.line_start}-${record.line_end}`);
      }
    }
  }
  return [...spans].sort(compareIds);
}

function isMaterialType(type: string): boolean {
  return (MATERIAL_ENTITY_TYPES as readonly string[]).includes(type);
}

function mapPush<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function setPush<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, new Set([value]));
  } else {
    existing.add(value);
  }
}

function refKind(ref: TraceReference): TraceNodeKind {
  return ref.entity_type === 'source_file' ? 'source_file' : 'entity';
}

function normalizeDepth(depth: number | undefined): number {
  const requested = depth ?? DEFAULT_TRACE_DEPTH;
  return Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : DEFAULT_TRACE_DEPTH;
}

interface BfsResult {
  nodes: TraceNode[];
  truncated: boolean;
}

function bfs(
  root: TraceNode,
  childrenOf: (node: TraceNode) => TraceNode[],
  maxDepth: number,
): BfsResult {
  const visited = new Set<string>([nodeKey(root)]);
  const nodes: TraceNode[] = [];
  let frontier: TraceNode[] = [root];
  let truncated = false;
  while (frontier.length > 0) {
    const next: TraceNode[] = [];
    for (const node of frontier) {
      nodes.push(node);
      const children = childrenOf(node);
      if (node.depth >= maxDepth) {
        if (children.some((child) => !visited.has(nodeKey(child)))) truncated = true;
        continue;
      }
      for (const child of children) {
        const key = nodeKey(child);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push({ ...child, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
  return { nodes, truncated };
}

export function createTraceabilityService(state: ReconState): TraceabilityService {
  const trace = state.traceability ?? { runs: [], derivations: [], outputs: [] };

  const entitiesById = new Map<string, EntityInfo>();
  const register = (type: string, entity: unknown): void => {
    const record = entity as { id?: unknown };
    if (typeof record.id !== 'string') return;
    entitiesById.set(record.id, {
      type,
      material: isMaterialType(type),
      spans: entitySpans(entity as { source?: unknown; provenance?: unknown }),
    });
  };
  if (state.project !== undefined) register('project', state.project);
  for (const entity of state.contracts) register('contract', entity);
  for (const entity of state.functions) register('function', entity);
  for (const entity of state.state_variables) register('state_variable', entity);
  for (const entity of state.assets) register('asset', entity);
  for (const entity of state.roles) register('role', entity);
  for (const entity of state.dependencies) register('dependency', entity);
  for (const entity of state.relationships) register('relationship', entity);
  for (const entity of state.facts) register('fact', entity);
  for (const entity of state.observations) register('observation', entity);
  for (const entity of state.assumptions) register('assumption', entity);
  for (const entity of state.hypotheses) register('hypothesis', entity);
  for (const entity of state.evidence) register('evidence', entity);

  const provenanceFiles = new Set<string>();
  const spanFiles = new Set<string>();
  const collectFile = (file: string | undefined): void => {
    if (file !== undefined && file.length > 0) provenanceFiles.add(file);
  };
  const collectFromEntity = (entity: { source?: unknown; provenance?: unknown }): void => {
    if (Array.isArray(entity.provenance)) {
      for (const record of entity.provenance as { file?: string | undefined }[]) {
        collectFile(record.file);
      }
    }
    if (typeof entity.source === 'string') {
      const file = spanFile(entity.source);
      if (file !== undefined) spanFiles.add(file);
    }
  };
  for (const record of state.provenance) collectFile(record.file);
  const entityCollections: unknown[] = [
    ...(state.project !== undefined ? [state.project] : []),
    ...state.contracts,
    ...state.functions,
    ...state.state_variables,
    ...state.assets,
    ...state.roles,
    ...state.dependencies,
    ...state.relationships,
    ...state.facts,
    ...state.observations,
    ...state.assumptions,
    ...state.hypotheses,
    ...state.evidence,
  ];
  for (const entity of entityCollections) {
    collectFromEntity(entity as { source?: unknown; provenance?: unknown });
  }

  const runsById = new Map<string, ReconRun>();
  for (const run of [...trace.runs].sort((a, b) => compareIds(a.id, b.id))) {
    runsById.set(run.id, run);
  }

  const derivationsByIdSorted = [...trace.derivations].sort((a, b) => compareIds(a.id, b.id));
  const derivationsByOutput = new Map<string, Derivation[]>();
  const derivationsByInput = new Map<string, Derivation[]>();
  const derivationsById = new Map<string, Derivation>();
  const runsByInputFile = new Map<string, Set<string>>();
  const runsBySpan = new Map<string, Set<string>>();
  const derivationRefPairs = new Set<string>();
  const knownInputFiles = new Set<string>();
  for (const derivation of derivationsByIdSorted) {
    derivationsById.set(derivation.id, derivation);
    for (const ref of derivation.outputs) {
      mapPush(derivationsByOutput, ref.entity_id, derivation);
      derivationRefPairs.add(refKey(ref));
    }
    for (const ref of derivation.inputs) {
      mapPush(derivationsByInput, ref.entity_id, derivation);
      derivationRefPairs.add(refKey(ref));
      if (ref.entity_type === 'source_file') {
        knownInputFiles.add(ref.entity_id);
        setPush(runsByInputFile, ref.entity_id, derivation.run_id);
      }
    }
    for (const span of derivation.provenance) {
      setPush(runsBySpan, span, derivation.run_id);
    }
  }

  const runsBySourceHash = new Map<string, ReconRun[]>();
  for (const run of runsById.values()) {
    mapPush(runsBySourceHash, run.source_identity.source_hash, run);
  }

  const outputsByRun = new Map<string, RunOutputRecord[]>();
  const runOutputPairs = new Set<string>();
  for (const output of trace.outputs) {
    mapPush(outputsByRun, output.run_id, output);
    runOutputPairs.add(refKey(output));
  }
  for (const records of outputsByRun.values()) {
    records.sort(compareRefs);
  }

  const materialPairs = new Set<string>();
  for (const [id, info] of entitiesById) {
    if (info.material) materialPairs.add(`${info.type}|${id}`);
  }

  const knownSourceFiles = new Set<string>([...provenanceFiles, ...spanFiles, ...knownInputFiles]);
  const knownRefPairs = new Set<string>([...derivationRefPairs, ...runOutputPairs]);
  for (const [id, info] of entitiesById) {
    knownRefPairs.add(`${info.type}|${id}`);
  }

  const currentOutputHash = computeOutputIdentity(state).output_hash;

  function requireEntity(objectId: string): EntityInfo {
    const info = entitiesById.get(objectId);
    if (info === undefined) {
      throw new ReconError('EntityNotFound', `entity ${objectId} does not exist in this state`, {
        id: objectId,
      });
    }
    return info;
  }

  function requireRun(runId: string): ReconRun {
    const run = runsById.get(runId);
    if (run === undefined) {
      throw new ReconError('EntityNotFound', `run ${runId} does not exist in this state`, {
        id: runId,
      });
    }
    return run;
  }

  function statusOf(objectId: string, info: EntityInfo): TraceStatus {
    if (!info.material) return 'NOT_APPLICABLE';
    const hasDerivation = (derivationsByOutput.get(objectId) ?? []).length > 0;
    const hasProvenance = info.spans.length > 0;
    if (hasDerivation && hasProvenance) return 'COMPLETE';
    if (hasDerivation || hasProvenance) return 'PARTIAL';
    return 'MISSING';
  }

  function refIsKnown(ref: TraceReference): boolean {
    if (ref.entity_type === 'source_file') return knownSourceFiles.has(ref.entity_id);
    return knownRefPairs.has(refKey(ref));
  }

  function refResolves(ref: TraceReference): boolean {
    if (ref.entity_type === 'source_file') {
      return provenanceFiles.has(ref.entity_id) || spanFiles.has(ref.entity_id);
    }
    const key = refKey(ref);
    return materialPairs.has(key) || runOutputPairs.has(key);
  }

  function requireKnownRef(ref: TraceReference): void {
    if (!refIsKnown(ref)) {
      throw new ReconError(
        'EntityNotFound',
        `trace reference ${ref.entity_type}:${ref.entity_id} does not exist in this state`,
        { entity_type: ref.entity_type, entity_id: ref.entity_id },
      );
    }
  }

  function sourceIdentityNodes(runIds: ReadonlySet<string>): TraceNode[] {
    const nodes: TraceNode[] = [];
    const seen = new Set<string>();
    for (const runId of runIds) {
      const run = runsById.get(runId);
      if (run === undefined) continue;
      const hash = run.source_identity.source_hash;
      if (seen.has(hash)) continue;
      seen.add(hash);
      nodes.push({ kind: 'source_identity', id: hash, depth: 0 });
    }
    return nodes;
  }

  function backwardChildren(node: TraceNode): TraceNode[] {
    switch (node.kind) {
      case 'entity':
        return (derivationsByOutput.get(node.id) ?? []).map((item) => ({
          kind: 'derivation' as const,
          id: item.id,
          depth: 0,
        }));
      case 'derivation': {
        const item = derivationsById.get(node.id);
        if (item === undefined) return [];
        const children: TraceNode[] = [];
        for (const ref of item.inputs) {
          children.push({ kind: refKind(ref), id: ref.entity_id, depth: 0 });
        }
        for (const span of item.provenance) {
          children.push({ kind: 'provenance_span', id: span, depth: 0 });
        }
        return children;
      }
      case 'source_file':
        return sourceIdentityNodes(runsByInputFile.get(node.id) ?? new Set<string>());
      case 'provenance_span':
        return sourceIdentityNodes(runsBySpan.get(node.id) ?? new Set<string>());
      case 'source_identity':
        return (runsBySourceHash.get(node.id) ?? []).map((run) => ({
          kind: 'run' as const,
          id: run.id,
          depth: 0,
        }));
      case 'run':
        return [];
    }
  }

  function forwardChildren(node: TraceNode): TraceNode[] {
    switch (node.kind) {
      case 'entity':
      case 'source_file':
        return (derivationsByInput.get(node.id) ?? []).map((item) => ({
          kind: 'derivation' as const,
          id: item.id,
          depth: 0,
        }));
      case 'derivation': {
        const item = derivationsById.get(node.id);
        if (item === undefined) return [];
        return item.outputs.map((ref) => ({ kind: refKind(ref), id: ref.entity_id, depth: 0 }));
      }
      case 'provenance_span':
      case 'source_identity':
      case 'run':
        return [];
    }
  }

  function traceBackwardNode(objectId: string, depth: number): BfsResult {
    return bfs({ kind: 'entity', id: objectId, depth: 0 }, backwardChildren, normalizeDepth(depth));
  }

  function traceForwardRef(ref: TraceReference, depth: number): BfsResult {
    return bfs(
      { kind: refKind(ref), id: ref.entity_id, depth: 0 },
      forwardChildren,
      normalizeDepth(depth),
    );
  }

  function forwardStatus(ref: TraceReference): TraceStatus {
    const info = entitiesById.get(ref.entity_id);
    return info === undefined ? 'NOT_APPLICABLE' : statusOf(ref.entity_id, info);
  }

  return {
    getRunById(runId) {
      return runsById.get(runId);
    },

    getRun(objectId) {
      const candidates = [...new Set((derivationsByOutput.get(objectId) ?? []).map((item) => item.run_id))]
        .sort(compareIds);
      const runs = candidates
        .map((runId) => runsById.get(runId))
        .filter((run): run is ReconRun => run !== undefined);
      if (runs.length === 0) return undefined;
      let greatest = runs[0]!;
      for (const run of runs) {
        if (compareIds(run.id, greatest.id) > 0) greatest = run;
      }
      let currentMatch: ReconRun | undefined;
      for (const run of runs) {
        if (run.output_identity?.output_hash !== currentOutputHash) continue;
        if (currentMatch === undefined || compareIds(run.id, currentMatch.id) > 0) {
          currentMatch = run;
        }
      }
      return currentMatch ?? greatest;
    },

    getProvenance(objectId) {
      return [...requireEntity(objectId).spans];
    },

    getDerivations(objectId) {
      const merged = new Map<string, Derivation>();
      for (const item of derivationsByOutput.get(objectId) ?? []) merged.set(item.id, item);
      for (const item of derivationsByInput.get(objectId) ?? []) merged.set(item.id, item);
      return [...merged.values()].sort((a, b) => compareIds(a.id, b.id));
    },

    traceBackward(objectId, options) {
      const info = requireEntity(objectId);
      const { nodes, truncated } = traceBackwardNode(objectId, options?.depth ?? DEFAULT_TRACE_DEPTH);
      return {
        root: objectId,
        direction: 'backward',
        status: statusOf(objectId, info),
        nodes,
        truncated,
      };
    },

    traceForward(ref, options) {
      requireKnownRef(ref);
      const { nodes, truncated } = traceForwardRef(ref, options?.depth ?? DEFAULT_TRACE_DEPTH);
      return {
        root: ref.entity_id,
        direction: 'forward',
        status: forwardStatus(ref),
        nodes,
        truncated,
      };
    },

    trace(entityId, options) {
      const info = requireEntity(entityId);
      const status = statusOf(entityId, info);
      const depth = options.depth ?? DEFAULT_TRACE_DEPTH;
      if (options.direction === 'backward') {
        const { nodes, truncated } = traceBackwardNode(entityId, depth);
        return { root: entityId, direction: 'backward', status, nodes, truncated };
      }
      const ref: TraceReference = { entity_type: info.type, entity_id: entityId };
      if (options.direction === 'forward') {
        const { nodes, truncated } = traceForwardRef(ref, depth);
        return { root: entityId, direction: 'forward', status, nodes, truncated };
      }
      const backward = traceBackwardNode(entityId, depth);
      const forward = traceForwardRef(ref, depth);
      const seen = new Set<string>();
      const nodes: TraceNode[] = [];
      for (const node of [...backward.nodes, ...forward.nodes]) {
        const key = nodeKey(node);
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(node);
      }
      return {
        root: entityId,
        direction: 'both',
        status,
        nodes,
        truncated: backward.truncated || forward.truncated,
      };
    },

    findByDerivation(operation, operationVersion) {
      return derivationsByIdSorted.filter(
        (item) => item.operation === operation && item.operation_version === operationVersion,
      );
    },

    findRunsBySourceIdentity(sourceHash) {
      return [...runsById.values()]
        .filter((run) => run.source_identity.source_hash === sourceHash)
        .sort((a, b) => compareIds(a.id, b.id));
    },

    findIncompleteTraces() {
      const incomplete: IncompleteTrace[] = [];
      for (const [id, info] of entitiesById) {
        if (!info.material) continue;
        const status = statusOf(id, info);
        if (status === 'PARTIAL' || status === 'MISSING') {
          incomplete.push({ entity_type: info.type, entity_id: id, status });
        }
      }
      return incomplete.sort(
        (a, b) =>
          compareIds(a.entity_type, b.entity_type) || compareIds(a.entity_id, b.entity_id),
      );
    },

    findOrphanedTraceReferences() {
      const orphaned: OrphanedTraceReference[] = [];
      for (const item of derivationsByIdSorted) {
        for (const ref of [...item.inputs, ...item.outputs]) {
          if (!refResolves(ref)) {
            orphaned.push({ run_id: item.run_id, derivation_id: item.id, ref });
          }
        }
      }
      return orphaned;
    },

    getTraceStatus(objectId) {
      const info = requireEntity(objectId);
      return statusOf(objectId, info);
    },

    getOutputs(runId) {
      return (outputsByRun.get(runId) ?? [])
        .map((record) => ({ entity_type: record.entity_type, entity_id: record.entity_id }))
        .sort(compareRefs);
    },

    compareRuns(runIdA, runIdB) {
      const runA = requireRun(runIdA);
      const runB = requireRun(runIdB);
      const outputsA = new Map<string, RunOutputRecord>();
      for (const record of outputsByRun.get(runIdA) ?? []) outputsA.set(refKey(record), record);
      const outputsB = new Map<string, RunOutputRecord>();
      for (const record of outputsByRun.get(runIdB) ?? []) outputsB.set(refKey(record), record);
      const added: TraceReference[] = [];
      const removed: TraceReference[] = [];
      const changed: TraceReference[] = [];
      const unchanged: TraceReference[] = [];
      for (const [key, recordB] of outputsB) {
        const recordA = outputsA.get(key);
        if (recordA === undefined) {
          added.push({ entity_type: recordB.entity_type, entity_id: recordB.entity_id });
        } else if (recordA.content_hash !== recordB.content_hash) {
          changed.push({ entity_type: recordB.entity_type, entity_id: recordB.entity_id });
        } else {
          unchanged.push({ entity_type: recordB.entity_type, entity_id: recordB.entity_id });
        }
      }
      for (const [key, recordA] of outputsA) {
        if (!outputsB.has(key)) {
          removed.push({ entity_type: recordA.entity_type, entity_id: recordA.entity_id });
        }
      }
      const classification: RunComparison['classification'] =
        runA.source_identity.source_hash !== runB.source_identity.source_hash
          ? 'diff_source'
          : runA.analyzer_version !== runB.analyzer_version
            ? 'same_source_diff_analyzer'
            : 'same_source_same_analyzer';
      return {
        classification,
        added: added.sort(compareRefs),
        removed: removed.sort(compareRefs),
        changed: changed.sort(compareRefs),
        unchanged: unchanged.sort(compareRefs),
      };
    },
  };
}
