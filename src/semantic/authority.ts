import type { EvidenceIndex } from './evidence.js';
import type { StateTransition } from './model.js';
import { semanticContentId } from './ids.js';
import {
  AuthorityChainSchema,
  UnknownIndexEntrySchema,
  type AuthorityChain,
  type UnknownIndexEntry,
} from './model.js';
import { ROLE_TYPES } from '../domain/enums.js';
import {
  OWNER_PINS,
  ADMIN_PINS,
  GOVERNANCE_PINS,
  UPGRADER_PINS,
  PAUSER_PINS,
  KEEPER_PINS,
  RELAYER_PINS,
} from './pins.js';
import { compareCodeUnits } from '../util/canonical.js';

export interface AuthorityDerivation {
  authority: AuthorityChain[];
  unknowns: UnknownIndexEntry[];
}

const ROLE_PIN_MAP: ReadonlyMap<string, readonly string[]> = new Map([
  ['owner', OWNER_PINS],
  ['admin', ADMIN_PINS],
  ['governance', GOVERNANCE_PINS],
  ['upgrader', UPGRADER_PINS],
  ['pauser', PAUSER_PINS],
  ['keeper', KEEPER_PINS],
  ['relayer', RELAYER_PINS],
]);

const ROLE_STORAGE_TYPE_MAP: ReadonlyMap<string, string> = new Map([
  ['owner', 'IOwnable'],
  ['admin', 'IAdmin'],
  ['governance', 'IGovernance'],
]);

function hasRoleTypedStorage(
  index: EvidenceIndex,
  functionId: string,
  roleKind: string,
): boolean {
  const storageType = ROLE_STORAGE_TYPE_MAP.get(roleKind);
  if (!storageType) return false;

  const outgoing = index.graph.getRelationshipsFrom(functionId);
  for (const rel of outgoing) {
    if (rel.type !== 'WRITES' && rel.type !== 'READS') continue;
    const stateVar = index.stateVariablesById.get(rel.target_id);
    if (stateVar && stateVar.type === storageType) return true;
  }
  return false;
}

function classifyAuthorityKind(
  index: EvidenceIndex,
  functionId: string,
  modifiers: readonly string[],
): string {
  for (const roleKind of ROLE_TYPES) {
    const pins = ROLE_PIN_MAP.get(roleKind);
    if (!pins || pins.length === 0) continue;

    if (hasRoleTypedStorage(index, functionId, roleKind)) {
      return roleKind;
    }
  }
  return 'unknown';
}

function buildGateDescriptor(
  fn: { modifiers: readonly string[]; visibility: string; mutability: string },
) {
  return {
    modifiers: [...fn.modifiers].sort(compareCodeUnits),
    visibility: fn.visibility,
    mutability: fn.mutability,
  };
}

function findActorLink(
  index: EvidenceIndex,
  functionId: string,
): { actorId: string; evidenceClass: 'E2'; callRelId: string } | { evidenceClass: 'E3'; unknown: true } {
  const incomingCalls = index.graph.getRelationshipsTo(functionId);
  const resolvedCalls = incomingCalls.filter(
    (rel) => rel.type === 'CALLS' && index.functionsById.has(rel.source_id),
  );

  if (resolvedCalls.length > 0) {
    return { actorId: resolvedCalls[0]!.source_id, evidenceClass: 'E2' as const, callRelId: resolvedCalls[0]!.id };
  }
  return { evidenceClass: 'E3' as const, unknown: true };
}

function findStoredAuthoritySubject(
  index: EvidenceIndex,
  functionId: string,
): { subjectVarId: string; evidenceClass: 'E2' } | null {
  const outgoing = index.graph.getRelationshipsFrom(functionId);
  for (const rel of outgoing) {
    if (rel.type !== 'WRITES') continue;
    const stateVar = index.stateVariablesById.get(rel.target_id);
    if (stateVar && [...ROLE_STORAGE_TYPE_MAP.values()].includes(stateVar.type)) {
      return { subjectVarId: rel.target_id, evidenceClass: 'E2' as const };
    }
  }
  return null;
}

function findTransitionId(transitions: readonly StateTransition[], functionId: string): string | undefined {
  const transition = transitions.find((t) => t.function_id === functionId);
  if (!transition) return undefined;
  if (transition.fidelity_flags.includes('assembly_skipped')) return undefined;
  return transition.id;
}

function computeImpact(transition: StateTransition | undefined): string {
  if (!transition) return 'unknown';

  if (transition.asset_movements.length > 0) {
    const kinds = transition.asset_movements.map((m) => m.kind).sort();
    return kinds[0]!;
  }
  if (transition.external_effects.length > 0) {
    const kinds = transition.external_effects.map((e) => e.call_kind).sort();
    return kinds[0]!;
  }
  return 'unknown';
}

function hasGate(modifiers: readonly string[]): boolean {
  return modifiers.length > 0;
}

export function deriveAuthority(
  index: EvidenceIndex,
  transitions: readonly StateTransition[],
): AuthorityDerivation {
  const authority: AuthorityChain[] = [];
  const unknowns: UnknownIndexEntry[] = [];

  const functionIds = [...index.functionsById.keys()].sort(compareCodeUnits);

  for (const functionId of functionIds) {
    const fn = index.functionsById.get(functionId)!;
    const transition = transitions.find((t) => t.function_id === functionId);

    const chainId = semanticContentId('semau', {
      function_id: functionId,
      contract_id: fn.contract_id,
    });

    const gate = buildGateDescriptor(fn);
    const authorityKind = classifyAuthorityKind(index, functionId, fn.modifiers);

    const actorLink = findActorLink(index, functionId);
    const subjectLink = findStoredAuthoritySubject(index, functionId);
    const transitionId = findTransitionId(transitions, functionId);
    const impact = computeImpact(transition);

    const perLink: AuthorityChain['per_link'] = [];
    const basisSet = new Set<string>([functionId]);
    if (transition) {
      for (const b of transition.basis) basisSet.add(b);
    }

    if ('actorId' in actorLink) {
      perLink.push({
        link_kind: 'actor',
        evidence_class: actorLink.evidenceClass,
        basis: [...basisSet, actorLink.callRelId, actorLink.actorId].sort(compareCodeUnits),
      });
    } else {
      perLink.push({
        link_kind: 'actor',
        evidence_class: 'E3',
        basis: [...basisSet].sort(compareCodeUnits),
        unknown: true,
      });
    }

    if (subjectLink) {
      perLink.push({
        link_kind: 'stored-authority-subject',
        evidence_class: subjectLink.evidenceClass,
        basis: [...basisSet, subjectLink.subjectVarId].sort(compareCodeUnits),
      });
    }

    if (authorityKind !== 'unknown') {
      perLink.push({
        link_kind: 'authority-kind',
        evidence_class: 'E2',
        basis: [...basisSet].sort(compareCodeUnits),
      });
    } else if (fn.modifiers.length > 0) {
      for (const modifier of fn.modifiers) {
        perLink.push({
          link_kind: 'gate-observation',
          evidence_class: 'E1',
          basis: [...basisSet, `modifier ${modifier} gates ${fn.name}`].sort(compareCodeUnits),
        });
        break;
      }
    }

    if (!hasGate(fn.modifiers)) {
      perLink.push({
        link_kind: 'gate-observation',
        evidence_class: 'E1',
        basis: [...basisSet, `no gate observed on ${fn.name}`].sort(compareCodeUnits),
      });
    }

    const status: 'complete' | 'partial' = actorLink.evidenceClass === 'E3' ? 'partial' : 'complete';

    const chain = AuthorityChainSchema.parse({
      id: chainId,
      links: {
        actor: actorLink.evidenceClass === 'E2' ? actorLink.actorId : 'unknown',
        authority: authorityKind,
        function_id: functionId,
        ...(transitionId !== undefined ? { transition_id: transitionId } : {}),
        impact,
      },
      authority_kind: authorityKind,
      gate,
      per_link: perLink,
      status,
    });

    authority.push(chain);

    if (actorLink.evidenceClass === 'E3') {
      unknowns.push(
        UnknownIndexEntrySchema.parse({
          record_ref: chainId,
          field: 'actor',
          reason: 'no_evidence',
          basis: [...basisSet].sort(compareCodeUnits),
        }),
      );
    }

    if (!transition) {
      unknowns.push(
        UnknownIndexEntrySchema.parse({
          record_ref: chainId,
          field: 'transition_id',
          reason: 'no_evidence',
          basis: [...basisSet].sort(compareCodeUnits),
        }),
      );
    } else if (transition.fidelity_flags.includes('assembly_skipped')) {
      unknowns.push(
        UnknownIndexEntrySchema.parse({
          record_ref: chainId,
          field: 'transition_id',
          reason: 'unsupported_assembly',
          basis: [...basisSet].sort(compareCodeUnits),
        }),
      );
    }
  }

  authority.sort((a, b) => compareCodeUnits(a.id, b.id));
  unknowns.sort((a, b) =>
    compareCodeUnits(a.record_ref, b.record_ref) ||
    compareCodeUnits(a.field, b.field) ||
    compareCodeUnits(a.reason, b.reason) ||
    compareCodeUnits(a.basis.join(','), b.basis.join(',')),
  );

  return { authority, unknowns };
}