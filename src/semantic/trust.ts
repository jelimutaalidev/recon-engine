import { compareCodeUnits } from '../util/canonical.js';
import type { EvidenceIndex } from './evidence.js';
import type { StateTransition } from './model.js';
import {
  ExternalDependencySchema,
  TrustCapabilitySchema,
  SemanticAssumptionSchema,
  SemanticObservationSchema,
  UnknownIndexEntrySchema,
  type ExternalDependency,
  type TrustCapability,
  type SemanticAssumption,
  type SemanticObservation,
  type UnknownIndexEntry,
  type EvidenceClass,
} from './model.js';
import { semanticContentId } from './ids.js';
import { ORACLE_PINS, DEX_PINS } from './pins.js';
import { DEPENDENCY_TYPES } from '../domain/enums.js';
import type { Provenance } from '../epistemic/provenance.js';

export interface TrustDerivation {
  dependencies: ExternalDependency[];
  capabilities: TrustCapability[];
  assumptions: SemanticAssumption[];
  observations: SemanticObservation[];
  unknowns: UnknownIndexEntry[];
}

type DependencyType = (typeof DEPENDENCY_TYPES)[number];
type UnknownReason = UnknownIndexEntry['reason'];

const ALL_PINS: Readonly<Record<string, readonly string[]>> = {
  oracle: ORACLE_PINS,
  dex: DEX_PINS,
} as const;

interface DependencyDraft {
  name: string;
  dependencyType: DependencyType;
  address?: string;
  chainId?: string;
  interfaceName?: string;
  basis: Set<string>;
  callSignatures: Set<string>;
}

interface CapabilityDraft {
  dependencyRef: string;
  direction: 'observed' | 'consumed' | 'unknown';
  capabilities: Set<string>;
  basis: Set<string>;
  transitionIds: Set<string>;
}

interface AssumptionDraft {
  statement: string;
  basedOn: Set<string>;
  capabilityRef: string;
}

interface UnknownDraft {
  recordRef: string;
  field: string;
  reason: UnknownReason;
  basis: Set<string>;
}

function isOutOfScopeContract(index: EvidenceIndex, contractId: string): boolean {
  return !index.contractsById.has(contractId);
}

function getContractName(index: EvidenceIndex, contractId: string): string {
  const contract = index.contractsById.get(contractId);
  return contract?.name ?? contractId;
}

function getFunctionSignature(index: EvidenceIndex, functionId: string): string | undefined {
  const fn = index.functionsById.get(functionId);
  return fn?.signature;
}

function getImplementedInterfaces(index: EvidenceIndex, contractId: string): Set<string> {
  const interfaces = new Set<string>();
  const outgoing = index.graph.getRelationshipsFrom(contractId);
  for (const rel of outgoing) {
    if (rel.type === 'IMPLEMENTS') {
      const targetContract = index.contractsById.get(rel.target_id);
      if (targetContract) {
        interfaces.add(targetContract.name);
      }
    }
  }
  return interfaces;
}

function classifyDependencyType(callSignatures: Set<string>, implementedInterfaces: Set<string>): DependencyType {
  for (const [depType, pins] of Object.entries(ALL_PINS)) {
    for (const pin of pins) {
      if (callSignatures.has(pin)) {
        return depType as DependencyType;
      }
    }
  }
  return 'unknown';
}

export function deriveTrust(
  index: EvidenceIndex,
  transitions: StateTransition[],
): {
  dependencies: ExternalDependency[];
  capabilities: TrustCapability[];
  assumptions: SemanticAssumption[];
  observations: SemanticObservation[];
  unknowns: UnknownIndexEntry[];
} {
  const dependencyDrafts = new Map<string, DependencyDraft>();
  const capabilityDrafts = new Map<string, CapabilityDraft>();
  const assumptionDrafts: AssumptionDraft[] = [];
  const unknownDrafts: UnknownDraft[] = [];

  const transitionMap = new Map(transitions.map((t) => [t.id, t]));

  for (const transition of transitions) {
    const fn = index.functionsById.get(transition.function_id);
    if (!fn) continue;

    for (const effect of transition.external_effects) {
      const callKind = effect.call_kind;
      const basis = [...effect.basis];

      let targetRef = effect.target_ref;
      let targetIsFunction = false;
      let targetIsStateVar = false;

      if (targetRef) {
        targetIsFunction = index.functionsById.has(targetRef);
        targetIsStateVar = index.stateVariablesById.has(targetRef);
      } else {
        for (const basisId of basis) {
          const rel = index.relationshipsById.get(basisId);
          if (rel && rel.type === 'CALLS') {
            if (index.functionsById.has(rel.target_id)) {
              targetRef = rel.target_id;
              targetIsFunction = true;
              break;
            } else if (index.stateVariablesById.has(rel.target_id)) {
              targetRef = rel.target_id;
              targetIsStateVar = true;
              break;
            }
          }
        }
      }

      if (targetRef && targetIsFunction) {
        const targetFn = index.functionsById.get(targetRef)!;
        const targetContract = index.contractsById.get(targetFn.contract_id);
        if (targetContract) {
          const depName = targetContract.name;
          const contractId = targetContract.id;
          const isOutOfScope = isOutOfScopeContract(index, contractId);
          const depKey = `external:${depName}`;

          let draft = dependencyDrafts.get(depKey);
          if (!draft) {
            const implementedInterfaces = getImplementedInterfaces(index, contractId);
            const callSignatures = new Set<string>();
            callSignatures.add(targetFn.signature);

            const dependencyType = classifyDependencyType(callSignatures, implementedInterfaces);

            draft = {
              name: depName,
              dependencyType,
              basis: new Set(basis),
              callSignatures,
              interfaceName: implementedInterfaces.size > 0 ? [...implementedInterfaces][0] : undefined,
            };
            dependencyDrafts.set(depKey, draft);
          } else {
            for (const b of basis) draft.basis.add(b);
            draft.callSignatures.add(targetFn.signature);
          }

          const capKey = `${depKey}:observed`;
          let capDraft = capabilityDrafts.get(capKey);
          if (!capDraft) {
            capDraft = {
              dependencyRef: '',
              direction: 'observed',
              capabilities: new Set([targetFn.signature]),
              basis: new Set(basis),
              transitionIds: new Set([transition.id]),
            };
            capabilityDrafts.set(capKey, capDraft);
          } else {
            capDraft.capabilities.add(targetFn.signature);
            for (const b of basis) capDraft.basis.add(b);
            capDraft.transitionIds.add(transition.id);
          }
        } else {
          unknownDrafts.push({
            recordRef: transition.id,
            field: 'external_effects',
            reason: 'out_of_scope_target',
            basis: new Set(basis),
          });
        }
      } else if (targetRef && targetIsStateVar) {
        const targetStateVar = index.stateVariablesById.get(targetRef)!;
        const depName = targetStateVar.name;
        const depKey = `statevar:${depName}`;
        let draft = dependencyDrafts.get(depKey);
        if (!draft) {
          draft = {
            name: depName,
            dependencyType: 'unknown',
            basis: new Set(basis),
            callSignatures: new Set(),
          };
          dependencyDrafts.set(depKey, draft);
        } else {
          for (const b of basis) draft.basis.add(b);
        }

        const capKey = `${depKey}:observed`;
        let capDraft = capabilityDrafts.get(capKey);
        if (!capDraft) {
          capDraft = {
            dependencyRef: '',
            direction: 'observed',
            capabilities: new Set([`statevar:${depName}`]),
            basis: new Set(basis),
            transitionIds: new Set([transition.id]),
          };
          capabilityDrafts.set(capKey, capDraft);
        } else {
          for (const b of basis) capDraft.basis.add(b);
          capDraft.transitionIds.add(transition.id);
        }
      } else {
        unknownDrafts.push({
          recordRef: transition.id,
          field: 'external_effects',
          reason: 'out_of_scope_target',
          basis: new Set(basis),
        });
      }
    }
  }

  for (const fn of index.functionsById.values()) {
    if (fn.visibility !== 'public' && fn.visibility !== 'external') continue;

    const hasAddressParam = fn.parameters.some((p) => p.type === 'address');
    const hasCalldataParam = fn.parameters.some((p) => p.type.includes('calldata') || p.type.includes('bytes'));
    if (!hasAddressParam && !hasCalldataParam) continue;

    const hookInterfaces = new Set<string>();
    for (const contract of index.contractsById.values()) {
      if (contract.contract_type === 'interface') {
        const incoming = index.graph.getRelationshipsTo(contract.id);
        for (const rel of incoming) {
          if (rel.type === 'IMPLEMENTS') {
            const implContract = index.contractsById.get(rel.source_id);
            if (implContract && implContract.id !== fn.contract_id) {
              hookInterfaces.add(contract.name);
            }
          }
        }
      }
    }

    const direction = hookInterfaces.size > 0 ? 'consumed' : 'unknown';
    const depKey = `callback:${fn.contract_id}:${fn.name}`;
    const capKey = `${depKey}:${direction}`;

    let depDraft = dependencyDrafts.get(depKey);
    if (!depDraft) {
      depDraft = {
        name: `callback:${fn.name}`,
        dependencyType: 'unknown',
        basis: new Set([fn.id]),
        callSignatures: new Set([fn.signature]),
      };
      dependencyDrafts.set(depKey, depDraft);
    } else {
      depDraft.basis.add(fn.id);
      depDraft.callSignatures.add(fn.signature);
    }

    const fnTransition = transitions.find((t) => t.function_id === fn.id);
    const transitionIds: Set<string> = fnTransition ? new Set([fnTransition.id]) : new Set();

    let capDraft = capabilityDrafts.get(capKey);
    if (!capDraft) {
      capDraft = {
        dependencyRef: '',
        direction,
        capabilities: new Set([fn.signature]),
        basis: new Set([fn.id]),
        transitionIds,
      };
      capabilityDrafts.set(capKey, capDraft);
    } else {
      capDraft.capabilities.add(fn.signature);
      capDraft.basis.add(fn.id);
      for (const tid of transitionIds) capDraft.transitionIds.add(tid);
    }

    if (direction === 'unknown') {
      unknownDrafts.push({
        recordRef: fn.id,
        field: 'direction',
        reason: 'no_evidence',
        basis: new Set([fn.id]),
      });
    }
  }

  const dependencies: ExternalDependency[] = [];
  const dependencyIdMap = new Map<string, string>();

  for (const [depKey, draft] of dependencyDrafts.entries()) {
    const depId = semanticContentId('semdep', {
      name: draft.name,
      dependency_type: draft.dependencyType,
    });
    dependencyIdMap.set(depKey, depId);

    const dependency = ExternalDependencySchema.parse({
      id: depId,
      name: draft.name,
      dependency_type: draft.dependencyType,
      interface: draft.interfaceName,
      basis: [...draft.basis].sort(compareCodeUnits),
    });
    dependencies.push(dependency);
  }

  for (const [capKey, draft] of capabilityDrafts.entries()) {
    const depKey = capKey.split(':').slice(0, -1).join(':');
    const dependencyRef = dependencyIdMap.get(depKey);
    if (dependencyRef) {
      draft.dependencyRef = dependencyRef;
    }
  }

  const observations: SemanticObservation[] = [];
  const observationIdMap = new Map<string, string>();

  for (const [capKey, draft] of capabilityDrafts.entries()) {
    if (!draft.dependencyRef) continue;

    const obsBasis = new Set<string>();
    const obsProvenance: Provenance[] = [];
    for (const transitionId of draft.transitionIds) {
      const transition = transitionMap.get(transitionId);
      if (transition) {
        for (const basisId of transition.basis) {
          if (basisId.startsWith('fact:')) {
            obsBasis.add(basisId);
          }
          const rel = index.relationshipsById.get(basisId);
          if (rel) {
            for (const prov of rel.provenance) {
              obsProvenance.push(prov);
            }
          }
          const fact = index.factsById.get(basisId);
          if (fact) {
            for (const prov of fact.provenance) {
              obsProvenance.push(prov);
            }
          }
        }
      }
    }
    for (const basisId of draft.basis) {
      if (basisId.startsWith('fact:')) {
        obsBasis.add(basisId);
      }
      const rel = index.relationshipsById.get(basisId);
      if (rel) {
        for (const prov of rel.provenance) {
          obsProvenance.push(prov);
        }
      }
      const fact = index.factsById.get(basisId);
      if (fact) {
        for (const prov of fact.provenance) {
          obsProvenance.push(prov);
        }
      }
    }

    const obsBasisSorted = [...obsBasis].sort(compareCodeUnits);
    const statement = `Observed ${draft.direction} capability on ${draft.dependencyRef} via ${[...draft.capabilities].join(', ')}`;
    const obsId = semanticContentId('semobs', {
      statement,
      based_on: obsBasisSorted,
    });
    observationIdMap.set(capKey, obsId);

    const provenanceRefs = obsBasisSorted;
    const uniqueProvenance = Array.from(new Map(obsProvenance.map((p) => [p.id, p])).values());

    // If no fact-based provenance, create minimal provenance from function source spans
    let finalProvenance = uniqueProvenance;
    if (finalProvenance.length === 0 && provenanceRefs.length === 0) {
      for (const transitionId of draft.transitionIds) {
        const transition = transitionMap.get(transitionId);
        if (transition) {
          const fn = index.functionsById.get(transition.function_id);
          if (fn && fn.source) {
            const parsed = fn.source.match(/^(.+):(\d+)-(\d+)$/);
            if (parsed && parsed[1] && parsed[2] && parsed[3]) {
              finalProvenance.push({
                id: `prov:${semanticContentId('semobs', { source: fn.source })}`,
                source_type: 'source_code',
                file: parsed[1],
                line_start: parseInt(parsed[2], 10),
                line_end: parseInt(parsed[3], 10),
              } as Provenance);
            }
          }
        }
      }
      // Also check capability basis for function IDs with source
      for (const basisId of draft.basis) {
        if (basisId.startsWith('function:')) {
          const fn = index.functionsById.get(basisId);
          if (fn && fn.source) {
            const parsed = fn.source.match(/^(.+):(\d+)-(\d+)$/);
            if (parsed && parsed[1] && parsed[2] && parsed[3]) {
              finalProvenance.push({
                id: `prov:${semanticContentId('semobs', { source: fn.source })}`,
                source_type: 'source_code',
                file: parsed[1],
                line_start: parseInt(parsed[2], 10),
                line_end: parseInt(parsed[3], 10),
              } as Provenance);
            }
          }
        }
      }
    }

    const observation = SemanticObservationSchema.parse({
      id: obsId,
      type: 'OBSERVATION',
      statement,
      based_on: provenanceRefs,
      provenance: finalProvenance,
      confidence: { level: 'DERIVED' },
    });
    observations.push(observation);
  }

  const capabilities: TrustCapability[] = [];
  const assumptions: SemanticAssumption[] = [];

  for (const [capKey, draft] of capabilityDrafts.entries()) {
    if (!draft.dependencyRef) continue;

    const capId = semanticContentId('semtc', {
      dependency_ref: draft.dependencyRef,
      direction: draft.direction,
      capabilities: [...draft.capabilities].sort(compareCodeUnits),
    });

    const obsId = observationIdMap.get(capKey);
    if (!obsId) continue;

    const statement = `Trust assumption for ${draft.direction} capability on ${draft.dependencyRef}: the external dependency behaves as expected for ${[...draft.capabilities].join(', ')}`;
    const asmId = semanticContentId('semasm', {
      statement,
      based_on: [obsId],
    });

    const assumption = SemanticAssumptionSchema.parse({
      id: asmId,
      type: 'ASSUMPTION',
      statement,
      based_on: [obsId],
      confidence: { level: 'INFERRED' },
      status: 'OPEN',
    });
    assumptions.push(assumption);

    const capability = TrustCapabilitySchema.parse({
      id: capId,
      dependency_ref: draft.dependencyRef,
      direction: draft.direction,
      capabilities: [...draft.capabilities].sort(compareCodeUnits),
      trust_assumption_ref: asmId,
      failure_semantics: 'unknown',
      basis: [...draft.basis].sort(compareCodeUnits),
    });
    capabilities.push(capability);
  }

  for (const cap of capabilities) {
    unknownDrafts.push({
      recordRef: cap.id,
      field: 'failure_semantics',
      reason: 'no_evidence',
      basis: new Set(cap.basis),
    });
  }

  const unknowns: UnknownIndexEntry[] = unknownDrafts
    .map((draft): UnknownIndexEntry => {
      const basis = [...draft.basis].sort(compareCodeUnits);
      return UnknownIndexEntrySchema.parse({
        record_ref: draft.recordRef,
        field: draft.field,
        reason: draft.reason,
        basis,
      });
    })
    .sort((a, b) =>
      compareCodeUnits(a.record_ref, b.record_ref) ||
      compareCodeUnits(a.field, b.field) ||
      compareCodeUnits(a.reason, b.reason) ||
      compareCodeUnits(a.basis.join(','), b.basis.join(','))
    );

  dependencies.sort((a, b) => compareCodeUnits(a.id, b.id));
  capabilities.sort((a, b) => compareCodeUnits(a.id, b.id));
  assumptions.sort((a, b) => compareCodeUnits(a.id, b.id));
  observations.sort((a, b) => compareCodeUnits(a.id, b.id));

  return { dependencies, capabilities, assumptions, observations, unknowns };
}