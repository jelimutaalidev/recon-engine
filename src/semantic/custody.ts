import type { Contract } from '../domain/contract.js';
import type { SolidityFunction } from '../domain/function.js';
import type { StateVariable } from '../domain/state-variable.js';
import { compareCodeUnits } from '../util/canonical.js';
import type { EvidenceIndex } from './evidence.js';
import { semanticContentId } from './ids.js';
import {
  AssetRecordSchema,
  ClaimRecordSchema,
  CustodyRecordSchema,
  type AssetRecord,
  type ClaimRecord,
  type CustodyRecord,
  type UnknownIndexEntry,
} from './model.js';
import { COLLATERAL_PINS, DEBT_PINS, ERC20_PINS, LP_PINS, REWARD_PINS } from './pins.js';

export interface AssetDerivation {
  assets: AssetRecord[];
  custody: CustodyRecord[];
  claims: ClaimRecord[];
  unknowns: UnknownIndexEntry[];
}

type AssetType = AssetRecord['asset_type'];
type UnknownReason = UnknownIndexEntry['reason'];

interface AbiClosure {
  contracts: Contract[];
  functions: SolidityFunction[];
  signatures: ReadonlySet<string>;
}

interface Candidate {
  sv: StateVariable;
  typeContract: Contract;
  assetType: AssetType;
  pinFunctionIds: string[];
}

interface UnknownDraft {
  record_ref: string;
  field: string;
  reason: UnknownReason;
  basis: Set<string>;
}

// Spec 7 C3 class subsets: pinned per OD-8 (pins.ts evidence gate). Matching
// is full-set against the candidate's ABI closure; exactly one class match
// classifies, zero or several matches stay 'unknown'.
const CLASS_PIN_SETS: readonly { assetType: AssetType; pins: readonly string[] }[] = [
  { assetType: 'debt', pins: DEBT_PINS },
  { assetType: 'collateral', pins: COLLATERAL_PINS },
  { assetType: 'reward', pins: REWARD_PINS },
  { assetType: 'lp', pins: LP_PINS },
];

const ALL_PIN_SIGNATURES: ReadonlySet<string> = new Set<string>([
  ...ERC20_PINS,
  ...CLASS_PIN_SETS.flatMap((entry) => [...entry.pins]),
]);

// Spec 7 C7: movement-calling surface the Layer B4 transitions point at (the
// ERC20 pin set minus the balance read). Defined here, not in pins.ts -- this
// is rule shape, not an OD-8 recognition list.
const MOVEMENT_SIGNATURES: ReadonlySet<string> = new Set<string>(
  ERC20_PINS.filter((signature) => signature !== 'balanceOf(address)'),
);

const REPRESENTATION_TYPES: ReadonlySet<AssetType> = new Set<AssetType>([
  'debt',
  'collateral',
  'reward',
  'lp',
  'share',
  'receipt',
]);

const ENTITLEMENT_SIGNATURE = 'balanceOf(address)';

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

function functionsByContract(index: EvidenceIndex): Map<string, SolidityFunction[]> {
  const grouped = new Map<string, SolidityFunction[]>();
  for (const fn of index.functionsById.values()) {
    const bucket = grouped.get(fn.contract_id);
    if (bucket === undefined) grouped.set(fn.contract_id, [fn]);
    else bucket.push(fn);
  }
  return grouped;
}

// ABI closure (spec 7 C2/C3 "in-scope ABI"): the candidate type contract plus
// every in-scope INHERITS/IMPLEMENTS base, transitively.
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

// Spec 7 C2/C3 classification: full-set match per pin family against the ABI
// closure; exactly one family match classifies, otherwise 'unknown'.
function classify(signatures: ReadonlySet<string>): AssetType {
  const matches: AssetType[] = [];
  if (ERC20_PINS.every((signature) => signatures.has(signature))) matches.push('erc20');
  for (const entry of CLASS_PIN_SETS) {
    if (entry.pins.every((signature) => signatures.has(signature))) matches.push(entry.assetType);
  }
  return matches.length === 1 ? (matches[0] as AssetType) : 'unknown';
}

export function deriveAssets(index: EvidenceIndex): AssetDerivation {
  const grouped = functionsByContract(index);

  const contractsByName = new Map<string, Contract[]>();
  for (const contract of index.contractsById.values()) {
    const bucket = contractsByName.get(contract.name);
    if (bucket === undefined) contractsByName.set(contract.name, [contract]);
    else bucket.push(contract);
  }

  const draftsByKey = new Map<string, UnknownDraft>();
  const noteUnknown = (
    record_ref: string,
    field: string,
    reason: UnknownReason,
    basis: Iterable<string>,
  ): void => {
    const key = [record_ref, field, reason].join(' ');
    const existing = draftsByKey.get(key);
    if (existing === undefined) {
      draftsByKey.set(key, { record_ref, field, reason, basis: new Set<string>(basis) });
      return;
    }
    for (const id of basis) existing.basis.add(id);
  };

  // C1: candidate = state var whose declared type resolves to exactly one
  // in-scope contract; every non-resolving var yields no record + no_evidence.
  const stateVars = [...index.stateVariablesById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
  const candidates: Candidate[] = [];
  for (const sv of stateVars) {
    const named = contractsByName.get(sv.type) ?? [];
    const typeContract = named.length === 1 ? (named[0] as Contract) : undefined;
    if (typeContract === undefined) {
      noteUnknown(sv.id, 'asset', 'no_evidence', [sv.id]);
      continue;
    }
    const closure = abiClosure(index, grouped, typeContract.id);
    candidates.push({
      sv,
      typeContract,
      assetType: classify(closure.signatures),
      pinFunctionIds: closure.functions
        .filter((fn) => ALL_PIN_SIGNATURES.has(fn.signature))
        .map((fn) => fn.id),
    });
  }

  // C2/C3: classify + pair each representation with the co-occurring erc20
  // underlying (exactly one pair => represents_asset_id, 0 or many => absent).
  const candidatesByContract = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = candidatesByContract.get(candidate.sv.contract_id);
    if (bucket === undefined) candidatesByContract.set(candidate.sv.contract_id, [candidate]);
    else bucket.push(candidate);
  }

  const assetIdBySvId = new Map<string, string>();
  for (const candidate of candidates) {
    assetIdBySvId.set(
      candidate.sv.id,
      semanticContentId('sema', {
        contract_id: candidate.sv.contract_id,
        state_var_id: candidate.sv.id,
      }),
    );
  }

  const assets: AssetRecord[] = [];
  for (const bucket of candidatesByContract.values()) {
    const erc20 = bucket.filter((candidate) => candidate.assetType === 'erc20');
    for (const candidate of bucket) {
      const assetId = assetIdBySvId.get(candidate.sv.id) as string;
      const represents =
        REPRESENTATION_TYPES.has(candidate.assetType) && erc20.length === 1
          ? (assetIdBySvId.get((erc20[0] as Candidate).sv.id) as string)
          : undefined;
      const basis = sortUnique([
        candidate.sv.id,
        candidate.typeContract.id,
        ...candidate.pinFunctionIds,
      ]);
      assets.push(
        AssetRecordSchema.parse({
          id: assetId,
          name: candidate.sv.type,
          asset_type: candidate.assetType,
          evidence_class: 'E2',
          basis,
          ...(represents !== undefined ? { represents_asset_id: represents } : {}),
        }),
      );
    }
  }

  // C4: every asset-typed var in contract X yields a contract-custody record
  // held by X; EOA-like (non-resolving) holders are unobservable => absent.
  const custody: CustodyRecord[] = [];
  for (const candidate of candidates) {
    const assetId = assetIdBySvId.get(candidate.sv.id) as string;
    custody.push(
      CustodyRecordSchema.parse({
        id: semanticContentId('semk', {
          asset_id: assetId,
          holder_contract_id: candidate.sv.contract_id,
        }),
        asset_id: assetId,
        holder_contract_id: candidate.sv.contract_id,
        location_kind: 'contract',
        basis: sortUnique([candidate.sv.id, candidate.sv.contract_id]),
      }),
    );
  }

  // C5: holder-side read of the paired representation (READS of the state var
  // or CALLS of a representation balanceOf surface) + underlying entitlement
  // surface => observation-level claim.
  const claims: ClaimRecord[] = [];
  for (const candidate of candidates) {
    if (!REPRESENTATION_TYPES.has(candidate.assetType)) continue;
    const assetId = assetIdBySvId.get(candidate.sv.id) as string;
    const asset = assets.find((record) => record.id === assetId);
    if (asset === undefined || asset.represents_asset_id === undefined) continue;
    const underlyingAssetId = asset.represents_asset_id;
    const underlying = candidates.find(
      (other) => assetIdBySvId.get(other.sv.id) === underlyingAssetId,
    );
    if (underlying === undefined) continue;
    const underlyingClosure = abiClosure(index, grouped, underlying.typeContract.id);
    if (!underlyingClosure.signatures.has(ENTITLEMENT_SIGNATURE)) continue;

    const repClosure = abiClosure(index, grouped, candidate.typeContract.id);
    const repBalanceIds = new Set<string>(
      repClosure.functions
        .filter((fn) => fn.signature === ENTITLEMENT_SIGNATURE)
        .map((fn) => fn.id),
    );
    const readerIds = new Set<string>();
    for (const fn of index.functionsById.values()) {
      for (const relationship of index.graph.getRelationshipsFrom(fn.id)) {
        if (relationship.type === 'READS' && relationship.target_id === candidate.sv.id) {
          readerIds.add(fn.id);
        } else if (relationship.type === 'CALLS' && repBalanceIds.has(relationship.target_id)) {
          readerIds.add(fn.id);
        }
      }
    }
    for (const readerId of [...readerIds].sort(compareCodeUnits)) {
      claims.push(
        ClaimRecordSchema.parse({
          id: semanticContentId('semcl', {
            holder_ref: readerId,
            claim_on: underlyingAssetId,
            via: assetId,
          }),
          holder_ref: readerId,
          claim_on: underlyingAssetId,
          via: assetId,
          epistemic: 'observation',
          basis: sortUnique([
            readerId,
            candidate.sv.id,
            candidate.typeContract.id,
            underlying.sv.id,
            underlying.typeContract.id,
          ]),
        }),
      );
    }
  }

  // C6: native balances are not modeled by IR -- payable surfaces yield a
  // contract-level no_evidence hint, never a native AssetRecord.
  for (const contract of [...index.contractsById.values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  )) {
    const payableIds = (grouped.get(contract.id) ?? [])
      .filter((fn) => fn.mutability === 'payable')
      .map((fn) => fn.id)
      .sort(compareCodeUnits);
    if (payableIds.length > 0) {
      noteUnknown(contract.id, 'native_asset', 'no_evidence', payableIds);
    }
  }

  // C7: a movement call links only when the calling contract holds a
  // C-classified asset; otherwise asset_ref stays absent + no_evidence.
  const classifiedByContract = new Set<string>(
    candidates
      .filter((candidate) => candidate.assetType !== 'unknown')
      .map((candidate) => candidate.sv.contract_id),
  );
  for (const relationship of index.graph.findRelationshipsByType('CALLS')) {
    const target = index.functionsById.get(relationship.target_id);
    if (target === undefined || !MOVEMENT_SIGNATURES.has(target.signature)) continue;
    const caller = index.functionsById.get(relationship.source_id);
    if (caller === undefined) continue;
    if (classifiedByContract.has(caller.contract_id)) continue;
    noteUnknown(
      semanticContentId('semt', {
        function_id: caller.id,
        contract_id: caller.contract_id,
      }),
      'asset_ref',
      'no_evidence',
      [relationship.id, caller.id, target.id],
    );
  }

  const materialized: UnknownIndexEntry[] = [...draftsByKey.values()]
    .map((draft) => ({
      record_ref: draft.record_ref,
      field: draft.field,
      reason: draft.reason,
      basis: sortUnique(draft.basis),
    }))
    .sort(compareUnknowns);

  assets.sort((a, b) => compareCodeUnits(a.id, b.id));
  custody.sort((a, b) => compareCodeUnits(a.id, b.id));
  claims.sort((a, b) => compareCodeUnits(a.id, b.id));

  return { assets, custody, claims, unknowns: materialized };
}
