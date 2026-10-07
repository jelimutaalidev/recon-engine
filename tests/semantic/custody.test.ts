import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../src/domain/contract.js';
import type { ContractType, Mutability } from '../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../src/domain/state-variable.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import { createRelationship, type Relationship } from '../../src/relationships/relationship.js';
import { createReconState } from '../../src/recon-state/state.js';
import { deriveAssets, type AssetDerivation } from '../../src/semantic/custody.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../src/semantic/evidence.js';
import { semanticContentId } from '../../src/semantic/ids.js';
import {
  AssetRecordSchema,
  ClaimRecordSchema,
  CustodyRecordSchema,
  UnknownIndexEntrySchema,
  type AssetRecord,
  type UnknownIndexEntry,
} from '../../src/semantic/model.js';
import {
  COLLATERAL_PINS,
  DEBT_PINS,
  ERC20_PINS,
  LP_PINS,
  REWARD_PINS,
} from '../../src/semantic/pins.js';

// Layer C unit suite (spec §7 rules C1–C7): in-process mini-states, Phase 3
// fixture-isolation pattern. No corpus analysis here — pins.test.ts owns the
// OD-8 evidence gate for pin lists.

function sourceSpan(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function parseSignature(signature: string): { name: string; parameters: { type: string }[] } {
  const match = /^([$a-zA-Z_][$a-zA-Z0-9_]*)\((.*)\)$/.exec(signature);
  if (match === null) throw new Error(`bad signature: ${signature}`);
  const inner = match[2]!.trim();
  const parameters = inner === '' ? [] : inner.split(',').map((type) => ({ type: type.trim() }));
  return { name: match[1]!, parameters };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const stateVariables: StateVariable[] = [];
  const relationships: Relationship[] = [];
  const functionsByContract = new Map<string, SolidityFunction[]>();

  const fn = (
    contract: Contract,
    signature: string,
    options: { mutability?: Mutability } = {},
  ): SolidityFunction => {
    const parsed = parseSignature(signature);
    const record = createFunction({
      contract_id: contract.id,
      name: parsed.name,
      parameters: parsed.parameters,
      visibility: 'external',
      mutability: options.mutability ?? 'nonpayable',
    });
    functions.push(record);
    const bucket = functionsByContract.get(contract.id);
    if (bucket === undefined) functionsByContract.set(contract.id, [record]);
    else bucket.push(record);
    return record;
  };

  return {
    contract(name: string, contractType: ContractType = 'core'): Contract {
      const record = createContract({ name, contract_type: contractType });
      contracts.push(record);
      return record;
    },
    iface(name: string): Contract {
      const record = createContract({ name, contract_type: 'interface' });
      contracts.push(record);
      return record;
    },
    fn,
    declare(contract: Contract, signature: string): SolidityFunction {
      return fn(contract, signature, { mutability: 'view' });
    },
    fns(contract: Contract): readonly SolidityFunction[] {
      return functionsByContract.get(contract.id) ?? [];
    },
    stateVar(contract: Contract, name: string, type: string): StateVariable {
      const record = createStateVariable({
        contract_id: contract.id,
        name,
        type,
        visibility: 'public',
      });
      stateVariables.push(record);
      return record;
    },
    rel(
      type: Relationship['type'],
      sourceId: string,
      targetId: string,
      provenance: ProvenanceInput[],
      metadata?: Record<string, string>,
    ): Relationship {
      const record = createRelationship({
        type,
        source_id: sourceId,
        target_id: targetId,
        provenance,
        ...(metadata !== undefined ? { metadata } : {}),
        created_at: '2024-01-01T00:00:00.000Z',
      });
      relationships.push(record);
      return record;
    },
    buildIndex(options: { fidelity?: 'semantic' | 'syntactic' } = {}): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: stateVariables,
        relationships,
        facts: [],
      });
      return buildEvidenceIndex({
        state,
        issues: [],
        meta: { fidelity: options.fidelity ?? 'semantic', fileCount: 1 },
      });
    },
  };
}

function declarePins(
  state: ReturnType<typeof miniState>,
  contract: Contract,
  pins: readonly string[],
): void {
  for (const pin of pins) state.declare(contract, pin);
}

function assetOf(result: AssetDerivation, stateVar: StateVariable): AssetRecord {
  const found = result.assets.find((asset) => asset.basis.includes(stateVar.id));
  if (found === undefined) throw new Error(`missing asset for ${stateVar.id}`);
  return found;
}

function expectParseable(result: AssetDerivation): void {
  for (const asset of result.assets) AssetRecordSchema.parse(asset);
  for (const record of result.custody) CustodyRecordSchema.parse(record);
  for (const record of result.claims) ClaimRecordSchema.parse(record);
  for (const entry of result.unknowns) UnknownIndexEntrySchema.parse(entry);
}

function collectKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      collectKeys(entry, found);
    }
  }
}

function compareUnknowns(a: UnknownIndexEntry, b: UnknownIndexEntry): number {
  const byRef = a.record_ref < b.record_ref ? -1 : a.record_ref > b.record_ref ? 1 : 0;
  if (byRef !== 0) return byRef;
  const byField = a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
  if (byField !== 0) return byField;
  const byReason = a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  if (byReason !== 0) return byReason;
  const left = a.basis.join(' ');
  const right = b.basis.join(' ');
  return left < right ? -1 : left > right ? 1 : 0;
}

function fnBySignature(
  state: ReturnType<typeof miniState>,
  contract: Contract,
  signature: string,
): SolidityFunction {
  const found = state.fns(contract).find((record) => record.signature === signature);
  if (found === undefined) throw new Error(`missing ${signature} on ${contract.name}`);
  return found;
}

describe('deriveAssets (spec §7 rules C1–C7)', () => {
  it('C1: in-scope contract-typed state var yields a candidate (unknown type, E2, sorted basis); non-typed and out-of-scope types yield no record + no_evidence unknown', () => {
    const state = miniState();
    const empty = state.iface('IEmpty');
    const holder = state.contract('Holder');
    const typed = state.stateVar(holder, 'thing', 'IEmpty');
    const plainAddress = state.stateVar(holder, 'owner', 'address');
    const plainUint = state.stateVar(holder, 'count', 'uint256');
    const mapped = state.stateVar(holder, 'buckets', 'mapping(address => uint256)');
    const outside = state.stateVar(holder, 'external', 'IVaultOutside');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    expect(result.assets).toHaveLength(1);
    const asset = assetOf(result, typed);
    expect(asset.asset_type).toBe('unknown');
    expect(asset.evidence_class).toBe('E2');
    expect(asset.basis.length).toBeGreaterThanOrEqual(1);
    expect(asset.basis).toEqual([...asset.basis].sort());
    expect(asset.basis.includes(empty.id)).toBe(true);
    expect(result.custody).toHaveLength(1);
    expect(result.claims).toHaveLength(0);

    for (const sv of [plainAddress, plainUint, mapped, outside]) {
      const entry = result.unknowns.find(
        (candidate) => candidate.record_ref === sv.id && candidate.field === 'asset',
      );
      expect(entry, `expected no_evidence unknown for ${sv.name}`).toBeDefined();
      expect(entry!.reason).toBe('no_evidence');
      expect(entry!.basis).toEqual([sv.id]);
    }
    expect(result.unknowns.some((entry) => entry.record_ref === typed.id)).toBe(false);
  });

  it('C2: candidate interface declaring all four ERC20_PINS classifies erc20; three-of-four, IERC721-shaped, and cross-contract pin contamination stay unknown (per-interface full-set matching)', () => {
    const state = miniState();
    const holder = state.contract('Holder');

    const full = state.iface('IERC20Full');
    declarePins(state, full, ERC20_PINS);
    const fullVar = state.stateVar(holder, 'fullToken', 'IERC20Full');

    const three = state.iface('IThreeOfFour');
    declarePins(state, three, [
      'transfer(address,uint256)',
      'approve(address,uint256)',
      'balanceOf(address)',
    ]);
    const threeVar = state.stateVar(holder, 'threeToken', 'IThreeOfFour');

    const nft = state.iface('IERC721Like');
    declarePins(state, nft, [
      'transferFrom(address,address,uint256)',
      'safeTransferFrom(address,address,uint256)',
      'ownerOf(uint256)',
    ]);
    const nftVar = state.stateVar(holder, 'nft', 'IERC721Like');

    // Decoy contract in the SAME index declares the full ERC20 pin set; pin
    // matching must never reach across interfaces on bare signature identity.
    const decoy = state.contract('DecoyToken');
    declarePins(state, decoy, ERC20_PINS);

    const base = state.iface('IBaseToken');
    declarePins(state, base, ERC20_PINS);
    const derived = state.contract('DerivedToken');
    state.rel('INHERITS', derived.id, base.id, [sourceSpan('Derived.sol', 3)]);
    const derivedVar = state.stateVar(holder, 'derivedToken', 'DerivedToken');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    expect(assetOf(result, fullVar).asset_type).toBe('erc20');
    expect(assetOf(result, derivedVar).asset_type).toBe('erc20');
    expect(assetOf(result, threeVar).asset_type).toBe('unknown');
    expect(assetOf(result, nftVar).asset_type).toBe('unknown');
  });

  it('C3: each pinned class present in the candidate interface ABI classifies + pairs represents_asset_id with the co-occurring erc20; unpinned share-family ABI stays unknown', () => {
    const classCases: { pins: readonly string[]; assetType: AssetRecord['asset_type'] }[] = [
      { pins: DEBT_PINS, assetType: 'debt' },
      { pins: COLLATERAL_PINS, assetType: 'collateral' },
      { pins: REWARD_PINS, assetType: 'reward' },
      { pins: LP_PINS, assetType: 'lp' },
    ];
    for (const classCase of classCases) {
      const state = miniState();
      const rep = state.iface('IRepresentation');
      declarePins(state, rep, classCase.pins);
      const underlying = state.iface('IERC20Underlying');
      declarePins(state, underlying, ERC20_PINS);
      const holder = state.contract('HolderContract');
      const repVar = state.stateVar(holder, 'representation', 'IRepresentation');
      const underlyingVar = state.stateVar(holder, 'underlying', 'IERC20Underlying');

      const result = deriveAssets(state.buildIndex());
      expectParseable(result);

      const repAsset = assetOf(result, repVar);
      const underlyingAsset = assetOf(result, underlyingVar);
      expect(repAsset.asset_type, classCase.assetType).toBe(classCase.assetType);
      expect(underlyingAsset.asset_type).toBe('erc20');
      expect(repAsset.represents_asset_id).toBe(underlyingAsset.id);
      expect(underlyingAsset).not.toHaveProperty('represents_asset_id');
    }

    // Unpinned class (spec §7 share family, omitted for want of corpus evidence):
    const state = miniState();
    const share = state.iface('IShareVault');
    state.declare(share, 'convertToShares(uint256)');
    state.declare(share, 'asset()');
    const holder = state.contract('ShareHolder');
    const shareVar = state.stateVar(holder, 'shares', 'IShareVault');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);
    expect(assetOf(result, shareVar).asset_type).toBe('unknown');
    expect(assetOf(result, shareVar)).not.toHaveProperty('represents_asset_id');
  });

  it('C3: ambiguous underlying pairing (two erc20 co-candidates) leaves represents_asset_id absent', () => {
    const state = miniState();
    const rep = state.iface('IRepReward');
    declarePins(state, rep, REWARD_PINS);
    const underlying = state.iface('IToken');
    declarePins(state, underlying, ERC20_PINS);
    const holder = state.contract('AmbiguousPair');
    const repVar = state.stateVar(holder, 'representation', 'IRepReward');
    state.stateVar(holder, 'tokenA', 'IToken');
    state.stateVar(holder, 'tokenB', 'IToken');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);
    expect(assetOf(result, repVar).asset_type).toBe('reward');
    expect(assetOf(result, repVar)).not.toHaveProperty('represents_asset_id');
    expect(result.assets.filter((asset) => asset.asset_type === 'erc20')).toHaveLength(2);
  });

  it('C4: asset-typed var in contract X yields CustodyRecord{location_kind: contract} held by X; holder-less/EOA-like entities never produce custody', () => {
    const state = miniState();
    const token = state.iface('IToken');
    declarePins(state, token, ERC20_PINS);
    const holder = state.contract('VaultX');
    const tokenVar = state.stateVar(holder, 'vaultToken', 'IToken');
    const eoaLike = state.stateVar(holder, 'admin', 'address');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    const asset = assetOf(result, tokenVar);
    expect(result.custody).toHaveLength(1);
    const custody = result.custody[0]!;
    expect(custody.asset_id).toBe(asset.id);
    expect(custody.holder_contract_id).toBe(holder.id);
    expect(custody.location_kind).toBe('contract');
    expect(custody.basis.includes(tokenVar.id)).toBe(true);

    // EOA custody is unobservable: the address-typed var yields no asset and
    // therefore no custody record; nothing is ever guessed at location 'unknown'.
    expect(result.assets.some((record) => record.basis.includes(eoaLike.id))).toBe(false);
    expect(result.custody.some((record) => record.location_kind === 'unknown')).toBe(false);
    expect(result.custody).toHaveLength(result.assets.length);
  });

  it('C5: holder-side representation-balance read + underlying entitlement surface yields an observation-level ClaimRecord; missing read yields none', () => {
    const state = miniState();
    const rep = state.iface('IRewardSurface');
    declarePins(state, rep, REWARD_PINS);
    const underlying = state.iface('IUnderlying');
    declarePins(state, underlying, ERC20_PINS);
    const holder = state.contract('StakingX');
    const repVar = state.stateVar(holder, 'rewardPosition', 'IRewardSurface');
    const underlyingVar = state.stateVar(holder, 'underlying', 'IUnderlying');
    const reader = state.fn(holder, 'readPosition(uint256)', { mutability: 'view' });
    const silent = state.fn(holder, 'poke()', { mutability: 'nonpayable' });
    state.rel('READS', reader.id, repVar.id, [sourceSpan('StakingX.sol', 12)]);
    state.rel('READS', silent.id, underlyingVar.id, [sourceSpan('StakingX.sol', 20)]);

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0]!;
    expect(claim.holder_ref).toBe(reader.id);
    expect(claim.claim_on).toBe(assetOf(result, underlyingVar).id);
    expect(claim.via).toBe(assetOf(result, repVar).id);
    expect(claim.epistemic).toBe('observation');
    expect(claim.basis.includes(reader.id)).toBe(true);
    expect(claim.basis).toEqual([...claim.basis].sort());
  });

  it('C5: representation balance read via the representation ABI balanceOf surface also yields a claim', () => {
    const state = miniState();
    const rep = state.iface('IShareLike');
    declarePins(state, rep, LP_PINS);
    const balanceFn = state.declare(rep, 'balanceOf(address)');
    const underlying = state.iface('IUnderlying');
    declarePins(state, underlying, ERC20_PINS);
    const holder = state.contract('LpHolder');
    const repVar = state.stateVar(holder, 'lpPosition', 'IShareLike');
    state.stateVar(holder, 'underlying', 'IUnderlying');
    const balanceReader = state.fn(holder, 'positionOf(address)', { mutability: 'view' });
    state.rel('CALLS', balanceReader.id, balanceFn.id, [sourceSpan('LpHolder.sol', 9)], {
      call_kind: 'external',
    });

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.holder_ref).toBe(balanceReader.id);
    expect(result.claims[0]!.via).toBe(assetOf(result, repVar).id);
  });

  it('C5 failure: no representation pairing (no co-occurring erc20) yields no claim even with a balance read', () => {
    const state = miniState();
    const rep = state.iface('IBareReward');
    declarePins(state, rep, REWARD_PINS);
    const holder = state.contract('UnpairedHolder');
    const repVar = state.stateVar(holder, 'rewardPosition', 'IBareReward');
    const reader = state.fn(holder, 'readPosition(uint256)', { mutability: 'view' });
    state.rel('READS', reader.id, repVar.id, [sourceSpan('UnpairedHolder.sol', 5)]);

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);
    expect(result.claims).toHaveLength(0);
  });

  it('C6: payable functions yield a contract-level no_evidence unknown and zero native AssetRecords', () => {
    const state = miniState();
    const paid = state.contract('PayVault');
    const deposit = state.fn(paid, 'deposit()', { mutability: 'payable' });
    state.fn(paid, 'viewOnly()', { mutability: 'view' });

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);
    expect(result.assets).toHaveLength(0);
    const entry = result.unknowns.find(
      (candidate) => candidate.record_ref === paid.id && candidate.field === 'native_asset',
    );
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe('no_evidence');
    expect(entry!.basis).toContain(deposit.id);

    // Even when a contract has typed candidates, native balances stay unmodeled.
    const state2 = miniState();
    const token = state2.iface('IToken');
    declarePins(state2, token, ERC20_PINS);
    const mixed = state2.contract('MixedVault');
    state2.fn(mixed, 'enter()', { mutability: 'payable' });
    state2.stateVar(mixed, 'heldToken', 'IToken');
    const mixedResult = deriveAssets(state2.buildIndex());
    expectParseable(mixedResult);
    expect(mixedResult.assets.some((asset) => asset.asset_type === 'native')).toBe(false);
    expect(
      mixedResult.unknowns.some(
        (candidate) =>
          candidate.record_ref === mixed.id &&
          candidate.field === 'native_asset' &&
          candidate.reason === 'no_evidence',
      ),
    ).toBe(true);
  });

  it('C7: movement call without a C-classified asset yields asset_ref absent + a no_evidence unknown on the transition; multiple movement calls merge into one entry', () => {
    const state = miniState();
    const token = state.iface('IToken');
    state.declare(token, 'transfer(address,uint256)');
    state.declare(token, 'approve(address,uint256)');
    const transferTarget = fnBySignature(state, token, 'transfer(address,uint256)');
    const approveTarget = fnBySignature(state, token, 'approve(address,uint256)');

    const caller = state.contract('CallerNoAsset');
    const callerFn = state.fn(caller, 'moveSomething()');
    const transferRel = state.rel(
      'CALLS',
      callerFn.id,
      transferTarget.id,
      [sourceSpan('CallerNoAsset.sol', 8)],
      { call_kind: 'external' },
    );
    const approveRel = state.rel(
      'CALLS',
      callerFn.id,
      approveTarget.id,
      [sourceSpan('CallerNoAsset.sol', 12)],
      { call_kind: 'external' },
    );

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    const transitionId = semanticContentId('semt', {
      function_id: callerFn.id,
      contract_id: caller.id,
    });
    const movementUnknowns = result.unknowns.filter(
      (candidate) => candidate.field === 'asset_ref',
    );
    expect(movementUnknowns).toHaveLength(1);
    const entry = movementUnknowns[0]!;
    expect(entry.record_ref).toBe(transitionId);
    expect(entry.reason).toBe('no_evidence');
    expect(entry.basis).toEqual(
      [
        transferRel.id,
        approveRel.id,
        callerFn.id,
        transferTarget.id,
        approveTarget.id,
      ].sort(),
    );

    const keys = new Set<string>();
    for (const record of [...result.assets, ...result.custody, ...result.claims]) {
      collectKeys(record, keys);
    }
    expect(keys.has('asset_ref')).toBe(false);
    expect(result.assets).toHaveLength(0);
  });

  it('C7: unclassified-but-present candidates do not satisfy the movement link; a C-classified asset suppresses the unknown', () => {
    const state = miniState();
    const token = state.iface('IToken');
    declarePins(state, token, ERC20_PINS);
    const transferTarget = fnBySignature(state, token, 'transfer(address,uint256)');
    const nft = state.iface('IERC721Like');
    state.declare(nft, 'transferFrom(address,address,uint256)');
    state.declare(nft, 'ownerOf(uint256)');

    const unclassifiedCaller = state.contract('UnclassifiedCaller');
    const unclassifiedFn = state.fn(unclassifiedCaller, 'moveNft()');
    state.rel(
      'CALLS',
      unclassifiedFn.id,
      transferTarget.id,
      [sourceSpan('UnclassifiedCaller.sol', 6)],
      { call_kind: 'external' },
    );
    state.stateVar(unclassifiedCaller, 'held', 'IERC721Like');

    const classifiedCaller = state.contract('ClassifiedCaller');
    const classifiedFn = state.fn(classifiedCaller, 'moveToken()');
    state.rel('CALLS', classifiedFn.id, transferTarget.id, [
      sourceSpan('ClassifiedCaller.sol', 6),
    ], { call_kind: 'external' });
    state.stateVar(classifiedCaller, 'held', 'IToken');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    const assetUnknowns = result.unknowns.filter(
      (candidate) => candidate.field === 'asset_ref',
    );
    expect(assetUnknowns).toHaveLength(1);
    const unclassifiedTransition = semanticContentId('semt', {
      function_id: unclassifiedFn.id,
      contract_id: unclassifiedCaller.id,
    });
    const classifiedTransition = semanticContentId('semt', {
      function_id: classifiedFn.id,
      contract_id: classifiedCaller.id,
    });
    expect(assetUnknowns[0]!.record_ref).toBe(unclassifiedTransition);
    expect(assetUnknowns.some((candidate) => candidate.record_ref === classifiedTransition)).toBe(
      false,
    );
  });

  it('name-bait: uint256 public collateral (and friends) yield zero classified assets with the unknown index populated; identifier names never reach record fields', () => {
    const state = miniState();
    const trap = state.contract('AmbiguousTrap');
    const collateral = state.stateVar(trap, 'collateral', 'uint256');
    const treasury = state.stateVar(trap, 'treasury', 'uint256');
    const oracle = state.stateVar(trap, 'oracle', 'address');

    // A typed var whose identifier is bait classifies only from its ABI.
    const token = state.iface('IToken');
    declarePins(state, token, ERC20_PINS);
    const baitTyped = state.stateVar(trap, 'collateralToken', 'IToken');

    const result = deriveAssets(state.buildIndex());
    expectParseable(result);

    expect(result.assets).toHaveLength(1);
    const baitAsset = assetOf(result, baitTyped);
    expect(baitAsset.asset_type).toBe('erc20');
    expect(baitAsset.name).toBe('IToken');
    expect(baitAsset.name).not.toBe('collateralToken');
    expect(result.custody).toHaveLength(1);
    expect(result.claims).toHaveLength(0);

    for (const sv of [collateral, treasury, oracle]) {
      const entry = result.unknowns.find(
        (candidate) => candidate.record_ref === sv.id && candidate.reason === 'no_evidence',
      );
      expect(entry, `expected unknown for bait var ${sv.name}`).toBeDefined();
      expect(result.assets.some((asset) => asset.basis.includes(sv.id))).toBe(false);
    }
    expect(result.assets.filter((asset) => asset.asset_type !== 'erc20')).toHaveLength(0);
  });

  it('determinism: repeated derivation is byte-equal, schema-valid, sorted, and read-only', () => {
    const state = miniState();
    const rep = state.iface('IRewardSurface');
    declarePins(state, rep, REWARD_PINS);
    const underlying = state.iface('IUnderlying');
    declarePins(state, underlying, ERC20_PINS);
    const holder = state.contract('StakingX');
    const repVar = state.stateVar(holder, 'rewardPosition', 'IRewardSurface');
    const underlyingVar = state.stateVar(holder, 'underlying', 'IUnderlying');
    const reader = state.fn(holder, 'readPosition(uint256)', { mutability: 'view' });
    state.rel('READS', reader.id, repVar.id, [sourceSpan('StakingX.sol', 12)]);
    state.stateVar(holder, 'admin', 'address');
    const payVault = state.contract('PayVault');
    state.fn(payVault, 'deposit()', { mutability: 'payable' });
    const token = state.iface('IMoveToken');
    state.declare(token, 'transfer(address,uint256)');
    const transferTarget = fnBySignature(state, token, 'transfer(address,uint256)');
    const mover = state.contract('Mover');
    const moverFn = state.fn(mover, 'move()');
    state.rel('CALLS', moverFn.id, transferTarget.id, [sourceSpan('Mover.sol', 4)], {
      call_kind: 'external',
    });

    const index = state.buildIndex();
    const stateBefore = JSON.stringify(index.input.state);
    const first = deriveAssets(index);
    const second = deriveAssets(index);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(index.input.state)).toBe(stateBefore);
    expectParseable(first);

    const assetIds = first.assets.map((asset) => asset.id);
    expect(assetIds).toEqual([...assetIds].sort());
    const custodyIds = first.custody.map((record) => record.id);
    expect(custodyIds).toEqual([...custodyIds].sort());
    const claimIds = first.claims.map((record) => record.id);
    expect(claimIds).toEqual([...claimIds].sort());
    expect(first.unknowns).toEqual([...first.unknowns].sort(compareUnknowns));
    expect(first.claims).toHaveLength(1);
    expect(first.unknowns.map((candidate) => candidate.field).sort()).toEqual([
      'asset',
      'asset_ref',
      'native_asset',
    ]);
    expect(first.unknowns.map((candidate) => candidate.reason)).toEqual([
      'no_evidence',
      'no_evidence',
      'no_evidence',
    ]);
  });
});
