import { createHash } from 'node:crypto';
import { ReconError } from '../errors/errors.js';
import { compareCodeUnits, stableStringify } from '../util/canonical.js';
import {
  SemanticDraftSchema,
  SemanticModelSchema,
  type SemanticDraft,
  type SemanticModel,
  type SinvReason,
  type UnknownIndexEntry,
} from './model.js';

type UnhashedModel = Omit<SemanticModel, 'semantic_hash'>;

function fail(reason: SinvReason, message: string): never {
  throw new ReconError('InvalidSemanticModel', message, { reason });
}

function parseDraft(draft: SemanticDraft): SemanticDraft {
  const parsed = SemanticDraftSchema.safeParse(draft);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    fail('schema', `semantic draft failed schema validation: ${detail}`);
  }
  return parsed.data;
}

function collectIdLists(draft: SemanticDraft): Array<{ name: string; ids: string[] }> {
  return [
    { name: 'contracts', ids: draft.contracts.map((record) => record.id) },
    { name: 'transitions', ids: draft.transitions.map((record) => record.id) },
    { name: 'assets', ids: draft.assets.map((record) => record.id) },
    { name: 'custody', ids: draft.custody.map((record) => record.id) },
    { name: 'claims', ids: draft.claims.map((record) => record.id) },
    { name: 'accounting', ids: draft.accounting.map((record) => record.id) },
    { name: 'authority', ids: draft.authority.map((record) => record.id) },
    { name: 'trust.dependencies', ids: draft.trust.dependencies.map((record) => record.id) },
    { name: 'trust.capabilities', ids: draft.trust.capabilities.map((record) => record.id) },
    { name: 'epistemic.observations', ids: draft.epistemic.observations.map((record) => record.id) },
    { name: 'epistemic.assumptions', ids: draft.epistemic.assumptions.map((record) => record.id) },
    { name: 'epistemic.hypotheses', ids: draft.epistemic.hypotheses.map((record) => record.id) },
    { name: 'epistemic.invariants', ids: draft.epistemic.invariants.map((record) => record.id) },
  ];
}

function assertUniqueIds(draft: SemanticDraft): void {
  const seen = new Set<string>();
  for (const { name, ids } of collectIdLists(draft)) {
    for (const id of ids) {
      if (seen.has(id)) {
        fail('ids_unsorted', `duplicate id '${id}' in ${name}`);
      }
      seen.add(id);
    }
  }
}

function layerArraysEmpty(draft: SemanticDraft): boolean {
  return (
    draft.contracts.length === 0 &&
    draft.transitions.length === 0 &&
    draft.assets.length === 0 &&
    draft.custody.length === 0 &&
    draft.claims.length === 0 &&
    draft.accounting.length === 0 &&
    draft.authority.length === 0 &&
    draft.trust.dependencies.length === 0 &&
    draft.trust.capabilities.length === 0 &&
    draft.epistemic.observations.length === 0 &&
    draft.epistemic.assumptions.length === 0 &&
    draft.epistemic.hypotheses.length === 0 &&
    draft.epistemic.invariants.length === 0 &&
    draft.unknowns.length === 0
  );
}

function checkEnvelopeShape(draft: SemanticDraft): void {
  if (draft.status === 'FAILED' && !layerArraysEmpty(draft)) {
    fail('envelope_invalid', 'status FAILED requires all layer arrays to be empty');
  }
  if (draft.status === 'COMPLETE' && draft.input.degradation !== undefined && draft.input.degradation.length > 0) {
    fail('envelope_invalid', 'status COMPLETE must not carry degradation notes');
  }
  if (
    draft.status === 'PARTIAL' &&
    (draft.input.degradation === undefined || draft.input.degradation.length === 0) &&
    draft.unknowns.length === 0
  ) {
    fail('envelope_invalid', 'status PARTIAL requires at least one degradation note or unknown entry');
  }
}

function sortById<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => compareCodeUnits(left.id, right.id));
}

function compareUnknownEntries(left: UnknownIndexEntry, right: UnknownIndexEntry): number {
  return (
    compareCodeUnits(left.record_ref, right.record_ref) ||
    compareCodeUnits(left.field, right.field) ||
    compareCodeUnits(left.reason, right.reason) ||
    compareCodeUnits(stableStringify(left.basis), stableStringify(right.basis))
  );
}

function hashCanonical(value: UnhashedModel): string {
  const { binding, ...rest } = value;
  const { run_id: _run, input_manifest_hash: _manifest, scope_hash: _scope, ...bindingRest } = binding;
  const payload = { ...rest, binding: bindingRest };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function computeSemanticHash(model: SemanticModel): string {
  const { semantic_hash: _stripped, ...unhashed } = model;
  return hashCanonical(unhashed);
}

export function finalizeSemanticModel(draft: SemanticDraft): SemanticModel {
  const parsed = parseDraft(draft);
  assertUniqueIds(parsed);
  checkEnvelopeShape(parsed);
  const unhashed: UnhashedModel = {
    ...parsed,
    input:
      parsed.input.degradation === undefined
        ? parsed.input
        : { ...parsed.input, degradation: [...parsed.input.degradation].sort(compareCodeUnits) },
    contracts: sortById(parsed.contracts),
    transitions: sortById(parsed.transitions),
    assets: sortById(parsed.assets),
    custody: sortById(parsed.custody),
    claims: sortById(parsed.claims),
    accounting: sortById(parsed.accounting),
    authority: sortById(parsed.authority),
    trust: {
      dependencies: sortById(parsed.trust.dependencies),
      capabilities: sortById(parsed.trust.capabilities),
    },
    epistemic: {
      observations: sortById(parsed.epistemic.observations),
      assumptions: sortById(parsed.epistemic.assumptions),
      hypotheses: sortById(parsed.epistemic.hypotheses),
      invariants: sortById(parsed.epistemic.invariants),
    },
    unknowns: [...parsed.unknowns].sort(compareUnknownEntries),
    counts: {
      transitions: parsed.transitions.length,
      assets: parsed.assets.length,
      custody: parsed.custody.length,
      claims: parsed.claims.length,
      accounting: parsed.accounting.length,
      authority: parsed.authority.length,
      trust: parsed.trust.dependencies.length + parsed.trust.capabilities.length,
      observations: parsed.epistemic.observations.length,
      assumptions: parsed.epistemic.assumptions.length,
      hypotheses: parsed.epistemic.hypotheses.length,
      invariants: parsed.epistemic.invariants.length,
      unknowns: parsed.unknowns.length,
    },
  };
  const semantic_hash = hashCanonical(unhashed);
  const reparsed = SemanticModelSchema.safeParse({ ...unhashed, semantic_hash });
  if (!reparsed.success) {
    const detail = reparsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    fail('schema', `finalized semantic model failed schema validation: ${detail}`);
  }
  return reparsed.data;
}

export function serializeSemanticModel(model: SemanticModel): string {
  return stableStringify(model);
}
