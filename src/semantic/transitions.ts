import type { SolidityFunction } from '../domain/function.js';
import type { Fact } from '../epistemic/fact.js';
import type { Provenance } from '../epistemic/provenance.js';
import { COMPILATION_FAILED_CODE } from '../scope/evidence.js';
import { compareCodeUnits } from '../util/canonical.js';
import type { EvidenceIndex } from './evidence.js';
import { semanticContentId } from './ids.js';
import { StateTransitionSchema, type StateTransition, type UnknownIndexEntry } from './model.js';

export interface TransitionDerivation {
  transitions: StateTransition[];
  unknowns: UnknownIndexEntry[];
  flags: Set<string>;
}

type CallKind = StateTransition['external_effects'][number]['call_kind'];
type ExternalEffect = StateTransition['external_effects'][number];
type FidelityFlag = StateTransition['fidelity_flags'][number];
type UnknownReason = UnknownIndexEntry['reason'];

const CALL_KIND_OPTIONS: ReadonlySet<string> = new Set<string>(
  StateTransitionSchema.shape.external_effects.element.shape.call_kind.options,
);

const UNRESOLVED_MARKER_CALL_KINDS: Readonly<Record<string, CallKind>> = {
  'unresolved-lowlevel-call': 'lowlevel',
  'unresolved-staticcall': 'staticcall',
  'unresolved-indirect-call': 'indirect',
  'unresolved-delegatecall': 'delegatecall',
};

const UNSUPPORTED_ASSEMBLY_CODE = 'unsupported_assembly';
const CALL_TARGET_UNRESOLVED_CODE = 'call_target_unresolved';
const CALL_TARGET_OUTSIDE_CODE = 'call_target_outside_sources';
const SOURCE_SPAN_PATTERN = /^(.+):(\d+)-(\d+)$/;

interface SpanKey {
  file: string;
  lineStart: number;
  lineEnd: number;
  tie: string;
}

interface UnknownDraft {
  field: string;
  reason: UnknownReason;
  basis: Set<string>;
}

interface Provenanced {
  provenance: readonly Provenance[];
}

function compareSpans(a: SpanKey, b: SpanKey): number {
  return (
    compareCodeUnits(a.file, b.file) ||
    a.lineStart - b.lineStart ||
    a.lineEnd - b.lineEnd ||
    compareCodeUnits(a.tie, b.tie)
  );
}

function minProvenanceSpan(provenance: readonly Provenance[], tie: string): SpanKey | undefined {
  let best: SpanKey | undefined;
  for (const record of provenance) {
    const candidate: SpanKey = {
      file: record.file ?? '',
      lineStart: record.line_start ?? 0,
      lineEnd: record.line_end ?? 0,
      tie,
    };
    if (best === undefined || compareSpans(candidate, best) < 0) best = candidate;
  }
  return best;
}

function evidenceSpan(evidence: Provenanced, tie: string): SpanKey {
  const best = minProvenanceSpan(evidence.provenance, tie);
  if (best !== undefined) return best;
  return { file: '', lineStart: 0, lineEnd: 0, tie };
}

function functionSpan(fn: SolidityFunction, evidence: readonly Provenanced[]): SpanKey {
  const parsed = fn.source !== undefined ? SOURCE_SPAN_PATTERN.exec(fn.source) : null;
  if (
    parsed !== null &&
    parsed[1] !== undefined &&
    parsed[2] !== undefined &&
    parsed[3] !== undefined
  ) {
    return { file: parsed[1], lineStart: Number(parsed[2]), lineEnd: Number(parsed[3]), tie: fn.id };
  }
  let best: SpanKey | undefined;
  for (const item of evidence) {
    const candidate = evidenceSpan(item, fn.id);
    if (best === undefined || compareSpans(candidate, best) < 0) best = candidate;
  }
  if (best !== undefined) return best;
  return { file: '', lineStart: 0, lineEnd: 0, tie: fn.id };
}

function compareBasis(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index] as string;
    const right = b[index] as string;
    const result = compareCodeUnits(left, right);
    if (result !== 0) return result;
  }
  return a.length - b.length;
}

function compareUnknowns(a: UnknownIndexEntry, b: UnknownIndexEntry): number {
  return (
    compareCodeUnits(a.record_ref, b.record_ref) ||
    compareCodeUnits(a.field, b.field) ||
    compareCodeUnits(a.reason, b.reason) ||
    compareBasis(a.basis, b.basis)
  );
}

export function deriveTransitions(index: EvidenceIndex): TransitionDerivation {
  const factsBySubject = new Map<string, Fact[]>();
  for (const fact of index.factsById.values()) {
    const bucket = factsBySubject.get(fact.subject_id);
    if (bucket === undefined) factsBySubject.set(fact.subject_id, [fact]);
    else bucket.push(fact);
  }

  const staged: { span: SpanKey; transition: StateTransition }[] = [];
  const unknowns: UnknownIndexEntry[] = [];

  for (const fn of index.functionsById.values()) {
    const outgoing = index.graph.getRelationshipsFrom(fn.id);
    const facts = factsBySubject.get(fn.id) ?? [];
    const span = functionSpan(fn, [...outgoing, ...facts]);
    const file = span.file !== '' ? span.file : undefined;
    const fileIssues = file !== undefined ? (index.issuesByFile.get(file) ?? []) : [];

    if (fileIssues.some((issue) => issue.code === COMPILATION_FAILED_CODE)) {
      unknowns.push({
        record_ref: fn.id,
        field: 'transition',
        reason: 'dropped_file',
        basis: [fn.id],
      });
      continue;
    }

    const recordRef = semanticContentId('semt', {
      function_id: fn.id,
      contract_id: fn.contract_id,
    });
    const drafts = new Map<string, UnknownDraft>();
    const noteUnknown = (field: string, reason: UnknownReason, basis: readonly string[]): void => {
      const key = field + ' ' + reason;
      const existing = drafts.get(key);
      if (existing === undefined) {
        drafts.set(key, { field, reason, basis: new Set(basis) });
        return;
      }
      for (const id of basis) existing.basis.add(id);
    };

    const flags = new Set<FidelityFlag>();
    if (index.input.meta.fidelity === 'syntactic') flags.add('syntactic');
    if (fileIssues.some((issue) => issue.code === UNSUPPORTED_ASSEMBLY_CODE)) {
      flags.add('assembly_skipped');
      noteUnknown('fidelity_flags', 'unsupported_assembly', [fn.id]);
    }
    if (fileIssues.some((issue) => issue.code === CALL_TARGET_UNRESOLVED_CODE)) {
      noteUnknown('external_effects', 'unresolved_call', [fn.id]);
    }
    if (fileIssues.some((issue) => issue.code === CALL_TARGET_OUTSIDE_CODE)) {
      noteUnknown('external_effects', 'out_of_scope_target', [fn.id]);
    }

    const readTargets = new Set<string>();
    const writeTargets = new Set<string>();
    for (const relationship of outgoing) {
      if (relationship.type === 'READS') readTargets.add(relationship.target_id);
      else if (relationship.type === 'WRITES') writeTargets.add(relationship.target_id);
    }
    const pre_state_reads = [...readTargets].sort(compareCodeUnits);
    const writes = [...writeTargets]
      .map((state_var_id) => ({
        state_var_id,
        kind: readTargets.has(state_var_id) ? ('readwrite' as const) : ('write' as const),
      }))
      .sort((a, b) => compareCodeUnits(a.state_var_id, b.state_var_id));

    const valueHandling: 'payable' | 'nonpayable' =
      fn.mutability === 'payable' ? 'payable' : 'nonpayable';
    const pendingEffects: { span: SpanKey; effect: ExternalEffect }[] = [];
    for (const relationship of outgoing) {
      if (relationship.type !== 'CALLS') continue;
      const rawKind = relationship.metadata?.call_kind;
      const callKind =
        typeof rawKind === 'string' && CALL_KIND_OPTIONS.has(rawKind)
          ? (rawKind as CallKind)
          : undefined;
      if (callKind === undefined) {
        noteUnknown('external_effects', 'no_evidence', [relationship.id]);
        continue;
      }
      const resolved = index.functionsById.has(relationship.target_id);
      if (!resolved) noteUnknown('external_effects', 'out_of_scope_target', [relationship.id]);
      const effect: ExternalEffect = {
        call_kind: callKind,
        ...(resolved ? { target_ref: relationship.target_id } : {}),
        target_evidence: resolved ? 'E1' : 'E3',
        value_handling: valueHandling,
        basis: [relationship.id],
      };
      pendingEffects.push({ span: evidenceSpan(relationship, relationship.id), effect });
    }
    for (const fact of facts) {
      if (fact.predicate !== 'CALLS' && fact.predicate !== 'DELEGATES_TO') continue;
      const callKind =
        typeof fact.value === 'string' ? UNRESOLVED_MARKER_CALL_KINDS[fact.value] : undefined;
      if (callKind === undefined) continue;
      noteUnknown('external_effects', 'unresolved_call', [fact.id]);
      const effect: ExternalEffect = {
        call_kind: callKind,
        target_evidence: 'E3',
        value_handling: valueHandling,
        basis: [fact.id],
      };
      pendingEffects.push({ span: evidenceSpan(fact, fact.id), effect });
    }
    pendingEffects.sort((a, b) => compareSpans(a.span, b.span));
    const external_effects = pendingEffects.map((entry) => entry.effect);

    const pendingObservations = facts
      .filter((fact) => fact.predicate === 'EMITS')
      .map((fact) => ({ span: evidenceSpan(fact, fact.id), id: fact.id }));
    pendingObservations.sort((a, b) => compareSpans(a.span, b.span));
    const post_state_observations = pendingObservations.map((entry) => entry.id);

    const basisIds = new Set<string>([fn.id]);
    for (const relationship of outgoing) basisIds.add(relationship.id);
    for (const fact of facts) basisIds.add(fact.id);

    const recordUnknowns = [...drafts.values()]
      .map((draft): UnknownIndexEntry => {
        const basis = [...draft.basis].sort(compareCodeUnits);
        return { record_ref: recordRef, field: draft.field, reason: draft.reason, basis };
      })
      .sort(compareUnknowns);

    const transition = StateTransitionSchema.parse({
      id: recordRef,
      function_id: fn.id,
      contract_id: fn.contract_id,
      pre_state_reads,
      writes,
      external_effects,
      asset_movements: [],
      post_state_observations,
      state_mutation: writes.length > 0 ? 'storage' : 'none',
      fidelity_flags: [...flags].sort(compareCodeUnits),
      unknowns: recordUnknowns,
      basis: [...basisIds].sort(compareCodeUnits),
    });

    unknowns.push(...recordUnknowns);
    staged.push({ span, transition });
  }

  staged.sort((a, b) => compareSpans(a.span, b.span));
  unknowns.sort(compareUnknowns);

  const flags = new Set<string>();
  for (const entry of staged) {
    if (entry.transition.fidelity_flags.length > 0) flags.add(entry.transition.function_id);
  }

  return { transitions: staged.map((entry) => entry.transition), unknowns, flags };
}
