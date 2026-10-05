import type { Provenance } from '../epistemic/provenance.js';
import { spanFile, type StatePatch } from '../recon/extract/types.js';
import { ANALYZER_VERSION } from '../version.js';
import { derivationId, entityContentHash } from './identities.js';
import type {
  CompilerIdentity,
  ConfigurationIdentity,
  Derivation,
  OutputIdentity,
  ReconRun,
  RunOutputRecord,
  SourceIdentity,
  TraceReference,
  TraceabilityState,
} from './types.js';

export type Fidelity = 'semantic' | 'syntactic';

export interface TraceabilityInput {
  projectId: string;
  startedAt: string;
  schemaVersion: string;
  sourceIdentity: SourceIdentity;
  compilerIdentity: CompilerIdentity;
  configurationIdentity: ConfigurationIdentity;
  inputManifestHash: string;
  runId: string;
  outputIdentity: OutputIdentity;
  perExtractor: readonly { operation: string; patch: StatePatch }[];
  mergedPatch: StatePatch;
  fidelity: Fidelity;
}

interface LineageEntity {
  source?: string | undefined;
  provenance?: readonly Provenance[] | undefined;
}

function byRef(left: TraceReference, right: TraceReference): number {
  if (left.entity_type !== right.entity_type) {
    return left.entity_type < right.entity_type ? -1 : 1;
  }
  return left.entity_id < right.entity_id ? -1 : left.entity_id > right.entity_id ? 1 : 0;
}

function materialRefs(patch: StatePatch): TraceReference[] {
  const refs: TraceReference[] = [
    ...patch.contracts.map((entity) => ({ entity_type: 'contract', entity_id: entity.id })),
    ...patch.functions.map((entity) => ({ entity_type: 'function', entity_id: entity.id })),
    ...patch.state_variables.map((entity) => ({
      entity_type: 'state_variable',
      entity_id: entity.id,
    })),
    ...patch.relationships.map((entity) => ({ entity_type: 'relationship', entity_id: entity.id })),
    ...patch.facts.map((entity) => ({ entity_type: 'fact', entity_id: entity.id })),
  ].sort(byRef);
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.entity_type}|${ref.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function patchLineage(patch: StatePatch): {
  inputs: TraceReference[];
  provenance: string[];
} {
  const files = new Set<string>();
  const spans = new Set<string>();
  const visit = (entity: LineageEntity): void => {
    if (typeof entity.source === 'string' && entity.source.length > 0) {
      spans.add(entity.source);
      const sourceFile = spanFile(entity.source);
      if (sourceFile !== undefined) files.add(sourceFile);
    }
    for (const record of entity.provenance ?? []) {
      if (record.file === undefined) continue;
      files.add(record.file);
      if (record.line_start !== undefined && record.line_end !== undefined) {
        spans.add(`${record.file}:${record.line_start}-${record.line_end}`);
      }
    }
  };
  for (const contract of patch.contracts) visit(contract);
  for (const fn of patch.functions) visit(fn);
  for (const stateVariable of patch.state_variables) visit(stateVariable);
  for (const relationship of patch.relationships) visit(relationship);
  for (const fact of patch.facts) visit(fact);

  const inputs: TraceReference[] = [...files]
    .map((file) => ({ entity_type: 'source_file', entity_id: file }))
    .sort(byRef);
  return { inputs, provenance: [...spans].sort() };
}

function outputRecords(runId: string, patch: StatePatch): RunOutputRecord[] {
  const records: RunOutputRecord[] = [];
  const push = (entityType: string, entity: { id: string }): void => {
    records.push({
      run_id: runId,
      entity_type: entityType,
      entity_id: entity.id,
      content_hash: entityContentHash(entity),
    });
  };
  for (const contract of patch.contracts) push('contract', contract);
  for (const fn of patch.functions) push('function', fn);
  for (const stateVariable of patch.state_variables) push('state_variable', stateVariable);
  for (const relationship of patch.relationships) push('relationship', relationship);
  for (const fact of patch.facts) push('fact', fact);
  return records.sort((left, right) => {
    if (left.run_id !== right.run_id) return left.run_id < right.run_id ? -1 : 1;
    if (left.entity_type !== right.entity_type) {
      return left.entity_type < right.entity_type ? -1 : 1;
    }
    return left.entity_id < right.entity_id ? -1 : left.entity_id > right.entity_id ? 1 : 0;
  });
}

export function buildTraceability(input: TraceabilityInput): TraceabilityState {
  const run: ReconRun = {
    id: input.runId,
    project_id: input.projectId,
    schema_version: input.schemaVersion,
    analyzer_version: ANALYZER_VERSION,
    started_at: input.startedAt,
    completed_at: input.startedAt,
    status: 'COMPLETED',
    source_identity: input.sourceIdentity,
    compiler_identity: input.compilerIdentity,
    configuration_identity: input.configurationIdentity,
    input_manifest_hash: input.inputManifestHash,
    output_identity: input.outputIdentity,
  };

  const derivations: Derivation[] = [];
  for (const { operation, patch } of input.perExtractor) {
    const outputs = materialRefs(patch);
    if (outputs.length === 0) continue;
    const { inputs, provenance } = patchLineage(patch);
    derivations.push({
      id: derivationId(input.runId, operation, inputs, provenance),
      run_id: input.runId,
      operation,
      operation_version: ANALYZER_VERSION,
      inputs,
      outputs,
      provenance,
      status: 'COMPLETED',
      metadata: { fidelity: input.fidelity },
    });
  }

  return {
    runs: [run],
    derivations,
    outputs: outputRecords(input.runId, input.mergedPatch),
  };
}
