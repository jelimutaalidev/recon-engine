import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../src/domain/contract.js';
import type { ContractType, Mutability } from '../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../src/domain/state-variable.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import { createRelationship, type Relationship } from '../../src/relationships/relationship.js';
import { createReconState } from '../../src/recon-state/state.js';
import { deriveAccounting } from '../../src/semantic/accounting.js';
import { deriveAssets } from '../../src/semantic/custody.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../src/semantic/evidence.js';
import { semanticContentId } from '../../src/semantic/ids.js';
import {
  AccountingRelationSchema,
  AssetRecordSchema,
  UnknownIndexEntrySchema,
  type AccountingRelation,
  type AssetRecord,
} from '../../src/semantic/model.js';
import {
  COLLATERAL_PINS,
  DEBT_PINS,
  ERC20_PINS,
  FEE_PINS,
  LP_PINS,
  REWARD_PINS,
} from '../../src/semantic/pins.js';
import { compareCodeUnits } from '../../src/util/canonical.js';

// Layer D unit suite (spec §8 rule table): in-process mini-states, Phase 3
// fixture-isolation pattern. Correlations come from Task 5 classifications and
// Task 4 READS/WRITES evidence only — no name inference, zero relations valid.

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
    fnBySignature(contract: Contract, signature: string): SolidityFunction {
      const found = (functionsByContract.get(contract.id) ?? []).find(
        (record) => record.signature === signature,
      );
      if (found === undefined) throw new Error(`missing ${signature} on ${contract.name}`);
      return found;
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
    buildIndex(): EvidenceIndex {
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
        meta: { fidelity: 'semantic', fileCount: 1 },
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

function craftAsset(
  sv: StateVariable,
  assetType: AssetRecord['asset_type'],
): AssetRecord {
  return AssetRecordSchema.parse({
    id: semanticContentId('sema', { contract_id: sv.contract_id, state_var_id: sv.id }),
    name: sv.type,
    asset_type: assetType,
    evidence_class: 'E2',
    basis: [sv.id, sv.contract_id],
  });
}

function assetOf(
  derived: ReturnType<typeof deriveAssets>,
  stateVar: StateVariable,
): AssetRecord {
  const found = derived.assets.find((asset) => asset.basis.includes(stateVar.id));
  if (found === undefined) throw new Error(`missing asset for ${stateVar.id}`);
  return found;
}

function retype(
  derived: ReturnType<typeof deriveAssets>,
  replacement: AssetRecord,
): AssetRecord[] {
  return derived.assets.map((asset) => (asset.id === replacement.id ? replacement : asset));
}

function expectParseable(result: ReturnType<typeof deriveAccounting>): void {
  for (const relation of result.accounting) AccountingRelationSchema.parse(relation);
  for (const entry of result.unknowns) UnknownIndexEntrySchema.parse(entry);
}

function feePinSignature(): string {
  const pin = FEE_PINS[0];
  if (pin === undefined) throw new Error('FEE_PINS is empty (OD-8)');
  return pin;
}

describe('deriveAccounting (spec §8 rule table)', () => {
  it('assets_shares: C-classified asset + share co-held with paired access yields paired-storage relation; the unknown twin never pairs', () => {
    const state = miniState();
    const underlying = state.iface('IShareUnderlying');
    declarePins(state, underlying, ERC20_PINS);
    const shareSurface = state.iface('IShareSurface');
    state.declare(shareSurface, 'convertToShares(uint256)');
    const vault = state.contract('ShareVault');
    const underlyingVar = state.stateVar(vault, 'underlying', 'IShareUnderlying');
    const sharesVar = state.stateVar(vault, 'shares', 'IShareSurface');
    const rebalancer = state.fn(vault, 'rebalance(uint256)');
    state.rel('READS', rebalancer.id, underlyingVar.id, [sourceSpan('ShareVault.sol', 12)]);
    state.rel('WRITES', rebalancer.id, sharesVar.id, [sourceSpan('ShareVault.sol', 14)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const underlyingAsset = assetOf(derived, underlyingVar);
    const unknownTwin = assetOf(derived, sharesVar);
    expect(unknownTwin.asset_type).toBe('unknown');

    const unknownOnly = deriveAccounting(index, { assets: derived.assets });
    expect(unknownOnly).toEqual({ accounting: [], unknowns: [] });

    const shareAsset = craftAsset(sharesVar, 'share');
    expect(shareAsset.id).toBe(unknownTwin.id);
    const result = deriveAccounting(index, { assets: retype(derived, shareAsset) });
    expectParseable(result);
    expect(result.unknowns).toEqual([]);
    expect(result.accounting).toHaveLength(1);

    const relation = result.accounting[0]!;
    expect(relation.relation_kind).toBe('assets_shares');
    expect(relation.derivation).toBe('paired-storage');
    expect(relation.evidence_class).toBe('E2');
    expect(relation.epistemic).toBe('observation');
    expect(relation.unknowns).toEqual([]);
    expect(relation.id).toMatch(/^semacc:[0-9a-f]{16}$/);
    expect(relation.endpoints).toEqual(
      [shareAsset.id, underlyingAsset.id].sort(compareCodeUnits),
    );
    expect(relation.basis).toEqual([...relation.basis].sort(compareCodeUnits));
    expect(relation.basis.length).toBeGreaterThanOrEqual(1);
    expect(relation.basis).toContain(underlyingVar.id);
    expect(relation.basis).toContain(sharesVar.id);
    expect(relation.basis).toContain(rebalancer.id);
    expect(relation.basis).toContain(vault.id);
    for (const id of relation.basis) {
      expect(
        index.stateVariablesById.has(id) ||
          index.functionsById.has(id) ||
          index.contractsById.has(id),
        `basis id ${id} is not a real intake id`,
      ).toBe(true);
    }
  });

  it('assets_shares: co-occurrence without paired access yields NO relation (mandatory clause), and unco-held assets never pair', () => {
    const state = miniState();
    const underlying = state.iface('IShareUnderlying');
    declarePins(state, underlying, ERC20_PINS);
    const shareSurface = state.iface('IShareSurface');
    const vault = state.contract('ShareVault');
    const underlyingVar = state.stateVar(vault, 'underlying', 'IShareUnderlying');
    const sharesVar = state.stateVar(vault, 'shares', 'IShareSurface');
    const reader = state.fn(vault, 'peek()', { mutability: 'view' });
    state.rel('READS', reader.id, underlyingVar.id, [sourceSpan('ShareVault.sol', 6)]);
    const writer = state.fn(vault, 'mintShares(uint256)');
    state.rel('WRITES', writer.id, sharesVar.id, [sourceSpan('ShareVault.sol', 9)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const shareAsset = craftAsset(sharesVar, 'share');
    const unpaired = deriveAccounting(index, { assets: retype(derived, shareAsset) });
    expect(unpaired).toEqual({ accounting: [], unknowns: [] });

    const split = miniState();
    const splitUnderlying = split.iface('ISplitUnderlying');
    declarePins(split, splitUnderlying, ERC20_PINS);
    const splitShares = split.iface('ISplitShareSurface');
    const holderA = split.contract('HolderA');
    const holderB = split.contract('HolderB');
    const aVar = split.stateVar(holderA, 'underlying', 'ISplitUnderlying');
    const bVar = split.stateVar(holderB, 'shares', 'ISplitShareSurface');
    const cross = split.fn(holderA, 'pokeBoth()');
    split.rel('READS', cross.id, aVar.id, [sourceSpan('HolderA.sol', 4)]);
    split.rel('READS', cross.id, bVar.id, [sourceSpan('HolderA.sol', 5)]);

    const splitIndex = split.buildIndex();
    const splitDerived = deriveAssets(splitIndex);
    const splitShareAsset = craftAsset(bVar, 'share');
    const coHeld = deriveAccounting(splitIndex, {
      assets: retype(splitDerived, splitShareAsset),
    });
    expect(coHeld).toEqual({ accounting: [], unknowns: [] });
  });

  it('debt_collateral: Task 5-classified debt + collateral co-held with paired access yields a relation; same co-occurrence without paired access yields none', () => {
    const state = miniState();
    const debtSurface = state.iface('IDebtLedger');
    declarePins(state, debtSurface, DEBT_PINS);
    const collateralSurface = state.iface('ICollateralVault');
    declarePins(state, collateralSurface, COLLATERAL_PINS);
    const pool = state.contract('Pool');
    const debtVar = state.stateVar(pool, 'debtPosition', 'IDebtLedger');
    const collateralVar = state.stateVar(pool, 'collateralPosition', 'ICollateralVault');
    const settler = state.fn(pool, 'settle(uint256)');
    state.rel('WRITES', settler.id, debtVar.id, [sourceSpan('Pool.sol', 20)]);
    state.rel('READS', settler.id, collateralVar.id, [sourceSpan('Pool.sol', 21)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const debtAsset = assetOf(derived, debtVar);
    const collateralAsset = assetOf(derived, collateralVar);
    expect(debtAsset.asset_type).toBe('debt');
    expect(collateralAsset.asset_type).toBe('collateral');

    const result = deriveAccounting(index, { assets: derived.assets });
    expectParseable(result);
    expect(result.accounting).toHaveLength(1);
    const relation = result.accounting[0]!;
    expect(relation.relation_kind).toBe('debt_collateral');
    expect(relation.derivation).toBe('paired-storage');
    expect(relation.endpoints).toEqual(
      [debtAsset.id, collateralAsset.id].sort(compareCodeUnits),
    );
    expect(relation.basis).toContain(settler.id);

    const silent = miniState();
    const silentDebt = silent.iface('ISilentDebt');
    declarePins(silent, silentDebt, DEBT_PINS);
    const silentCollateral = silent.iface('ISilentCollateral');
    declarePins(silent, silentCollateral, COLLATERAL_PINS);
    const silentPool = silent.contract('SilentPool');
    const silentDebtVar = silent.stateVar(silentPool, 'debtPosition', 'ISilentDebt');
    const silentCollateralVar = silent.stateVar(
      silentPool,
      'collateralPosition',
      'ISilentCollateral',
    );
    const debtOnly = silent.fn(silentPool, 'borrow(uint256)');
    silent.rel('WRITES', debtOnly.id, silentDebtVar.id, [sourceSpan('SilentPool.sol', 3)]);
    const collateralOnly = silent.fn(silentPool, 'deposit(uint256)');
    silent.rel('WRITES', collateralOnly.id, silentCollateralVar.id, [
      sourceSpan('SilentPool.sol', 7),
    ]);

    const silentIndex = silent.buildIndex();
    const silentDerived = deriveAssets(silentIndex);
    const silentResult = deriveAccounting(silentIndex, { assets: silentDerived.assets });
    expect(silentResult).toEqual({ accounting: [], unknowns: [] });
  });

  it('rewards_eligible_stake: reward classification + receipt representation with distribution function pairing yields a relation', () => {
    const state = miniState();
    const rewardSurface = state.iface('IRewardSurface');
    declarePins(state, rewardSurface, REWARD_PINS);
    const receiptSurface = state.iface('IStakingReceipt');
    state.declare(receiptSurface, 'stake(uint256)');
    const staking = state.contract('StakingPool');
    const rewardVar = state.stateVar(staking, 'rewardPosition', 'IRewardSurface');
    const receiptVar = state.stateVar(staking, 'stakeReceipt', 'IStakingReceipt');
    const distributor = state.fn(staking, 'distribute(uint256)');
    state.rel('WRITES', distributor.id, rewardVar.id, [sourceSpan('StakingPool.sol', 15)]);
    state.rel('READS', distributor.id, receiptVar.id, [sourceSpan('StakingPool.sol', 16)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const rewardAsset = assetOf(derived, rewardVar);
    expect(rewardAsset.asset_type).toBe('reward');
    const receiptAsset = craftAsset(receiptVar, 'receipt');

    const result = deriveAccounting(index, { assets: retype(derived, receiptAsset) });
    expectParseable(result);
    expect(result.accounting).toHaveLength(1);
    const relation = result.accounting[0]!;
    expect(relation.relation_kind).toBe('rewards_eligible_stake');
    expect(relation.derivation).toBe('paired-storage');
    expect(relation.endpoints).toEqual(
      [rewardAsset.id, receiptAsset.id].sort(compareCodeUnits),
    );
    expect(relation.basis).toContain(distributor.id);
  });

  it('reserves_liquidity: C-classified asset + LP co-held with paired access yields a relation; native .balance evidence never models one', () => {
    const state = miniState();
    const token = state.iface('IReserveToken');
    declarePins(state, token, ERC20_PINS);
    const lpSurface = state.iface('ILiquidityToken');
    declarePins(state, lpSurface, LP_PINS);
    const amm = state.contract('AmmPair');
    const reserveVar = state.stateVar(amm, 'reserve0', 'IReserveToken');
    const lpVar = state.stateVar(amm, 'lpPosition', 'ILiquidityToken');
    const sync = state.fn(amm, 'sync(uint256)');
    state.rel('READS', sync.id, reserveVar.id, [sourceSpan('AmmPair.sol', 8)]);
    state.rel('WRITES', sync.id, lpVar.id, [sourceSpan('AmmPair.sol', 9)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const reserveAsset = assetOf(derived, reserveVar);
    const lpAsset = assetOf(derived, lpVar);
    expect(lpAsset.asset_type).toBe('lp');
    expect(lpAsset.represents_asset_id).toBe(reserveAsset.id);

    const result = deriveAccounting(index, { assets: derived.assets });
    expectParseable(result);
    expect(result.accounting).toHaveLength(1);
    const relation = result.accounting[0]!;
    expect(relation.relation_kind).toBe('reserves_liquidity');
    expect(relation.derivation).toBe('paired-storage');
    expect(relation.endpoints).toEqual(
      [reserveAsset.id, lpAsset.id].sort(compareCodeUnits),
    );

    const nativeState = miniState();
    const nativeToken = nativeState.iface('INativeHeldToken');
    declarePins(nativeState, nativeToken, ERC20_PINS);
    const payVault = nativeState.contract('PayVault');
    nativeState.fn(payVault, 'deposit()', { mutability: 'payable' });
    const balanceVar = nativeState.stateVar(payVault, 'balance', 'uint256');
    const heldVar = nativeState.stateVar(payVault, 'held', 'INativeHeldToken');
    const balancer = nativeState.fn(payVault, 'rebalance()');
    nativeState.rel('READS', balancer.id, heldVar.id, [sourceSpan('PayVault.sol', 5)]);
    nativeState.rel('WRITES', balancer.id, balanceVar.id, [sourceSpan('PayVault.sol', 6)]);

    const nativeIndex = nativeState.buildIndex();
    const nativeDerived = deriveAssets(nativeIndex);
    expect(nativeDerived.assets).toHaveLength(1);
    const nativeResult = deriveAccounting(nativeIndex, { assets: nativeDerived.assets });
    expect(nativeResult).toEqual({ accounting: [], unknowns: [] });
  });

  it('fees_protocol_user: pinned in-scope fee-interface surface over a C-classified asset with split destinations co-accessed yields an interface-structural relation', () => {
    const state = miniState();
    const feePool = state.contract('FeePool');
    declarePins(state, feePool, FEE_PINS);
    const accrue = state.fnBySignature(feePool, feePinSignature());
    const protocolDestination = state.stateVar(feePool, 'treasuryAccumulator', 'uint256');
    const userDestination = state.stateVar(feePool, 'rebateAccumulator', 'uint256');
    state.rel('WRITES', accrue.id, protocolDestination.id, [sourceSpan('FeePool.sol', 10)]);
    state.rel('WRITES', accrue.id, userDestination.id, [sourceSpan('FeePool.sol', 11)]);
    const token = state.iface('IFeeToken');
    declarePins(state, token, ERC20_PINS);
    const feeTokenVar = state.stateVar(feePool, 'feeToken', 'IFeeToken');

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const feeTokenAsset = assetOf(derived, feeTokenVar);
    expect(feeTokenAsset.asset_type).toBe('erc20');

    const result = deriveAccounting(index, { assets: derived.assets });
    expectParseable(result);
    expect(result.accounting).toHaveLength(1);
    const relation = result.accounting[0]!;
    expect(relation.relation_kind).toBe('fees_protocol_user');
    expect(relation.derivation).toBe('interface-structural');
    expect(relation.endpoints).toEqual([feeTokenAsset.id]);
    expect(relation.basis).toEqual([...relation.basis].sort(compareCodeUnits));
    expect(relation.basis).toContain(accrue.id);
    expect(relation.basis).toContain(protocolDestination.id);
    expect(relation.basis).toContain(userDestination.id);
    expect(relation.basis).toContain(feePool.id);

    const inherited = miniState();
    const feeBase = inherited.contract('FeeBase');
    declarePins(inherited, feeBase, FEE_PINS);
    const baseAccrue = inherited.fnBySignature(feeBase, feePinSignature());
    const baseProtocol = inherited.stateVar(feeBase, 'protocolLedger', 'uint256');
    const baseUser = inherited.stateVar(feeBase, 'userLedger', 'uint256');
    inherited.rel('WRITES', baseAccrue.id, baseProtocol.id, [sourceSpan('FeeBase.sol', 7)]);
    inherited.rel('WRITES', baseAccrue.id, baseUser.id, [sourceSpan('FeeBase.sol', 8)]);
    const derivedPool = inherited.contract('DerivedPool');
    inherited.rel('INHERITS', derivedPool.id, feeBase.id, [sourceSpan('DerivedPool.sol', 3)]);
    const inheritedToken = inherited.iface('IDerivedFeeToken');
    declarePins(inherited, inheritedToken, ERC20_PINS);
    const inheritedVar = inherited.stateVar(derivedPool, 'feeToken', 'IDerivedFeeToken');

    const inheritedIndex = inherited.buildIndex();
    const inheritedDerived = deriveAssets(inheritedIndex);
    const inheritedResult = deriveAccounting(inheritedIndex, {
      assets: inheritedDerived.assets,
    });
    expectParseable(inheritedResult);
    expect(inheritedResult.accounting).toHaveLength(1);
    expect(inheritedResult.accounting[0]!.relation_kind).toBe('fees_protocol_user');
    expect(inheritedResult.accounting[0]!.endpoints).toEqual([
      assetOf(inheritedDerived, inheritedVar).id,
    ]);
  });

  it('fees_protocol_user gates: absent split destinations, absent C-classified assets, and bare signatures outside the fee interface all yield no relation', () => {
    const noSplit = miniState();
    const singleDestination = noSplit.contract('SingleDestinationFee');
    declarePins(noSplit, singleDestination, FEE_PINS);
    const singleAccrue = noSplit.fnBySignature(singleDestination, feePinSignature());
    const loneVar = noSplit.stateVar(singleDestination, 'feeSink', 'uint256');
    noSplit.rel('WRITES', singleAccrue.id, loneVar.id, [sourceSpan('Single.sol', 4)]);
    const singleToken = noSplit.iface('ISingleFeeToken');
    declarePins(noSplit, singleToken, ERC20_PINS);
    noSplit.stateVar(singleDestination, 'feeToken', 'ISingleFeeToken');
    const noSplitIndex = noSplit.buildIndex();
    const noSplitResult = deriveAccounting(noSplitIndex, {
      assets: deriveAssets(noSplitIndex).assets,
    });
    expect(noSplitResult).toEqual({ accounting: [], unknowns: [] });

    const noAssets = miniState();
    const bareFee = noAssets.contract('FeeOnly');
    declarePins(noAssets, bareFee, FEE_PINS);
    const bareAccrue = noAssets.fnBySignature(bareFee, feePinSignature());
    const bareProtocol = noAssets.stateVar(bareFee, 'protocolAccumulator', 'uint256');
    const bareUser = noAssets.stateVar(bareFee, 'userAccumulator', 'uint256');
    noAssets.rel('WRITES', bareAccrue.id, bareProtocol.id, [sourceSpan('FeeOnly.sol', 5)]);
    noAssets.rel('WRITES', bareAccrue.id, bareUser.id, [sourceSpan('FeeOnly.sol', 6)]);
    const noAssetsIndex = noAssets.buildIndex();
    const noAssetsResult = deriveAccounting(noAssetsIndex, {
      assets: deriveAssets(noAssetsIndex).assets,
    });
    expect(noAssetsResult).toEqual({ accounting: [], unknowns: [] });

    const bare = miniState();
    const feeDeclaring = bare.contract('FeeDeclaring');
    declarePins(bare, feeDeclaring, FEE_PINS);
    const declaredAccrue = bare.fnBySignature(feeDeclaring, feePinSignature());
    const declaredProtocol = bare.stateVar(feeDeclaring, 'protocolAccumulator', 'uint256');
    const declaredUser = bare.stateVar(feeDeclaring, 'userAccumulator', 'uint256');
    bare.rel('WRITES', declaredAccrue.id, declaredProtocol.id, [
      sourceSpan('FeeDeclaring.sol', 5),
    ]);
    bare.rel('WRITES', declaredAccrue.id, declaredUser.id, [sourceSpan('FeeDeclaring.sol', 6)]);
    const bystander = bare.contract('Bystander');
    const bystanderToken = bare.iface('IBystanderToken');
    declarePins(bare, bystanderToken, ERC20_PINS);
    bare.stateVar(bystander, 'feeToken', 'IBystanderToken');
    const bystanderFn = bare.fn(bystander, 'chargeFee(uint256)');
    const bystanderSinkA = bare.stateVar(bystander, 'sinkA', 'uint256');
    const bystanderSinkB = bare.stateVar(bystander, 'sinkB', 'uint256');
    bare.rel('WRITES', bystanderFn.id, bystanderSinkA.id, [sourceSpan('Bystander.sol', 7)]);
    bare.rel('WRITES', bystanderFn.id, bystanderSinkB.id, [sourceSpan('Bystander.sol', 8)]);

    const bareIndex = bare.buildIndex();
    const bareResult = deriveAccounting(bareIndex, {
      assets: deriveAssets(bareIndex).assets,
    });
    expect(bareResult).toEqual({ accounting: [], unknowns: [] });
  });

  it('name-bait: fee/debt/share/reserve identifiers and non-pinned fee-like functions yield nothing', () => {
    const state = miniState();
    const trap = state.contract('NamingTrap');
    const fee = state.stateVar(trap, 'fee', 'uint256');
    const protocolFees = state.stateVar(trap, 'protocolFees', 'uint256');
    const userRebates = state.stateVar(trap, 'userRebates', 'uint256');
    const debt = state.stateVar(trap, 'debt', 'uint256');
    const shares = state.stateVar(trap, 'shares', 'uint256');
    const reserves = state.stateVar(trap, 'reserves', 'uint256');
    const charge = state.fn(trap, 'chargeFee(uint256)');
    state.rel('WRITES', charge.id, fee.id, [sourceSpan('NamingTrap.sol', 4)]);
    state.rel('WRITES', charge.id, protocolFees.id, [sourceSpan('NamingTrap.sol', 5)]);
    state.rel('WRITES', charge.id, userRebates.id, [sourceSpan('NamingTrap.sol', 6)]);
    const token = state.iface('IBaitToken');
    declarePins(state, token, ERC20_PINS);
    const baitTokenVar = state.stateVar(trap, 'collateralToken', 'IBaitToken');
    const reader = state.fn(trap, 'peekBalances()', { mutability: 'view' });
    state.rel('READS', reader.id, debt.id, [sourceSpan('NamingTrap.sol', 10)]);
    state.rel('READS', reader.id, shares.id, [sourceSpan('NamingTrap.sol', 11)]);
    state.rel('READS', reader.id, reserves.id, [sourceSpan('NamingTrap.sol', 12)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    expect(assetOf(derived, baitTokenVar).asset_type).toBe('erc20');
    const result = deriveAccounting(index, { assets: derived.assets });
    expect(result).toEqual({ accounting: [], unknowns: [] });
  });

  it('zero relations is valid output: empty state yields empty arrays with no unknown required', () => {
    const state = miniState();
    const result = deriveAccounting(state.buildIndex(), { assets: [] });
    expect(result).toEqual({ accounting: [], unknowns: [] });
  });

  it('four-way distinction: balance-like state mutations yield no accounting relation or conservation claim', () => {
    const state = miniState();
    const token = state.iface('IToken');
    declarePins(state, token, ERC20_PINS);
    const vault = state.contract('BalanceLikeVault');
    const totalAssets = state.stateVar(vault, 'totalAssets', 'uint256');
    const totalShares = state.stateVar(vault, 'totalShares', 'uint256');
    const heldVar = state.stateVar(vault, 'held', 'IToken');
    const sync = state.fn(vault, 'syncSupply()');
    state.rel('READS', sync.id, totalAssets.id, [sourceSpan('BalanceLikeVault.sol', 6)]);
    state.rel('WRITES', sync.id, totalShares.id, [sourceSpan('BalanceLikeVault.sol', 7)]);
    state.rel('READS', sync.id, heldVar.id, [sourceSpan('BalanceLikeVault.sol', 8)]);

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    expect(derived.assets).toHaveLength(1);
    const result = deriveAccounting(index, { assets: derived.assets });
    expect(result).toEqual({ accounting: [], unknowns: [] });
  });

  it('determinism: repeated derivation is byte-equal, schema-valid, sorted, and read-only', () => {
    const state = miniState();
    const underlying = state.iface('IDetUnderlying');
    declarePins(state, underlying, ERC20_PINS);
    const shareSurface = state.iface('IDetShareSurface');
    const vault = state.contract('DetVault');
    const underlyingVar = state.stateVar(vault, 'underlying', 'IDetUnderlying');
    const sharesVar = state.stateVar(vault, 'shares', 'IDetShareSurface');
    const rebalancer = state.fn(vault, 'rebalance(uint256)');
    state.rel('READS', rebalancer.id, underlyingVar.id, [sourceSpan('DetVault.sol', 3)]);
    state.rel('WRITES', rebalancer.id, sharesVar.id, [sourceSpan('DetVault.sol', 4)]);
    const feePool = state.contract('DetFeePool');
    declarePins(state, feePool, FEE_PINS);
    const accrue = state.fnBySignature(feePool, feePinSignature());
    const protocolDestination = state.stateVar(feePool, 'protocolAccumulator', 'uint256');
    const userDestination = state.stateVar(feePool, 'userAccumulator', 'uint256');
    state.rel('WRITES', accrue.id, protocolDestination.id, [sourceSpan('DetFeePool.sol', 9)]);
    state.rel('WRITES', accrue.id, userDestination.id, [sourceSpan('DetFeePool.sol', 10)]);
    const feeToken = state.iface('IDetFeeToken');
    declarePins(state, feeToken, ERC20_PINS);
    state.stateVar(feePool, 'feeToken', 'IDetFeeToken');
    const bait = state.contract('DetBait');
    state.stateVar(bait, 'fee', 'uint256');
    state.fn(bait, 'chargeFee(uint256)');

    const index = state.buildIndex();
    const derived = deriveAssets(index);
    const shareAsset = craftAsset(sharesVar, 'share');
    const assets = retype(derived, shareAsset);
    const stateBefore = JSON.stringify(index.input.state);
    const first = deriveAccounting(index, { assets });
    const second = deriveAccounting(index, { assets });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(index.input.state)).toBe(stateBefore);
    expectParseable(first);
    const ids = first.accounting.map((relation) => relation.id);
    expect(ids).toEqual([...ids].sort(compareCodeUnits));
    expect(first.accounting.map((relation) => relation.relation_kind).sort()).toEqual([
      'assets_shares',
      'fees_protocol_user',
    ]);
    for (const relation of first.accounting) {
      expect(relation.endpoints).toEqual([...relation.endpoints].sort(compareCodeUnits));
      expect(relation.basis).toEqual([...relation.basis].sort(compareCodeUnits));
    }
    expect(first.unknowns).toEqual([]);
  });
});
