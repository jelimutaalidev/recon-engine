import { compareCodeUnits } from '../util/canonical.js';
import type { EvidenceIndex } from './evidence.js';
import { semanticContentId } from './ids.js';
import {
  SemanticObservationSchema,
  SemanticAssumptionSchema,
  SemanticHypothesisSchema,
  CandidateInvariantSchema,
  UnknownIndexEntrySchema,
  type SemanticObservation,
  type SemanticAssumption,
  type SemanticHypothesis,
  type CandidateInvariant,
  type UnknownIndexEntry,
  type StateTransition,
  type AssetRecord,
  type CustodyRecord,
  type ClaimRecord,
  type AccountingRelation,
  type AuthorityChain,
  type ExternalDependency,
  type TrustCapability,
} from './model.js';
import type { Provenance } from '../epistemic/provenance.js';
import { resolveProvenanceCopy } from './evidence.js';

export interface LadderLayers {
  transitions: readonly StateTransition[];
  assets: readonly AssetRecord[];
  custody: readonly CustodyRecord[];
  claims: readonly ClaimRecord[];
  accounting: readonly AccountingRelation[];
  authority: readonly AuthorityChain[];
  trust: {
    dependencies: readonly ExternalDependency[];
    capabilities: readonly TrustCapability[];
  };
}

export interface LadderDerivation {
  observations: SemanticObservation[];
  assumptions: SemanticAssumption[];
  invariants: CandidateInvariant[];
  hypotheses: SemanticHypothesis[];
  unknowns: UnknownIndexEntry[];
}

type UnknownReason = UnknownIndexEntry['reason'];

interface ObservationDraft {
  statement: string;
  basedOn: string[];
  provenance: Provenance[];
}

interface AssumptionDraft {
  statement: string;
  basedOn: string[];
}

interface InvariantDraft {
  statement: string;
  invariantClass: CandidateInvariant['invariant_class'];
  basedOn: string[];
  affectedEntities: string[];
  status: CandidateInvariant['status'];
  notes?: string;
}

interface HypothesisDraft {
  statement: string;
  basedOn: string[];
  affectedEntities: string[];
  requiredConditions: string[];
  status: SemanticHypothesis['status'];
}

interface UnknownDraft {
  recordRef: string;
  field: string;
  reason: UnknownReason;
  basis: Set<string>;
}

function sortUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareCodeUnits);
}

function compareBasis(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const result = compareCodeUnits(a[index] as string, b[index] as string);
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

function collectProvenanceFromBasis(index: EvidenceIndex, basis: readonly string[]): Provenance[] {
  const provenanceMap = new Map<string, Provenance>();
  for (const basisId of basis) {
    if (basisId.startsWith('fact:')) {
      const fact = index.factsById.get(basisId);
      if (fact) {
        for (const prov of fact.provenance) {
          provenanceMap.set(prov.id, prov);
        }
      }
    }
    const rel = index.relationshipsById.get(basisId);
    if (rel) {
      for (const prov of rel.provenance) {
        provenanceMap.set(prov.id, prov);
      }
    }
  }
  return [...provenanceMap.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
}

function extractStateFactsFromTransitions(index: EvidenceIndex, transitions: readonly StateTransition[]): Map<string, Set<string>> {
  const factsByTransition = new Map<string, Set<string>>();
  for (const transition of transitions) {
    const factIds = new Set<string>();
    for (const basisId of transition.basis) {
      if (basisId.startsWith('fact:')) {
        factIds.add(basisId);
      }
    }
    if (factIds.size > 0) {
      factsByTransition.set(transition.id, factIds);
    }
  }
  return factsByTransition;
}

function extractStateFactsFromAssets(index: EvidenceIndex, assets: readonly AssetRecord[]): Map<string, Set<string>> {
  const factsByAsset = new Map<string, Set<string>>();
  for (const asset of assets) {
    const factIds = new Set<string>();
    for (const basisId of asset.basis) {
      if (basisId.startsWith('fact:')) {
        factIds.add(basisId);
      }
    }
    if (factIds.size > 0) {
      factsByAsset.set(asset.id, factIds);
    }
  }
  return factsByAsset;
}

function extractStateFactsFromAccounting(index: EvidenceIndex, accounting: readonly AccountingRelation[]): Map<string, Set<string>> {
  const factsByAccounting = new Map<string, Set<string>>();
  for (const relation of accounting) {
    const factIds = new Set<string>();
    for (const basisId of relation.basis) {
      if (basisId.startsWith('fact:')) {
        factIds.add(basisId);
      }
    }
    if (factIds.size > 0) {
      factsByAccounting.set(relation.id, factIds);
    }
  }
  return factsByAccounting;
}

function extractStateFactsFromAuthority(index: EvidenceIndex, authority: readonly AuthorityChain[]): Map<string, Set<string>> {
  const factsByAuthority = new Map<string, Set<string>>();
  for (const chain of authority) {
    const factIds = new Set<string>();
    for (const link of chain.per_link) {
      for (const basisId of link.basis) {
        if (basisId.startsWith('fact:')) {
          factIds.add(basisId);
        }
      }
    }
    if (factIds.size > 0) {
      factsByAuthority.set(chain.id, factIds);
    }
  }
  return factsByAuthority;
}

function extractStateFactsFromTrust(index: EvidenceIndex, capabilities: readonly TrustCapability[]): Map<string, Set<string>> {
  const factsByTrust = new Map<string, Set<string>>();
  for (const cap of capabilities) {
    const factIds = new Set<string>();
    for (const basisId of cap.basis) {
      if (basisId.startsWith('fact:')) {
        factIds.add(basisId);
      }
    }
    if (factIds.size > 0) {
      factsByTrust.set(cap.id, factIds);
    }
  }
  return factsByTrust;
}

function buildObservations(
  index: EvidenceIndex,
  layers: LadderLayers,
): { observations: SemanticObservation[]; unknowns: UnknownIndexEntry[] } {
  const observations: SemanticObservation[] = [];
  const unknownDrafts: UnknownDraft[] = [];

  const transitionFacts = extractStateFactsFromTransitions(index, layers.transitions);
  const assetFacts = extractStateFactsFromAssets(index, layers.assets);
  const accountingFacts = extractStateFactsFromAccounting(index, layers.accounting);
  const authorityFacts = extractStateFactsFromAuthority(index, layers.authority);
  const trustFacts = extractStateFactsFromTrust(index, layers.trust.capabilities);

  const allSources = new Map<string, Set<string>>();
  for (const [id, facts] of transitionFacts) allSources.set(`transition:${id}`, facts);
  for (const [id, facts] of assetFacts) allSources.set(`asset:${id}`, facts);
  for (const [id, facts] of accountingFacts) allSources.set(`accounting:${id}`, facts);
  for (const [id, facts] of authorityFacts) allSources.set(`authority:${id}`, facts);
  for (const [id, facts] of trustFacts) allSources.set(`trust:${id}`, facts);

  for (const [sourceKey, factIds] of allSources) {
    const sortedFacts = sortUnique(factIds);
    const provenance = collectProvenanceFromBasis(index, sortedFacts);

    let statement: string;
    if (sourceKey.startsWith('transition:')) {
      const transId = sourceKey.slice('transition:'.length);
      const transition = layers.transitions.find((t) => t.id === transId);
      if (transition) {
        const fn = index.functionsById.get(transition.function_id);
        statement = `Function ${fn?.name ?? transition.function_id} reads ${transition.pre_state_reads.length} state variables and writes ${transition.writes.length} state variables`;
      } else {
        statement = `State transition ${transId} observed`;
      }
    } else if (sourceKey.startsWith('asset:')) {
      const assetId = sourceKey.slice('asset:'.length);
      const asset = layers.assets.find((a) => a.id === assetId);
      if (asset) {
        statement = `Asset ${asset.name} (${asset.asset_type}) identified in contract`;
      } else {
        statement = `Asset ${assetId} observed`;
      }
    } else if (sourceKey.startsWith('accounting:')) {
      const accId = sourceKey.slice('accounting:'.length);
      const relation = layers.accounting.find((r) => r.id === accId);
      if (relation) {
        statement = `Accounting relation ${relation.relation_kind} between ${relation.endpoints.join(' and ')}`;
      } else {
        statement = `Accounting relation ${accId} observed`;
      }
    } else if (sourceKey.startsWith('authority:')) {
      const authId = sourceKey.slice('authority:'.length);
      const chain = layers.authority.find((c) => c.id === authId);
      if (chain) {
        statement = `Authority chain for ${chain.links.function_id} with ${chain.authority_kind} authority`;
      } else {
        statement = `Authority chain ${authId} observed`;
      }
    } else if (sourceKey.startsWith('trust:')) {
      const capId = sourceKey.slice('trust:'.length);
      const cap = layers.trust.capabilities.find((c) => c.id === capId);
      if (cap) {
        statement = `Trust capability ${cap.direction} on ${cap.dependency_ref} with ${cap.capabilities.join(', ')}`;
      } else {
        statement = `Trust capability ${capId} observed`;
      }
    } else {
      statement = `Observation from ${sourceKey}`;
    }

    const obsBasis = provenance.length > 0 ? provenance.map((p) => p.id) : sortedFacts;
    const obsId = semanticContentId('semobs', { statement, based_on: obsBasis });

    let finalProvenance: Provenance[] = [];
    if (provenance.length > 0) {
      const allValid = provenance.every((p) => resolveProvenanceCopy(index, p));
      if (allValid) {
        finalProvenance = provenance;
      } else {
        unknownDrafts.push({
          recordRef: obsId,
          field: 'provenance',
          reason: 'no_evidence',
          basis: new Set(sortedFacts),
        });
        continue;
      }
    } else if (sortedFacts.length > 0) {
      finalProvenance = [];
    } else {
      unknownDrafts.push({
        recordRef: obsId,
        field: 'based_on',
        reason: 'no_evidence',
        basis: new Set(),
      });
      continue;
    }

    const observation = SemanticObservationSchema.parse({
      id: obsId,
      type: 'OBSERVATION',
      statement,
      based_on: sortedFacts,
      provenance: finalProvenance,
      confidence: { level: 'DERIVED' },
    });
    observations.push(observation);
  }

  const materialized: UnknownIndexEntry[] = unknownDrafts
    .map((draft): UnknownIndexEntry => {
      const basis = sortUnique(draft.basis);
      return UnknownIndexEntrySchema.parse({
        record_ref: draft.recordRef,
        field: draft.field,
        reason: draft.reason,
        basis,
      });
    })
    .sort(compareUnknowns);

  observations.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { observations, unknowns: materialized };
}

function buildAssumptions(
  observations: readonly SemanticObservation[],
  layers: LadderLayers,
): { assumptions: SemanticAssumption[]; unknowns: UnknownIndexEntry[] } {
  const assumptions: SemanticAssumption[] = [];
  const unknownDrafts: UnknownDraft[] = [];

  for (const obs of observations) {
    const statement = `Security assumption: the behavior observed in ${obs.id} holds under operational conditions`;
    const asmId = semanticContentId('semasm', { statement, based_on: [obs.id] });

    const assumption = SemanticAssumptionSchema.parse({
      id: asmId,
      type: 'ASSUMPTION',
      statement,
      based_on: [obs.id],
      confidence: { level: 'INFERRED' },
      status: 'OPEN',
    });
    assumptions.push(assumption);
  }

  for (const cap of layers.trust.capabilities) {
    if (cap.trust_assumption_ref) {
      const trustAsm = SemanticAssumptionSchema.parse({
        id: cap.trust_assumption_ref,
        type: 'ASSUMPTION',
        statement: `Trust assumption for ${cap.direction} capability on ${cap.dependency_ref}: the external dependency behaves as expected for ${cap.capabilities.join(', ')}`,
        based_on: [],
        confidence: { level: 'INFERRED' },
        status: 'OPEN',
      });
      assumptions.push(trustAsm);
    }
  }

  const materialized: UnknownIndexEntry[] = unknownDrafts
    .map((draft): UnknownIndexEntry => {
      const basis = sortUnique(draft.basis);
      return UnknownIndexEntrySchema.parse({
        record_ref: draft.recordRef,
        field: draft.field,
        reason: draft.reason,
        basis,
      });
    })
    .sort(compareUnknowns);

  assumptions.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { assumptions, unknowns: materialized };
}

function buildInvariants(
  observations: readonly SemanticObservation[],
  assumptions: readonly SemanticAssumption[],
  layers: LadderLayers,
): { invariants: CandidateInvariant[]; unknowns: UnknownIndexEntry[] } {
  const invariants: CandidateInvariant[] = [];
  const unknownDrafts: UnknownDraft[] = [];

  const emittedObsIds = new Set(observations.map((o) => o.id));
  const emittedAsmIds = new Set(assumptions.map((a) => a.id));

  for (const relation of layers.accounting) {
    if (relation.relation_kind === 'assets_shares') {
      const statement = 'totalShares never exceeds accounted underlying';
      const basedOn = sortUnique([
        ...relation.endpoints.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'accounting', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'accounting',
          based_on: basedOn,
          affected_entities: sortUnique(relation.basis.filter((id) => id.startsWith('contract:') || id.startsWith('state:'))),
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    } else if (relation.relation_kind === 'debt_collateral') {
      const statement = 'totalDebt never exceeds collateral value';
      const basedOn = sortUnique([
        ...relation.endpoints.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'custody', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'custody',
          based_on: basedOn,
          affected_entities: sortUnique(relation.basis.filter((id) => id.startsWith('contract:') || id.startsWith('state:'))),
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    } else if (relation.relation_kind === 'reserves_liquidity') {
      const statement = 'reserves always back outstanding LP tokens';
      const basedOn = sortUnique([
        ...relation.endpoints.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'accounting', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'accounting',
          based_on: basedOn,
          affected_entities: sortUnique(relation.basis.filter((id) => id.startsWith('contract:') || id.startsWith('state:'))),
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    } else if (relation.relation_kind === 'rewards_eligible_stake') {
      const statement = 'rewards distributed proportionally to eligible stake';
      const basedOn = sortUnique([
        ...relation.endpoints.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'accounting', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'accounting',
          based_on: basedOn,
          affected_entities: sortUnique(relation.basis.filter((id) => id.startsWith('contract:') || id.startsWith('state:'))),
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    } else if (relation.relation_kind === 'fees_protocol_user') {
      const statement = 'fee split allocations sum to total collected fees';
      const basedOn = sortUnique([
        ...relation.endpoints.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'accounting', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'accounting',
          based_on: basedOn,
          affected_entities: sortUnique(relation.basis.filter((id) => id.startsWith('contract:') || id.startsWith('state:'))),
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    }
  }

  for (const chain of layers.authority) {
    if (chain.status === 'partial') {
      const statement = `function ${chain.links.function_id} has incomplete authority chain`;
      const basedOn = sortUnique([
        ...chain.per_link
          .flatMap((l) => l.basis)
          .filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'auth', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'auth',
          based_on: basedOn,
          affected_entities: [chain.links.function_id],
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    }
  }

  for (const cap of layers.trust.capabilities) {
    if (cap.failure_semantics === 'unknown') {
      const statement = `external dependency ${cap.dependency_ref} failure semantics are not observable`;
      const basedOn = sortUnique([
        ...cap.basis.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
      ]);
      if (basedOn.length > 0) {
        const invId = semanticContentId('seminv', { statement, invariant_class: 'external_trust', based_on: basedOn });
        const invariant = CandidateInvariantSchema.parse({
          id: invId,
          statement,
          invariant_class: 'external_trust',
          based_on: basedOn,
          affected_entities: [cap.dependency_ref],
          status: 'OPEN',
        });
        invariants.push(invariant);
      }
    }
  }

  const materialized: UnknownIndexEntry[] = unknownDrafts
    .map((draft): UnknownIndexEntry => {
      const basis = sortUnique(draft.basis);
      return UnknownIndexEntrySchema.parse({
        record_ref: draft.recordRef,
        field: draft.field,
        reason: draft.reason,
        basis,
      });
    })
    .sort(compareUnknowns);

  invariants.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { invariants, unknowns: materialized };
}

function buildHypotheses(
  observations: readonly SemanticObservation[],
  assumptions: readonly SemanticAssumption[],
  invariants: readonly CandidateInvariant[],
): { hypotheses: SemanticHypothesis[]; unknowns: UnknownIndexEntry[] } {
  const hypotheses: SemanticHypothesis[] = [];
  const unknownDrafts: UnknownDraft[] = [];

  const emittedObsIds = new Set(observations.map((o) => o.id));
  const emittedAsmIds = new Set(assumptions.map((a) => a.id));

  for (const inv of invariants) {
    const statement = `if ${inv.statement.toLowerCase()} can be violated, the related security property fails`;
    const basedOn = sortUnique([
      inv.id,
      ...inv.based_on.filter((id) => emittedObsIds.has(id) || emittedAsmIds.has(id)),
    ]);
    if (basedOn.length > 0) {
      const hypId = semanticContentId('semhyp', {
        statement,
        based_on: basedOn,
        affected_entities: inv.affected_entities,
      });
      const hypothesis = SemanticHypothesisSchema.parse({
        id: hypId,
        type: 'HYPOTHESIS',
        statement,
        based_on: basedOn,
        affected_entities: inv.affected_entities,
        required_conditions: [`verify ${inv.invariant_class} invariant`],
        status: 'OPEN',
        confidence: { level: 'SPECULATIVE' },
      });
      hypotheses.push(hypothesis);
    }
  }

  const materialized: UnknownIndexEntry[] = unknownDrafts
    .map((draft): UnknownIndexEntry => {
      const basis = sortUnique(draft.basis);
      return UnknownIndexEntrySchema.parse({
        record_ref: draft.recordRef,
        field: draft.field,
        reason: draft.reason,
        basis,
      });
    })
    .sort(compareUnknowns);

  hypotheses.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { hypotheses, unknowns: materialized };
}

export function deriveLadder(
  index: EvidenceIndex,
  layers: LadderLayers,
): LadderDerivation {
  const { observations, unknowns: obsUnknowns } = buildObservations(index, layers);
  const { assumptions, unknowns: asmUnknowns } = buildAssumptions(observations, layers);
  const { invariants, unknowns: invUnknowns } = buildInvariants(observations, assumptions, layers);
  const { hypotheses, unknowns: hypUnknowns } = buildHypotheses(observations, assumptions, invariants);

  const allUnknowns = [...obsUnknowns, ...asmUnknowns, ...invUnknowns, ...hypUnknowns].sort(compareUnknowns);

  return {
    observations,
    assumptions,
    invariants,
    hypotheses,
    unknowns: allUnknowns,
  };
}