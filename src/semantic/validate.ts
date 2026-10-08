import { createHash } from 'node:crypto';
import { ReconError } from '../errors/errors.js';
import { SemanticModelSchema, type SemanticModel, type SinvReason, type InvariantStatus } from './model.js';
import { computeOutputIdentity } from '../traceability/identities.js';
import { stableStringify, compareCodeUnits, sortedIds } from '../util/canonical.js';
import type { ReconState } from '../recon-state/schema.js';
import type { ScopeReport, ScopeEntry } from '../scope/model.js';
import type { Provenance } from '../epistemic/provenance.js';

function fail(reason: SinvReason, message: string): never {
  throw new ReconError('InvalidSemanticModel', message, { reason });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

function hasLeakage(value: unknown, path: string = ''): { found: boolean; detail: string } {
  if (typeof value === 'string') {
    if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(value)) {
      return { found: true, detail: `ISO timestamp at ${path}: ${value}` };
    }
    if (value.includes('/') && /\/\S/.test(value)) {
      const absPathMatch = value.match(/(^|\s)\/[\w\/.-]+/);
      if (absPathMatch) {
        return { found: true, detail: `absolute path at ${path}: ${value}` };
      }
    }
    if (value.includes('\\')) {
      return { found: true, detail: `backslash at ${path}: ${value}` };
    }
    return { found: false, detail: '' };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const result = hasLeakage(value[i], `${path}[${i}]`);
      if (result.found) return result;
    }
    return { found: false, detail: '' };
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const result = hasLeakage(val, path ? `${path}.${key}` : key);
      if (result.found) return result;
    }
    return { found: false, detail: '' };
  }
  return { found: false, detail: '' };
}

function collectStateIds(state: ReconState): Set<string> {
  const ids = new Set<string>();
  if (state.project?.id) ids.add(state.project.id);
  for (const c of state.contracts) if (c.id) ids.add(c.id);
  for (const f of state.functions) if (f.id) ids.add(f.id);
  for (const sv of state.state_variables) if (sv.id) ids.add(sv.id);
  for (const a of state.assets) if (a.id) ids.add(a.id);
  for (const r of state.roles) if (r.id) ids.add(r.id);
  for (const d of state.dependencies) if (d.id) ids.add(d.id);
  for (const rel of state.relationships) if (rel.id) ids.add(rel.id);
  for (const fact of state.facts) if (fact.id) ids.add(fact.id);
  for (const obs of state.observations) if (obs.id) ids.add(obs.id);
  for (const asm of state.assumptions) if (asm.id) ids.add(asm.id);
  for (const hyp of state.hypotheses) if (hyp.id) ids.add(hyp.id);
  for (const ev of state.evidence) if (ev.id) ids.add(ev.id);
  for (const prov of state.provenance) if (prov.id) ids.add(prov.id);
  return ids;
}

function collectArtifactIds(model: SemanticModel): Set<string> {
  const ids = new Set<string>();
  for (const c of model.contracts) ids.add(c.id);
  for (const t of model.transitions) ids.add(t.id);
  for (const a of model.assets) ids.add(a.id);
  for (const c of model.custody) ids.add(c.id);
  for (const cl of model.claims) ids.add(cl.id);
  for (const acc of model.accounting) ids.add(acc.id);
  for (const au of model.authority) ids.add(au.id);
  for (const d of model.trust.dependencies) ids.add(d.id);
  for (const cap of model.trust.capabilities) ids.add(cap.id);
  for (const obs of model.epistemic.observations) ids.add(obs.id);
  for (const asm of model.epistemic.assumptions) ids.add(asm.id);
  for (const hyp of model.epistemic.hypotheses) ids.add(hyp.id);
  for (const inv of model.epistemic.invariants) ids.add(inv.id);
  return ids;
}

function collectProvenanceIds(state: ReconState): Set<string> {
  const ids = new Set<string>();
  for (const prov of state.provenance) if (prov.id) ids.add(prov.id);
  return ids;
}

function getProvenanceRecord(state: ReconState, id: string): Provenance | undefined {
  return state.provenance.find((p) => p.id === id);
}

function resolveBasisRef(
  ref: string,
  stateIds: Set<string>,
  artifactIds: Set<string>,
  provenanceIds: Set<string>,
  state: ReconState,
): { resolved: boolean; isProvenanceCopy: boolean } {
  if (stateIds.has(ref)) return { resolved: true, isProvenanceCopy: false };
  if (artifactIds.has(ref)) return { resolved: true, isProvenanceCopy: false };
  if (provenanceIds.has(ref)) {
    const provRecord = getProvenanceRecord(state, ref);
    return { resolved: provRecord !== undefined, isProvenanceCopy: true };
  }
  return { resolved: false, isProvenanceCopy: false };
}

function checkBasisResolvable(
  basis: string[],
  stateIds: Set<string>,
  artifactIds: Set<string>,
  provenanceIds: Set<string>,
  state: ReconState,
): void {
  for (const ref of basis) {
    const { resolved, isProvenanceCopy } = resolveBasisRef(ref, stateIds, artifactIds, provenanceIds, state);
    if (!resolved) {
      fail('basis_unresolvable', `basis reference '${ref}' does not resolve to any state, artifact, or provenance entity`);
    }
    if (isProvenanceCopy) {
      const provRecord = getProvenanceRecord(state, ref);
      if (!provRecord) {
        fail('basis_unresolvable', `provenance reference '${ref}' not found in state provenance registry`);
      }
    }
  }
}

function buildBasedOnGraph(model: SemanticModel): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const obs of model.epistemic.observations) {
    graph.set(obs.id, [...obs.based_on]);
  }
  for (const asm of model.epistemic.assumptions) {
    graph.set(asm.id, [...asm.based_on]);
  }
  for (const hyp of model.epistemic.hypotheses) {
    graph.set(hyp.id, [...hyp.based_on]);
  }
  for (const inv of model.epistemic.invariants) {
    graph.set(inv.id, [...inv.based_on]);
  }
  return graph;
}

function hasCycle(graph: Map<string, string[]>): { hasCycle: boolean; cyclePath?: string[] } {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }

    recStack.delete(node);
    path.pop();
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      path.length = 0;
      if (dfs(node)) {
        const lastNode = path[path.length - 1];
        if (!lastNode) return { hasCycle: true, cyclePath: [] };
        const cycleStart = path.indexOf(lastNode);
        return { hasCycle: true, cyclePath: path.slice(cycleStart) };
      }
    }
  }
  return { hasCycle: false };
}

function checkProvenanceRoots(model: SemanticModel, state: ReconState): void {
  const graph = buildBasedOnGraph(model);
  const allRefs = new Set<string>();
  for (const refs of graph.values()) {
    for (const ref of refs) allRefs.add(ref);
  }
  const roots = [...allRefs].filter((ref) => !graph.has(ref));

  const stateIds = collectStateIds(state);
  const provenanceIds = collectProvenanceIds(state);

  for (const root of roots) {
    if (stateIds.has(root) || provenanceIds.has(root)) continue;
    fail('provenance_incomplete', `root reference '${root}' in based_on DAG has no provenance and is not a state entity`);
  }
}

function checkEpistemicUpgrade(model: SemanticModel): void {
  for (const obs of model.epistemic.observations) {
    if (obs.confidence.level !== 'DERIVED') {
      fail('epistemic_upgrade', `observation ${obs.id} has confidence level ${obs.confidence.level}, expected DERIVED`);
    }
  }
  for (const asm of model.epistemic.assumptions) {
    if (asm.confidence.level !== 'INFERRED') {
      fail('epistemic_upgrade', `assumption ${asm.id} has confidence level ${asm.confidence.level}, expected INFERRED`);
    }
  }
  for (const hyp of model.epistemic.hypotheses) {
    if (hyp.confidence.level !== 'SPECULATIVE') {
      fail('epistemic_upgrade', `hypothesis ${hyp.id} has confidence level ${hyp.confidence.level}, expected SPECULATIVE`);
    }
  }
}

function checkEpistemicLeak(model: SemanticModel): void {
  const forbiddenPatterns = ['is vulnerable', 'vulnerable', 'exploit', 'severity', 'critical', 'finding', 'attack', 'poc', 'confirmed'];
  const checkString = (str: string, context: string): void => {
    const lower = str.toLowerCase();
    for (const pattern of forbiddenPatterns) {
      if (lower.includes(pattern)) {
        fail('epistemic_leak', `forbidden vocabulary '${pattern}' found in ${context}: ${str}`);
      }
    }
  };

  for (const obs of model.epistemic.observations) {
    checkString(obs.statement, `observation ${obs.id}`);
  }
  for (const asm of model.epistemic.assumptions) {
    checkString(asm.statement, `assumption ${asm.id}`);
  }
  for (const hyp of model.epistemic.hypotheses) {
    checkString(hyp.statement, `hypothesis ${hyp.id}`);
  }
  for (const inv of model.epistemic.invariants) {
    checkString(inv.statement, `invariant ${inv.id}`);
    if (inv.status === 'CONFIRMED' as InvariantStatus) {
      fail('epistemic_leak', `invariant ${inv.id} has forbidden status CONFIRMED`);
    }
  }
}

function checkTargetAttribution(model: SemanticModel, state: ReconState): void {
  const stateIds = collectStateIds(state);
  const artifactIds = collectArtifactIds(model);
  const provenanceIds = collectProvenanceIds(state);

  const allRecords: Array<{ id: string; basis: string[]; type: string }> = [];

  for (const c of model.contracts) allRecords.push({ id: c.id, basis: c.basis, type: 'ContractSemantics' });
  for (const t of model.transitions) allRecords.push({ id: t.id, basis: t.basis, type: 'StateTransition' });
  for (const a of model.assets) allRecords.push({ id: a.id, basis: a.basis, type: 'AssetRecord' });
  for (const c of model.custody) allRecords.push({ id: c.id, basis: c.basis, type: 'CustodyRecord' });
  for (const cl of model.claims) allRecords.push({ id: cl.id, basis: cl.basis, type: 'ClaimRecord' });
  for (const acc of model.accounting) allRecords.push({ id: acc.id, basis: acc.basis, type: 'AccountingRelation' });
  for (const au of model.authority) {
    const perLinkBasis = au.per_link.flatMap((link) => link.basis);
    allRecords.push({ id: au.id, basis: perLinkBasis, type: 'AuthorityChain' });
  }
  for (const d of model.trust.dependencies) allRecords.push({ id: d.id, basis: d.basis, type: 'ExternalDependency' });
  for (const cap of model.trust.capabilities) allRecords.push({ id: cap.id, basis: cap.basis, type: 'TrustCapability' });
  for (const obs of model.epistemic.observations) allRecords.push({ id: obs.id, basis: [...obs.based_on, ...obs.provenance.map((p) => p.id)], type: 'SemanticObservation' });
  for (const asm of model.epistemic.assumptions) allRecords.push({ id: asm.id, basis: asm.based_on, type: 'SemanticAssumption' });
  for (const hyp of model.epistemic.hypotheses) allRecords.push({ id: hyp.id, basis: hyp.based_on, type: 'SemanticHypothesis' });
  for (const inv of model.epistemic.invariants) allRecords.push({ id: inv.id, basis: inv.based_on, type: 'CandidateInvariant' });

  function tracesToStateEntity(ref: string, visited: Set<string> = new Set()): boolean {
    if (visited.has(ref)) return false;
    visited.add(ref);
    if (stateIds.has(ref)) return true;
    if (provenanceIds.has(ref)) return true;
    if (artifactIds.has(ref)) {
      const obs = model.epistemic.observations.find((o) => o.id === ref);
      if (obs) return [...obs.based_on, ...obs.provenance.map((p) => p.id)].some((r) => tracesToStateEntity(r, visited));
      const asm = model.epistemic.assumptions.find((a) => a.id === ref);
      if (asm) return asm.based_on.some((r) => tracesToStateEntity(r, visited));
      const hyp = model.epistemic.hypotheses.find((h) => h.id === ref);
      if (hyp) return hyp.based_on.some((r) => tracesToStateEntity(r, visited));
      const inv = model.epistemic.invariants.find((i) => i.id === ref);
      if (inv) return inv.based_on.some((r) => tracesToStateEntity(r, visited));
    }
    return false;
  }

  for (const record of allRecords) {
    let hasAttribution = false;
    for (const ref of record.basis) {
      if (tracesToStateEntity(ref)) {
        hasAttribution = true;
        break;
      }
    }
    if (!hasAttribution) {
      fail('unattributed', `record ${record.id} (${record.type}) has no basis referencing a state entity`);
    }
  }
}

function checkUnknownDiscipline(model: SemanticModel): void {
  const unknownRefs = new Set<string>();
  for (const u of model.unknowns) {
    unknownRefs.add(`${u.record_ref}.${u.field}`);
  }

  for (const t of model.transitions) {
    for (const effect of t.external_effects) {
      if (effect.target_evidence === 'E3' && !effect.target_ref) {
        // Layers B/F record the failure-branch entry under the layer field
        // name ('external_effects'); the dotted sub-field path is accepted as
        // an equivalent ledger key. Either entry satisfies SINV-9.
        const dotted = `${t.id}.external_effects.target_ref`;
        const layer = `${t.id}.external_effects`;
        if (!unknownRefs.has(dotted) && !unknownRefs.has(layer)) {
          fail('unknown_flattened', `transition ${t.id} has E3 external effect without target_ref and no UnknownIndexEntry`);
        }
      }
    }
    for (const movement of t.asset_movements) {
      if (!movement.asset_ref) {
        const key = `${t.id}.asset_movements.asset_ref`;
        if (!unknownRefs.has(key)) {
          fail('unknown_flattened', `transition ${t.id} has asset movement without asset_ref and no UnknownIndexEntry`);
        }
      }
    }
  }

  for (const acc of model.accounting) {
    for (const endpoint of acc.endpoints) {
      if (!model.assets.some((a) => a.id === endpoint)) {
        const key = `${acc.id}.endpoints`;
        if (!unknownRefs.has(key)) {
          fail('unknown_flattened', `accounting relation ${acc.id} references unknown asset ${endpoint} without UnknownIndexEntry`);
        }
      }
    }
  }
}

function computeSemanticHash(model: SemanticModel): string {
  const { semantic_hash: _hash, binding, ...rest } = model;
  const { run_id: _run, input_manifest_hash: _manifest, scope_hash: _scope, ...bindingRest } = binding;
  const payload = { ...rest, binding: bindingRest };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function validateSemanticModel(model: unknown, ctx: { state: ReconState; scopeReport?: ScopeReport }): SemanticModel {
  const { state, scopeReport } = ctx;

  const parsed = SemanticModelSchema.safeParse(model);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    fail('schema', `semantic model failed schema validation: ${detail}`);
  }
  const semanticModel = parsed.data;

  const seenIds = new Set<string>();
  const allArrays: Array<{ name: string; array: readonly { id: string }[] }> = [
    { name: 'contracts', array: semanticModel.contracts },
    { name: 'transitions', array: semanticModel.transitions },
    { name: 'assets', array: semanticModel.assets },
    { name: 'custody', array: semanticModel.custody },
    { name: 'claims', array: semanticModel.claims },
    { name: 'accounting', array: semanticModel.accounting },
    { name: 'authority', array: semanticModel.authority },
    { name: 'trust.dependencies', array: semanticModel.trust.dependencies },
    { name: 'trust.capabilities', array: semanticModel.trust.capabilities },
    { name: 'epistemic.observations', array: semanticModel.epistemic.observations },
    { name: 'epistemic.assumptions', array: semanticModel.epistemic.assumptions },
    { name: 'epistemic.hypotheses', array: semanticModel.epistemic.hypotheses },
    { name: 'epistemic.invariants', array: semanticModel.epistemic.invariants },
  ];

  for (const { name, array } of allArrays) {
    for (let i = 0; i < array.length; i++) {
      const record = array[i];
      if (!record) continue;
      const id = record.id;
      if (seenIds.has(id)) {
        fail('ids_unsorted', `duplicate id '${id}' in ${name}`);
      }
      seenIds.add(id);
      if (i > 0) {
        const prevRecord = array[i - 1];
        if (!prevRecord) continue;
        const prevId = prevRecord.id;
        if (compareCodeUnits(prevId, id) > 0) {
          fail('ids_unsorted', `${name} not sorted by id: '${prevId}' precedes '${id}'`);
        }
      }
    }
  }

  const counts = semanticModel.counts;
  if (counts.transitions !== semanticModel.transitions.length) fail('ids_unsorted', `counts.transitions ${counts.transitions} !== transitions.length ${semanticModel.transitions.length}`);
  if (counts.assets !== semanticModel.assets.length) fail('ids_unsorted', `counts.assets ${counts.assets} !== assets.length ${semanticModel.assets.length}`);
  if (counts.custody !== semanticModel.custody.length) fail('ids_unsorted', `counts.custody ${counts.custody} !== custody.length ${semanticModel.custody.length}`);
  if (counts.claims !== semanticModel.claims.length) fail('ids_unsorted', `counts.claims ${counts.claims} !== claims.length ${semanticModel.claims.length}`);
  if (counts.accounting !== semanticModel.accounting.length) fail('ids_unsorted', `counts.accounting ${counts.accounting} !== accounting.length ${semanticModel.accounting.length}`);
  if (counts.authority !== semanticModel.authority.length) fail('ids_unsorted', `counts.authority ${counts.authority} !== authority.length ${semanticModel.authority.length}`);
  if (counts.trust !== semanticModel.trust.dependencies.length + semanticModel.trust.capabilities.length) {
    fail('ids_unsorted', `counts.trust ${counts.trust} !== dependencies.length + capabilities.length ${semanticModel.trust.dependencies.length + semanticModel.trust.capabilities.length}`);
  }
  if (counts.observations !== semanticModel.epistemic.observations.length) fail('ids_unsorted', `counts.observations ${counts.observations} !== observations.length ${semanticModel.epistemic.observations.length}`);
  if (counts.assumptions !== semanticModel.epistemic.assumptions.length) fail('ids_unsorted', `counts.assumptions ${counts.assumptions} !== assumptions.length ${semanticModel.epistemic.assumptions.length}`);
  if (counts.hypotheses !== semanticModel.epistemic.hypotheses.length) fail('ids_unsorted', `counts.hypotheses ${counts.hypotheses} !== hypotheses.length ${semanticModel.epistemic.hypotheses.length}`);
  if (counts.invariants !== semanticModel.epistemic.invariants.length) fail('ids_unsorted', `counts.invariants ${counts.invariants} !== invariants.length ${semanticModel.epistemic.invariants.length}`);
  if (counts.unknowns !== semanticModel.unknowns.length) fail('ids_unsorted', `counts.unknowns ${counts.unknowns} !== unknowns.length ${semanticModel.unknowns.length}`);

  const allRecords: Array<{ id: string; basis: string[] }> = [];
  for (const c of semanticModel.contracts) allRecords.push({ id: c.id, basis: c.basis });
  for (const t of semanticModel.transitions) allRecords.push({ id: t.id, basis: t.basis });
  for (const a of semanticModel.assets) allRecords.push({ id: a.id, basis: a.basis });
  for (const c of semanticModel.custody) allRecords.push({ id: c.id, basis: c.basis });
  for (const cl of semanticModel.claims) allRecords.push({ id: cl.id, basis: cl.basis });
  for (const acc of semanticModel.accounting) allRecords.push({ id: acc.id, basis: acc.basis });
  for (const d of semanticModel.trust.dependencies) allRecords.push({ id: d.id, basis: d.basis });
  for (const cap of semanticModel.trust.capabilities) allRecords.push({ id: cap.id, basis: cap.basis });
  for (const obs of semanticModel.epistemic.observations) allRecords.push({ id: obs.id, basis: [...obs.based_on, ...obs.provenance.map((p) => p.id)] });
  for (const asm of semanticModel.epistemic.assumptions) allRecords.push({ id: asm.id, basis: asm.based_on });
  for (const hyp of semanticModel.epistemic.hypotheses) allRecords.push({ id: hyp.id, basis: hyp.based_on });
  for (const inv of semanticModel.epistemic.invariants) allRecords.push({ id: inv.id, basis: inv.based_on });

  for (const record of allRecords) {
    if (record.basis.length === 0) {
      fail('basis_missing', `record ${record.id} has empty basis array`);
    }
  }

  const stateIds = collectStateIds(state);
  const artifactIds = collectArtifactIds(semanticModel);
  const provenanceIds = collectProvenanceIds(state);

  for (const record of allRecords) {
    checkBasisResolvable(record.basis, stateIds, artifactIds, provenanceIds, state);
  }

  for (const obs of semanticModel.epistemic.observations) {
    for (const prov of obs.provenance) {
      const stateProv = getProvenanceRecord(state, prov.id);
      if (!stateProv) {
        fail('basis_unresolvable', `observation ${obs.id} references provenance ${prov.id} not found in state`);
      }
      if (!deepEqual(prov, stateProv)) {
        fail('basis_unresolvable', `observation ${obs.id} provenance ${prov.id} does not byte-equal state provenance record`);
      }
    }
  }

  const { hasCycle: cycleDetected, cyclePath } = hasCycle(buildBasedOnGraph(semanticModel));
  if (cycleDetected) {
    fail('provenance_incomplete', `based_on DAG contains cycle: ${cyclePath?.join(' -> ')}`);
  }
  checkProvenanceRoots(semanticModel, state);

  checkEpistemicUpgrade(semanticModel);
  checkEpistemicLeak(semanticModel);
  checkTargetAttribution(semanticModel, state);
  checkUnknownDiscipline(semanticModel);

  const recomputedHash = computeSemanticHash(semanticModel);
  if (recomputedHash !== semanticModel.semantic_hash) {
    fail('hash_mismatch', `semantic_hash mismatch: expected ${recomputedHash}, got ${semanticModel.semantic_hash}`);
  }

  const leakage = hasLeakage(semanticModel);
  if (leakage.found) {
    fail('leakage', leakage.detail);
  }

  const outputIdentity = computeOutputIdentity(state);
  if (semanticModel.input.state_output_hash !== outputIdentity.output_hash) {
    fail('binding_mismatch', `input.state_output_hash ${semanticModel.input.state_output_hash} !== computeOutputIdentity(state).output_hash ${outputIdentity.output_hash}`);
  }

  if (semanticModel.binding.run_id !== undefined) {
    const currentRun = state.traceability?.runs.find(
      (run) => run.output_identity?.output_hash === outputIdentity.output_hash,
    );
    if (!currentRun) {
      fail('binding_mismatch', `binding.run_id ${semanticModel.binding.run_id} provided but no current run found in state`);
    }
    if (currentRun.id !== semanticModel.binding.run_id) {
      fail('binding_mismatch', `binding.run_id ${semanticModel.binding.run_id} does not match current run ${currentRun.id}`);
    }
  }

  if (semanticModel.binding.scope_hash !== undefined && scopeReport) {
    if (semanticModel.binding.scope_hash !== scopeReport.scope_hash) {
      fail('binding_mismatch', `binding.scope_hash ${semanticModel.binding.scope_hash} !== scopeReport.scope_hash ${scopeReport.scope_hash}`);
    }
  }

  if (scopeReport) {
    const allowedPaths = new Set<string>();
    for (const entry of scopeReport.entries) {
      if (entry.status === 'ANALYZED' || entry.status === 'UNRESOLVED') {
        allowedPaths.add(entry.path);
      }
    }

    const provenanceFiles = new Set<string>();
    const addFile = (file: string | undefined): void => {
      if (file !== undefined && file.length > 0) provenanceFiles.add(file);
    };

    const visitEntity = (entity: { source?: unknown; provenance?: unknown }): void => {
      if (Array.isArray(entity.provenance)) {
        for (const record of entity.provenance as { file?: unknown }[]) {
          if (typeof record.file === 'string') addFile(record.file);
        }
      }
      if (typeof entity.source === 'string') addFile(entity.source);
    };

    const entities: unknown[] = [
      state.project,
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
    for (const entity of entities) {
      if (entity === undefined || entity === null) continue;
      visitEntity(entity as { source?: unknown; provenance?: unknown });
    }
    for (const record of state.provenance) addFile(record.file);

    for (const file of provenanceFiles) {
      const entry = scopeReport.entries.find((e) => e.path === file);
      if (!allowedPaths.has(file)) {
        if (entry?.status === 'EXCLUDED') {
          fail('scope_conflict', `semantic model references file '${file}' which has scope status EXCLUDED`);
        }
        if (entry?.status === 'UNRESOLVED' || entry?.status === 'UNSUPPORTED') {
          const hasDegradation = semanticModel.input.degradation?.some((d) => d.includes(file) || d.includes('unresolved'));
          if (!hasDegradation) {
            fail('scope_conflict', `semantic model references file '${file}' with scope status ${entry.status} but no degradation note in input.degradation`);
          }
        }
      } else if (entry?.status === 'UNRESOLVED' || entry?.status === 'UNSUPPORTED') {
        const hasDegradation = semanticModel.input.degradation?.some((d) => d.includes(file) || d.includes('unresolved'));
        if (!hasDegradation) {
          fail('scope_conflict', `semantic model references file '${file}' with scope status ${entry.status} but no degradation note in input.degradation`);
        }
      }
    }
  }

  if (semanticModel.input.fidelity === 'syntactic') {
    if (semanticModel.status !== 'PARTIAL') {
      fail('fidelity_mismatch', `input.fidelity is 'syntactic' but model status is '${semanticModel.status}', expected PARTIAL`);
    }
    if (!semanticModel.input.degradation || semanticModel.input.degradation.length === 0) {
      fail('fidelity_mismatch', `input.fidelity is 'syntactic' but input.degradation is empty`);
    }
  }

  if (semanticModel.status === 'FAILED') {
    if (semanticModel.contracts.length > 0 ||
        semanticModel.transitions.length > 0 ||
        semanticModel.assets.length > 0 ||
        semanticModel.custody.length > 0 ||
        semanticModel.claims.length > 0 ||
        semanticModel.accounting.length > 0 ||
        semanticModel.authority.length > 0 ||
        semanticModel.trust.dependencies.length > 0 ||
        semanticModel.trust.capabilities.length > 0 ||
        semanticModel.epistemic.observations.length > 0 ||
        semanticModel.epistemic.assumptions.length > 0 ||
        semanticModel.epistemic.hypotheses.length > 0 ||
        semanticModel.epistemic.invariants.length > 0 ||
        semanticModel.unknowns.length > 0) {
      fail('envelope_invalid', 'status FAILED requires all layer arrays to be empty');
    }
    if (!semanticModel.failure) {
      fail('envelope_invalid', 'status FAILED requires failure field');
    }
  } else if (semanticModel.status === 'COMPLETE') {
    if (semanticModel.input.degradation && semanticModel.input.degradation.length > 0) {
      fail('envelope_invalid', 'status COMPLETE must not have degradation notes');
    }
  } else if (semanticModel.status === 'PARTIAL') {
    const hasDegradation = semanticModel.input.degradation && semanticModel.input.degradation.length > 0;
    const hasUnknowns = semanticModel.unknowns.length > 0;
    if (!hasDegradation && !hasUnknowns) {
      fail('envelope_invalid', 'status PARTIAL requires at least one degradation note or unknown entry');
    }
  }

  return semanticModel;
}

export type { SinvReason } from './model.js';