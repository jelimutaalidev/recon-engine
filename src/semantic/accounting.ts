import type { Contract } from '../domain/contract.js';
import type { SolidityFunction } from '../domain/function.js';
import type { StateVariable } from '../domain/state-variable.js';
import { compareCodeUnits } from '../util/canonical.js';
import type { EvidenceIndex } from './evidence.js';
import { semanticContentId } from './ids.js';
import {
  AccountingRelationSchema,
  type AccountingRelation,
  type AssetRecord,
  type UnknownIndexEntry,
} from './model.js';
import { FEE_PINS } from './pins.js';

export interface AccountingDerivation {
  accounting: AccountingRelation[];
  unknowns: UnknownIndexEntry[];
}

type RelationKind = AccountingRelation['relation_kind'];
type DerivationTag = AccountingRelation['derivation'];
type AssetType = AssetRecord['asset_type'];

interface Placement {
  asset: AssetRecord;
  stateVarIds: string[];
  holderContractId: string;
}

interface AbiClosure {
  contracts: Contract[];
  functions: SolidityFunction[];
  signatures: ReadonlySet<string>;
}

// Spec 8 pair table: the base half is a C-classified non-representation asset
// (native is never modeled — C6), the right half is the representation class.
const BASE_ASSET_TYPES: readonly AssetType[] = ['erc20', 'erc721', 'erc1155'];

const PAIR_RULES: readonly {
  relationKind: RelationKind;
  left: readonly AssetType[];
  right: readonly AssetType[];
}[] = [
  { relationKind: 'assets_shares', left: BASE_ASSET_TYPES, right: ['share'] },
  { relationKind: 'debt_collateral', left: ['debt'], right: ['collateral'] },
  { relationKind: 'reserves_liquidity', left: BASE_ASSET_TYPES, right: ['lp'] },
  { relationKind: 'rewards_eligible_stake', left: ['reward'], right: ['receipt'] },
];

function sortUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort(compareCodeUnits);
}

function functionsByContract(index: EvidenceIndex): Map<string, SolidityFunction[]> {
  const grouped = new Map<string, SolidityFunction[]>();
  for (const fn of index.functionsById.values()) {
    const bucket = grouped.get(fn.contract_id);
    if (bucket === undefined) grouped.set(fn.contract_id, [fn]);
    else bucket.push(fn);
  }
  return grouped;
}

// ABI closure (spec 8 "in-scope"): the contract plus every in-scope
// INHERITS/IMPLEMENTS base, transitively.
function abiClosure(
  index: EvidenceIndex,
  grouped: ReadonlyMap<string, readonly SolidityFunction[]>,
  rootId: string,
): AbiClosure {
  const contracts: Contract[] = [];
  const seen = new Set<string>();
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    if (seen.has(id)) continue;
    const contract = index.contractsById.get(id);
    if (contract === undefined) continue;
    seen.add(id);
    contracts.push(contract);
    for (const relationship of index.graph.getRelationshipsFrom(id)) {
      if (relationship.type === 'INHERITS' || relationship.type === 'IMPLEMENTS') {
        queue.push(relationship.target_id);
      }
    }
  }
  const functions: SolidityFunction[] = [];
  for (const contract of contracts) {
    for (const fn of grouped.get(contract.id) ?? []) functions.push(fn);
  }
  const signatures = new Set<string>(functions.map((fn) => fn.signature));
  return { contracts, functions, signatures };
}

// Spec 8 endpoints: only Task 5-classified (C-classified) asset records
// participate; 'unknown' never upgrades and native never exists.
function placementsOf(
  index: EvidenceIndex,
  assets: readonly AssetRecord[],
): Placement[] {
  const seen = new Set<string>();
  const placements: Placement[] = [];
  for (const asset of assets) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    if (asset.evidence_class !== 'E2') continue;
    if (asset.asset_type === 'unknown' || asset.asset_type === 'native') continue;
    const stateVarIds = asset.basis.filter((id) => index.stateVariablesById.has(id));
    if (stateVarIds.length === 0) continue;
    const firstVarId = stateVarIds[0];
    if (firstVarId === undefined) continue;
    const firstVar = index.stateVariablesById.get(firstVarId);
    if (firstVar === undefined) continue;
    placements.push({ asset, stateVarIds, holderContractId: firstVar.contract_id });
  }
  return placements;
}

export function deriveAccounting(
  index: EvidenceIndex,
  assets: { assets: AssetRecord[] },
): AccountingDerivation {
  const placements = placementsOf(index, assets.assets);

  const accessorsByStateVar = new Map<string, Set<string>>();
  const targetsByFunction = new Map<string, Set<string>>();
  for (const fn of index.functionsById.values()) {
    const targets = new Set<string>();
    for (const relationship of index.graph.getRelationshipsFrom(fn.id)) {
      if (relationship.type !== 'READS' && relationship.type !== 'WRITES') continue;
      targets.add(relationship.target_id);
      let accessors = accessorsByStateVar.get(relationship.target_id);
      if (accessors === undefined) {
        accessors = new Set<string>();
        accessorsByStateVar.set(relationship.target_id, accessors);
      }
      accessors.add(fn.id);
    }
    targetsByFunction.set(fn.id, targets);
  }

  const accessorsOf = (placement: Placement): Set<string> => {
    const accessors = new Set<string>();
    for (const stateVarId of placement.stateVarIds) {
      for (const fnId of accessorsByStateVar.get(stateVarId) ?? []) accessors.add(fnId);
    }
    return accessors;
  };

  const relations: AccountingRelation[] = [];
  const emit = (
    relationKind: RelationKind,
    derivation: DerivationTag,
    endpoints: string[],
    basis: string[],
  ): void => {
    relations.push(
      AccountingRelationSchema.parse({
        id: semanticContentId('semacc', { derivation, endpoints, relation_kind: relationKind }),
        relation_kind: relationKind,
        endpoints,
        derivation,
        evidence_class: 'E2',
        basis,
        epistemic: 'observation',
        unknowns: [],
      }),
    );
  };

  const byHolder = new Map<string, Placement[]>();
  for (const placement of placements) {
    const bucket = byHolder.get(placement.holderContractId);
    if (bucket === undefined) byHolder.set(placement.holderContractId, [placement]);
    else bucket.push(placement);
  }

  // Spec 8 pairs: co-held in one contract AND >=1 function whose READS/WRITE
  // set intersects both endpoints — co-occurrence alone never emits.
  for (const [holderContractId, held] of byHolder) {
    for (const rule of PAIR_RULES) {
      for (const left of held) {
        if (!rule.left.includes(left.asset.asset_type)) continue;
        const leftAccessors = accessorsOf(left);
        for (const right of held) {
          if (!rule.right.includes(right.asset.asset_type)) continue;
          const pairing = sortUnique(
            [...accessorsOf(right)].filter((fnId) => leftAccessors.has(fnId)),
          );
          if (pairing.length === 0) continue;
          emit(
            rule.relationKind,
            'paired-storage',
            sortUnique([left.asset.id, right.asset.id]),
            sortUnique([
              ...left.asset.basis,
              ...right.asset.basis,
              ...pairing,
              holderContractId,
            ]),
          );
        }
      }
    }
  }

  // Spec 8 fees row: pinned in-scope fee-interface surface (OD-8 FEE_PINS,
  // per-interface closure match — never bare signature) over C-classified
  // assets of the same contract, with >=2 split destinations written by the
  // pinned surface and co-accessed by >=1 function. No name-based detection.
  if (FEE_PINS.length > 0) {
    const feePinsSet = new Set<string>(FEE_PINS);
    const grouped = functionsByContract(index);
    const contracts = [...index.contractsById.values()].sort((a, b) =>
      compareCodeUnits(a.id, b.id),
    );
    for (const contract of contracts) {
      const closure = abiClosure(index, grouped, contract.id);
      const pinnedFunctions = closure.functions.filter((fn) =>
        feePinsSet.has(fn.signature),
      );
      if (pinnedFunctions.length === 0) continue;
      const destinations = new Set<string>();
      for (const fn of pinnedFunctions) {
        for (const relationship of index.graph.getRelationshipsFrom(fn.id)) {
          if (relationship.type !== 'WRITES') continue;
          if (index.stateVariablesById.has(relationship.target_id)) {
            destinations.add(relationship.target_id);
          }
        }
      }
      if (destinations.size < 2) continue;
      const coAccess: string[] = [];
      for (const [fnId, targets] of targetsByFunction) {
        let hits = 0;
        for (const destination of destinations) {
          if (targets.has(destination)) hits += 1;
        }
        if (hits >= 2) coAccess.push(fnId);
      }
      if (coAccess.length === 0) continue;
      const held = byHolder.get(contract.id) ?? [];
      if (held.length === 0) continue;
      emit(
        'fees_protocol_user',
        'interface-structural',
        sortUnique(held.map((placement) => placement.asset.id)),
        sortUnique([
          contract.id,
          ...held.flatMap((placement) => placement.asset.basis),
          ...pinnedFunctions.map((fn) => fn.id),
          ...destinations,
          ...coAccess,
        ]),
      );
    }
  }

  relations.sort((a, b) => compareCodeUnits(a.id, b.id));
  return { accounting: relations, unknowns: [] };
}
