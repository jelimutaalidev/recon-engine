// Task 13 golden corpus fixtures (spec §16.1–§16.2.3).
//
// Hand-built in-process ReconStates — NO filesystem walk (§16.2.3). Each
// builder returns a SemanticInput (state + issues + meta) exercising one
// corpus row. The DERIVATION (Layers B–G) is what the goldens pin; fixtures
// supply the minimal evidence each rule requires, and adversarial traps
// supply evidence that must NOT classify.
//
// Global fixture rules (see Task 13 report for rationale):
//   R1. Every public/external function with address/bytes-containing params
//       carries >=1 relationship with file/line provenance. Otherwise the
//       Layer-F callback-surface observation cannot validate and the model
//       honestly fails closed (proven by real-corpus probe in report §4).
//   R2. Every function with parameters or relationships carries >=1 fact
//       (READS/WRITES/EMITS/CALLS) with provenance, so ladder observations
//       have fact roots. Param-less interface accessors (IOwnable.owner) are
//       the sole evidence-free functions: with no address/bytes params they
//       emit no trust drafts, and with no facts they emit no ladder
//       observations — both vacuously valid.
//   R3. Contract names are unique per state (C1 exact-one type resolution).
//   R4. At most one IMPLEMENTS edge per contract and at most one incoming
//       CALLS edge per function (first-wins lookups stay deterministic under
//       reversed insertion).
//   R5. Pin surfaces live on implementation contracts with real
//       relationships; standalone interface contracts declare only param-less
//       functions (evidence-free interface functions fail closed per R1).
//   R6. Bare relative filenames, fixed created_at, no absolute paths.

import type { Contract } from '../src/domain/contract.js';
import { createContract } from '../src/domain/contract.js';
import type { Mutability, Visibility } from '../src/domain/enums.js';
import type { SolidityFunction } from '../src/domain/function.js';
import { createFunction } from '../src/domain/function.js';
import type { StateVariable } from '../src/domain/state-variable.js';
import { createStateVariable } from '../src/domain/state-variable.js';
import type { Fact } from '../src/epistemic/fact.js';
import { createFact } from '../src/epistemic/fact.js';
import type { ProvenanceInput } from '../src/epistemic/provenance.js';
import type { ReconIssue } from '../src/recon/issues.js';
import { createReconState } from '../src/recon-state/state.js';
import type { ReconState } from '../src/recon-state/schema.js';
import type { Relationship } from '../src/relationships/relationship.js';
import { createRelationship } from '../src/relationships/relationship.js';
import type { RelationshipType } from '../src/relationships/types.js';
import type { SemanticInput } from '../src/semantic/evidence.js';

export type CorpusName =
  | 'vault'
  | 'lending'
  | 'staking'
  | 'amm'
  | 'oracle-dependent'
  | 'upgradeable-proxy'
  | 'role-based'
  | 'callback-token'
  | 'ambiguous';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

interface FnOptions {
  visibility?: Visibility;
  mutability?: Mutability;
  modifiers?: string[];
  parameters?: { name?: string; type: string }[];
  source?: string;
}

class Cx {
  contracts: Contract[] = [];
  functions: SolidityFunction[] = [];
  stateVariables: StateVariable[] = [];
  relationships: Relationship[] = [];
  facts: Fact[] = [];

  contract(name: string, contractType: Contract['contract_type'] = 'core'): Contract {
    const record = createContract({ name, contract_type: contractType });
    this.contracts.push(record);
    return record;
  }

  fn(contract: Contract, name: string, options: FnOptions = {}): SolidityFunction {
    const record = createFunction({
      contract_id: contract.id,
      name,
      visibility: options.visibility ?? 'external',
      mutability: options.mutability ?? 'nonpayable',
      modifiers: options.modifiers ?? [],
      parameters: options.parameters ?? [],
      ...(options.source !== undefined ? { source: options.source } : {}),
    });
    this.functions.push(record);
    return record;
  }

  svar(
    contract: Contract,
    name: string,
    type: string,
    visibility: 'public' | 'internal' | 'private' = 'public',
  ): StateVariable {
    const record = createStateVariable({ contract_id: contract.id, name, type, visibility });
    this.stateVariables.push(record);
    return record;
  }

  rel(
    type: RelationshipType,
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
      created_at: CREATED_AT,
    });
    this.relationships.push(record);
    return record;
  }

  fact(
    subjectId: string,
    predicate: RelationshipType,
    provenance: ProvenanceInput[],
    objectId?: string,
    value?: string,
  ): Fact {
    const record = createFact({
      subject_id: subjectId,
      predicate,
      ...(objectId !== undefined ? { object_id: objectId } : {}),
      ...(value !== undefined ? { value } : {}),
      provenance,
      created_at: CREATED_AT,
    });
    this.facts.push(record);
    return record;
  }

  emit(subject: SolidityFunction, signature: string, provenance: ProvenanceInput[]): Fact {
    return this.fact(subject.id, 'EMITS', provenance, undefined, signature);
  }

  marker(
    subject: SolidityFunction,
    predicate: 'CALLS' | 'DELEGATES_TO',
    value: string,
    provenance: ProvenanceInput[],
  ): Fact {
    return this.fact(subject.id, predicate, provenance, undefined, value);
  }

  state(): ReconState {
    return createReconState({
      contracts: this.contracts,
      functions: this.functions,
      state_variables: this.stateVariables,
      relationships: this.relationships,
      facts: this.facts,
    });
  }

  input(options: { fidelity?: 'semantic' | 'syntactic'; fileCount: number; issues?: ReconIssue[] }): SemanticInput {
    return {
      state: this.state(),
      issues: options.issues ?? [],
      meta: { fidelity: options.fidelity ?? 'semantic', fileCount: options.fileCount },
    };
  }
}

// Full ERC20 pin surface (OD-8 ERC20_PINS) on an in-scope token contract with
// genuine ledger relationships. Shared by vault/lending/amm.
function addErc20(cx: Cx, token: Contract, file: string, base: number): void {
  const balances = cx.svar(token, 'balances', 'mapping(address=>uint256)');
  const allowances = cx.svar(token, 'allowances', 'mapping(address=>mapping(address=>uint256))');
  const transfer = cx.fn(
    token,
    'transfer',
    {
      parameters: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      source: `${file}:${base}-${base + 6}`,
    },
  );
  cx.rel('WRITES', transfer.id, balances.id, [span(file, base + 2)]);
  cx.emit(transfer, 'Transfer(address,address,uint256)', [span(file, base + 3)]);
  const approve = cx.fn(
    token,
    'approve',
    {
      parameters: [
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      source: `${file}:${base + 8}-${base + 14}`,
    },
  );
  cx.rel('WRITES', approve.id, allowances.id, [span(file, base + 10)]);
  cx.emit(approve, 'Approval(address,address,uint256)', [span(file, base + 11)]);
  const transferFrom = cx.fn(
    token,
    'transferFrom',
    {
      parameters: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      source: `${file}:${base + 16}-${base + 24}`,
    },
  );
  cx.rel('READS', transferFrom.id, allowances.id, [span(file, base + 18)]);
  cx.rel('WRITES', transferFrom.id, balances.id, [span(file, base + 19)]);
  cx.emit(transferFrom, 'Transfer(address,address,uint256)', [span(file, base + 20)]);
  const balanceOf = cx.fn(
    token,
    'balanceOf',
    {
      mutability: 'view',
      parameters: [{ name: 'account', type: 'address' }],
      source: `${file}:${base + 26}-${base + 30}`,
    },
  );
  cx.rel('READS', balanceOf.id, balances.id, [span(file, base + 28)]);
  cx.fact(balanceOf.id, 'READS', [span(file, base + 28)], balances.id);
}

function buildVault(): SemanticInput {
  const cx = new Cx();
  // EVIDENCE: in-scope ERC20 token (full pin set) + share-ledger token whose
  // surface matches no pin family (stays 'unknown').
  const cash = cx.contract('CashToken', 'token');
  addErc20(cx, cash, 'CashToken.sol', 10);
  const share = cx.contract('ShareToken', 'token');
  const shareLedger = cx.svar(share, 'shareLedger', 'mapping(address=>uint256)');
  const mintShares = cx.fn(
    share,
    'mintShares',
    {
      parameters: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      source: 'ShareToken.sol:10-16',
    },
  );
  cx.rel('WRITES', mintShares.id, shareLedger.id, [span('ShareToken.sol', 12)]);
  cx.emit(mintShares, 'SharesMinted(address,uint256)', [span('ShareToken.sol', 13)]);
  const burnShares = cx.fn(share, 'burnShares', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'ShareToken.sol:18-24',
  });
  cx.rel('WRITES', burnShares.id, shareLedger.id, [span('ShareToken.sol', 20)]);
  cx.emit(burnShares, 'SharesBurned(uint256)', [span('ShareToken.sol', 21)]);
  // DERIVED SEMANTICS: CashToken asset classifies erc20; ShareToken asset
  // stays unknown (no share pins exist per OD-8) so no assets_shares relation
  // is fabricated. treasury is an out-of-scope hint (plain address).
  const vault = cx.contract('Vault', 'vault');
  const asset = cx.svar(vault, 'asset', 'CashToken');
  const shareBalance = cx.svar(vault, 'shareBalance', 'ShareToken');
  cx.svar(vault, 'treasury', 'address');
  const deposit = cx.fn(vault, 'deposit', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'Vault.sol:10-18',
  });
  cx.rel('READS', deposit.id, asset.id, [span('Vault.sol', 12)]);
  cx.rel('WRITES', deposit.id, shareBalance.id, [span('Vault.sol', 13)]);
  cx.fact(deposit.id, 'WRITES', [span('Vault.sol', 13)], shareBalance.id);
  const withdraw = cx.fn(vault, 'withdraw', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'Vault.sol:20-28',
  });
  cx.rel('READS', withdraw.id, shareBalance.id, [span('Vault.sol', 22)]);
  cx.rel('WRITES', withdraw.id, shareBalance.id, [span('Vault.sol', 23)]);
  cx.emit(withdraw, 'Withdrawn(uint256)', [span('Vault.sol', 24)]);
  return cx.input({ fileCount: 3 });
}

function buildLending(): SemanticInput {
  const cx = new Cx();
  const cash = cx.contract('CashToken', 'token');
  addErc20(cx, cash, 'CashToken.sol', 10);
  // EVIDENCE: debt/collateral pin surfaces on in-scope tokens with ledgers.
  const debt = cx.contract('DebtToken', 'token');
  const debtLedger = cx.svar(debt, 'debtLedger', 'mapping(address=>uint256)');
  const borrow = cx.fn(debt, 'borrow', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'DebtToken.sol:10-16',
  });
  cx.rel('WRITES', borrow.id, debtLedger.id, [span('DebtToken.sol', 12)]);
  cx.emit(borrow, 'Borrowed(uint256)', [span('DebtToken.sol', 13)]);
  const repay = cx.fn(debt, 'repay', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'DebtToken.sol:18-24',
  });
  cx.rel('WRITES', repay.id, debtLedger.id, [span('DebtToken.sol', 20)]);
  cx.emit(repay, 'Repaid(uint256)', [span('DebtToken.sol', 21)]);
  const collateral = cx.contract('CollateralToken', 'token');
  const collateralLedger = cx.svar(collateral, 'collateralLedger', 'mapping(address=>uint256)');
  const depositCollateral = cx.fn(collateral, 'depositCollateral', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'CollateralToken.sol:10-16',
  });
  cx.rel('WRITES', depositCollateral.id, collateralLedger.id, [span('CollateralToken.sol', 12)]);
  cx.emit(depositCollateral, 'CollateralDeposited(uint256)', [span('CollateralToken.sol', 13)]);
  const withdrawCollateral = cx.fn(collateral, 'withdrawCollateral', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'CollateralToken.sol:18-24',
  });
  cx.rel('WRITES', withdrawCollateral.id, collateralLedger.id, [span('CollateralToken.sol', 20)]);
  cx.emit(withdrawCollateral, 'CollateralWithdrawn(uint256)', [span('CollateralToken.sol', 21)]);
  // DERIVED SEMANTICS: paired access (borrowFor touches both) yields exactly
  // one debt_collateral relation; the unpaired control pair yields none.
  // protocolFees/userRebates are naming traps (plain uint, no records).
  const pool = cx.contract('LendingPool', 'lending');
  cx.svar(pool, 'underlying', 'CashToken');
  const debtPosition = cx.svar(pool, 'debtPosition', 'DebtToken');
  const collateralPosition = cx.svar(pool, 'collateralPosition', 'CollateralToken');
  cx.svar(pool, 'protocolFees', 'uint256');
  cx.svar(pool, 'userRebates', 'uint256');
  cx.svar(pool, 'paused', 'bool');
  const borrowFor = cx.fn(pool, 'borrowFor', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'LendingPool.sol:10-20',
  });
  cx.rel('READS', borrowFor.id, collateralPosition.id, [span('LendingPool.sol', 12)]);
  cx.rel('WRITES', borrowFor.id, debtPosition.id, [span('LendingPool.sol', 13)]);
  cx.emit(borrowFor, 'BorrowFor(uint256)', [span('LendingPool.sol', 14)]);
  const accrueFees = cx.fn(pool, 'accrueFees', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'LendingPool.sol:22-32',
  });
  const protocolFees = cx.stateVariables.find((v) => v.name === 'protocolFees')!;
  const userRebates = cx.stateVariables.find((v) => v.name === 'userRebates')!;
  cx.rel('WRITES', accrueFees.id, protocolFees.id, [span('LendingPool.sol', 24)]);
  cx.rel('WRITES', accrueFees.id, userRebates.id, [span('LendingPool.sol', 25)]);
  cx.emit(accrueFees, 'FeesAccrued(uint256)', [span('LendingPool.sol', 26)]);
  const getDebt = cx.fn(pool, 'getDebt', {
    mutability: 'view',
    source: 'LendingPool.sol:34-38',
  });
  cx.rel('READS', getDebt.id, debtPosition.id, [span('LendingPool.sol', 36)]);
  cx.fact(getDebt.id, 'READS', [span('LendingPool.sol', 36)], debtPosition.id);
  const getCollateral = cx.fn(pool, 'getCollateral', {
    mutability: 'view',
    source: 'LendingPool.sol:40-44',
  });
  cx.rel('READS', getCollateral.id, collateralPosition.id, [span('LendingPool.sol', 42)]);
  cx.fact(getCollateral.id, 'READS', [span('LendingPool.sol', 42)], collateralPosition.id);
  const setPaused = cx.fn(pool, 'setPaused', {
    modifiers: ['onlyPauser'],
    parameters: [{ name: 'flag', type: 'bool' }],
    source: 'LendingPool.sol:46-52',
  });
  const paused = cx.stateVariables.find((v) => v.name === 'paused')!;
  cx.rel('WRITES', setPaused.id, paused.id, [span('LendingPool.sol', 48)]);
  cx.emit(setPaused, 'PausedSet(bool)', [span('LendingPool.sol', 49)]);
  const control = cx.contract('ControlPool', 'core');
  cx.svar(control, 'controlDebt', 'DebtToken');
  cx.svar(control, 'controlCollateral', 'CollateralToken');
  return cx.input({ fileCount: 4 });
}

function buildStaking(): SemanticInput {
  const cx = new Cx();
  // EVIDENCE: reward surface via REWARD_PINS; stake surface matches no pins.
  const reward = cx.contract('RewardToken', 'token');
  const rewardsLedger = cx.svar(reward, 'rewardsLedger', 'mapping(address=>uint256)');
  const earned = cx.fn(reward, 'earned', {
    mutability: 'view',
    parameters: [{ name: 'account', type: 'address' }],
    source: 'RewardToken.sol:10-16',
  });
  cx.rel('READS', earned.id, rewardsLedger.id, [span('RewardToken.sol', 12)]);
  cx.fact(earned.id, 'READS', [span('RewardToken.sol', 12)], rewardsLedger.id);
  const stake = cx.contract('StakeToken', 'token');
  const stakeLedger = cx.svar(stake, 'stakeLedger', 'mapping(address=>uint256)');
  const stakeFn = cx.fn(stake, 'stake', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'StakeToken.sol:10-16',
  });
  cx.rel('WRITES', stakeFn.id, stakeLedger.id, [span('StakeToken.sol', 12)]);
  cx.emit(stakeFn, 'Staked(uint256)', [span('StakeToken.sol', 13)]);
  const unstake = cx.fn(stake, 'unstake', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'StakeToken.sol:18-24',
  });
  cx.rel('WRITES', unstake.id, stakeLedger.id, [span('StakeToken.sol', 20)]);
  cx.emit(unstake, 'Unstaked(uint256)', [span('StakeToken.sol', 21)]);
  // DERIVED SEMANTICS: reward classifies, stake stays unknown; no
  // rewards_eligible_stake (receipt unpinnable); keeper/relayer unknown.
  const pool = cx.contract('StakingPool', 'staking');
  const rewardPosition = cx.svar(pool, 'rewardPosition', 'RewardToken');
  const stakePosition = cx.svar(pool, 'stakePosition', 'StakeToken');
  const stakeForPool = cx.fn(pool, 'stakeFor', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'StakingPool.sol:10-20',
  });
  cx.rel('READS', stakeForPool.id, rewardPosition.id, [span('StakingPool.sol', 12)]);
  cx.rel('WRITES', stakeForPool.id, stakePosition.id, [span('StakingPool.sol', 13)]);
  cx.emit(stakeForPool, 'StakeFor(uint256)', [span('StakingPool.sol', 14)]);
  const notifyRewardAmount = cx.fn(pool, 'notifyRewardAmount', {
    modifiers: ['onlyKeeper'],
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'StakingPool.sol:22-30',
  });
  cx.rel('WRITES', notifyRewardAmount.id, rewardPosition.id, [span('StakingPool.sol', 24)]);
  cx.emit(notifyRewardAmount, 'RewardNotified(uint256)', [span('StakingPool.sol', 25)]);
  const syncRewards = cx.fn(pool, 'syncRewards', {
    modifiers: ['onlyRelayer'],
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'StakingPool.sol:32-40',
  });
  cx.rel('WRITES', syncRewards.id, rewardPosition.id, [span('StakingPool.sol', 34)]);
  cx.emit(syncRewards, 'RewardsSynced(uint256)', [span('StakingPool.sol', 35)]);
  const getEarned = cx.fn(pool, 'getEarned', {
    mutability: 'view',
    source: 'StakingPool.sol:42-46',
  });
  cx.rel('READS', getEarned.id, rewardPosition.id, [span('StakingPool.sol', 44)]);
  cx.fact(getEarned.id, 'READS', [span('StakingPool.sol', 44)], rewardPosition.id);
  return cx.input({ fileCount: 3 });
}

function buildAmm(): SemanticInput {
  const cx = new Cx();
  const reserve = cx.contract('ReserveToken', 'token');
  addErc20(cx, reserve, 'ReserveToken.sol', 10);
  // EVIDENCE: LP pin surface; out-of-scope router as a named address var;
  // unresolved indirect call as a marker fact.
  const lp = cx.contract('LPToken', 'token');
  const lpSupply = cx.svar(lp, 'lpSupply', 'uint256');
  const addLiquidity = cx.fn(lp, 'addLiquidity', {
    parameters: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
    ],
    source: 'LPToken.sol:10-18',
  });
  cx.rel('WRITES', addLiquidity.id, lpSupply.id, [span('LPToken.sol', 12)]);
  cx.emit(addLiquidity, 'LiquidityAdded(uint256,uint256)', [span('LPToken.sol', 13)]);
  const removeLiquidity = cx.fn(lp, 'removeLiquidity', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'LPToken.sol:20-26',
  });
  cx.rel('WRITES', removeLiquidity.id, lpSupply.id, [span('LPToken.sol', 22)]);
  cx.emit(removeLiquidity, 'LiquidityRemoved(uint256)', [span('LPToken.sol', 23)]);
  const pair = cx.contract('AMMPair', 'amm');
  const reserveVar = cx.svar(pair, 'reserve', 'ReserveToken');
  const liquidity = cx.svar(pair, 'liquidity', 'LPToken');
  const router = cx.svar(pair, 'router', 'address');
  const swap = cx.fn(pair, 'swap', {
    parameters: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOut', type: 'uint256' },
    ],
    source: 'AMMPair.sol:10-24',
  });
  cx.rel('READS', swap.id, reserveVar.id, [span('AMMPair.sol', 12)]);
  cx.rel('READS', swap.id, liquidity.id, [span('AMMPair.sol', 13)]);
  cx.rel('WRITES', swap.id, liquidity.id, [span('AMMPair.sol', 14)]);
  cx.rel('CALLS', swap.id, router.id, [span('AMMPair.sol', 15)], { call_kind: 'external' });
  cx.emit(swap, 'Swapped(uint256,uint256)', [span('AMMPair.sol', 16)]);
  const getReserves = cx.fn(pair, 'getReserves', {
    mutability: 'view',
    source: 'AMMPair.sol:26-30',
  });
  cx.rel('READS', getReserves.id, reserveVar.id, [span('AMMPair.sol', 28)]);
  cx.fact(getReserves.id, 'READS', [span('AMMPair.sol', 28)], reserveVar.id);
  const routeViaFallback = cx.fn(pair, 'routeViaFallback', { source: 'AMMPair.sol:32-38' });
  cx.rel('READS', routeViaFallback.id, reserveVar.id, [span('AMMPair.sol', 34)]);
  cx.marker(routeViaFallback, 'CALLS', 'unresolved-indirect-call', [span('AMMPair.sol', 35)]);
  return cx.input({ fileCount: 3 });
}

function buildOracleDependent(): SemanticInput {
  const cx = new Cx();
  // EVIDENCE: in-scope oracle contract with pin surface; hook interface for
  // the push-style consumed capability (empty per R5); oracle-named bait var.
  const hook = cx.contract('IPriceHook', 'interface');
  const oracle = cx.contract('PriceOracle', 'oracle');
  cx.rel('IMPLEMENTS', oracle.id, hook.id, [span('PriceOracle.sol', 1)]);
  const priceFeedValue = cx.svar(oracle, 'priceFeedValue', 'int256');
  const feedTimestamp = cx.svar(oracle, 'feedTimestamp', 'uint256');
  const latestPrice = cx.fn(oracle, 'latestPrice', {
    mutability: 'view',
    parameters: [{ name: 'asset', type: 'address' }],
    source: 'PriceOracle.sol:10-16',
  });
  cx.rel('READS', latestPrice.id, priceFeedValue.id, [span('PriceOracle.sol', 12)]);
  cx.fact(latestPrice.id, 'READS', [span('PriceOracle.sol', 12)], priceFeedValue.id);
  const latestTimestamp = cx.fn(oracle, 'latestTimestamp', {
    mutability: 'view',
    parameters: [{ name: 'asset', type: 'address' }],
    source: 'PriceOracle.sol:18-24',
  });
  cx.rel('READS', latestTimestamp.id, feedTimestamp.id, [span('PriceOracle.sol', 20)]);
  cx.fact(latestTimestamp.id, 'READS', [span('PriceOracle.sol', 20)], feedTimestamp.id);
  // DERIVED SEMANTICS: observed oracle capability + OPEN assumption; failure
  // stays unknown; staleOracle bait yields nothing.
  const consumer = cx.contract('PriceConsumer', 'core');
  const oracleVar = cx.svar(consumer, 'oracle', 'PriceOracle');
  cx.svar(consumer, 'updater', 'address');
  const pushedPrice = cx.svar(consumer, 'pushedPrice', 'mapping(address=>int256)');
  const pushedAt = cx.svar(consumer, 'pushedAt', 'mapping(address=>uint256)');
  const staleOracle = cx.svar(consumer, 'staleOracle', 'address');
  const readPrice = cx.fn(consumer, 'readPrice', {
    mutability: 'view',
    parameters: [{ name: 'asset', type: 'address' }],
    source: 'PriceConsumer.sol:10-18',
  });
  cx.rel('READS', readPrice.id, oracleVar.id, [span('PriceConsumer.sol', 12)]);
  cx.rel('CALLS', readPrice.id, latestPrice.id, [span('PriceConsumer.sol', 13)], {
    call_kind: 'external',
  });
  cx.fact(readPrice.id, 'READS', [span('PriceConsumer.sol', 12)], oracleVar.id);
  const readFreshness = cx.fn(consumer, 'readFreshness', {
    mutability: 'view',
    parameters: [{ name: 'asset', type: 'address' }],
    source: 'PriceConsumer.sol:20-28',
  });
  cx.rel('READS', readFreshness.id, oracleVar.id, [span('PriceConsumer.sol', 22)]);
  cx.rel('CALLS', readFreshness.id, latestTimestamp.id, [span('PriceConsumer.sol', 23)], {
    call_kind: 'external',
  });
  cx.fact(readFreshness.id, 'READS', [span('PriceConsumer.sol', 22)], oracleVar.id);
  const pushPrice = cx.fn(consumer, 'pushPrice', {
    modifiers: ['onlyUpdater'],
    parameters: [
      { name: 'asset', type: 'address' },
      { name: 'price', type: 'int256' },
      { name: 'updatedAt', type: 'uint256' },
    ],
    source: 'PriceConsumer.sol:30-42',
  });
  cx.rel('WRITES', pushPrice.id, pushedPrice.id, [span('PriceConsumer.sol', 32)]);
  cx.rel('WRITES', pushPrice.id, pushedAt.id, [span('PriceConsumer.sol', 33)]);
  cx.emit(pushPrice, 'PricePushed(address,int256,uint256)', [span('PriceConsumer.sol', 34)]);
  const readStale = cx.fn(consumer, 'readStale', {
    mutability: 'view',
    source: 'PriceConsumer.sol:44-48',
  });
  cx.rel('READS', readStale.id, staleOracle.id, [span('PriceConsumer.sol', 46)]);
  cx.fact(readStale.id, 'READS', [span('PriceConsumer.sol', 46)], staleOracle.id);
  return cx.input({ fileCount: 2 });
}

function buildUpgradeableProxy(): SemanticInput {
  const cx = new Cx();
  const implementation = cx.contract('Implementation', 'implementation');
  const version = cx.svar(implementation, 'version', 'uint256');
  const initialize = cx.fn(implementation, 'initialize', { source: 'Implementation.sol:10-16' });
  cx.rel('WRITES', initialize.id, version.id, [span('Implementation.sol', 12)]);
  cx.emit(initialize, 'Initialized(uint256)', [span('Implementation.sol', 13)]);
  const getVersion = cx.fn(implementation, 'getVersion', {
    mutability: 'view',
    source: 'Implementation.sol:18-22',
  });
  cx.rel('READS', getVersion.id, version.id, [span('Implementation.sol', 20)]);
  cx.fact(getVersion.id, 'READS', [span('Implementation.sol', 20)], version.id);
  // EVIDENCE: delegatecall marker (DELEGATES_TO-class evidence lives in the
  // marker fact); upgrader surface present but role storage absent, so the
  // authority stays unknown. No Layer-A producer exists: contracts stays [].
  const proxy = cx.contract('Proxy', 'proxy');
  cx.svar(proxy, 'implementation', 'address');
  cx.svar(proxy, 'upgrader', 'address');
  const upgradeTo = cx.fn(proxy, 'upgradeTo', {
    modifiers: ['onlyUpgrader'],
    parameters: [{ name: 'newImpl', type: 'address' }],
    source: 'Proxy.sol:10-18',
  });
  const implementationVar = cx.stateVariables.find((v) => v.name === 'implementation')!;
  cx.rel('WRITES', upgradeTo.id, implementationVar.id, [span('Proxy.sol', 12)]);
  cx.emit(upgradeTo, 'Upgraded(address)', [span('Proxy.sol', 13)]);
  const forwardCall = cx.fn(proxy, 'forwardCall', { source: 'Proxy.sol:20-28' });
  cx.rel('READS', forwardCall.id, implementationVar.id, [span('Proxy.sol', 22)]);
  cx.marker(forwardCall, 'DELEGATES_TO', 'unresolved-delegatecall', [span('Proxy.sol', 23)]);
  return cx.input({ fileCount: 2 });
}

function buildRoleBased(): SemanticInput {
  const cx = new Cx();
  // EVIDENCE: owner interface in scope (param-less per R5); admin/governance
  // kinds rest on role-typed storage only. setAdmin is pin-exact
  // (setAdmin(address,bool)) but touches plain-address storage: the fake.
  const ownable = cx.contract('IOwnable', 'interface');
  cx.fn(ownable, 'owner', {
    mutability: 'view',
    source: 'IOwnable.sol:5-5',
  });
  const vault = cx.contract('AdminVault', 'core');
  const owner = cx.svar(vault, 'owner', 'IOwnable');
  const admin = cx.svar(vault, 'admin', 'address');
  const vaultBalance = cx.svar(vault, 'vaultBalance', 'uint256');
  const transferOwnership = cx.fn(vault, 'transferOwnership', {
    parameters: [{ name: 'newOwner', type: 'address' }],
    source: 'AdminVault.sol:10-18',
  });
  cx.rel('WRITES', transferOwnership.id, owner.id, [span('AdminVault.sol', 12)]);
  cx.emit(transferOwnership, 'OwnershipTransferred(address)', [span('AdminVault.sol', 13)]);
  const getOwner = cx.fn(vault, 'getOwner', {
    mutability: 'view',
    source: 'AdminVault.sol:20-24',
  });
  cx.rel('READS', getOwner.id, owner.id, [span('AdminVault.sol', 22)]);
  cx.fact(getOwner.id, 'READS', [span('AdminVault.sol', 22)], owner.id);
  const setAdmin = cx.fn(vault, 'setAdmin', {
    parameters: [
      { name: 'newAdmin', type: 'address' },
      { name: 'enabled', type: 'bool' },
    ],
    source: 'AdminVault.sol:26-34',
  });
  cx.rel('WRITES', setAdmin.id, admin.id, [span('AdminVault.sol', 28)]);
  cx.emit(setAdmin, 'AdminSet(address,bool)', [span('AdminVault.sol', 29)]);
  const withdrawFunds = cx.fn(vault, 'withdrawFunds', {
    modifiers: ['onlyOwner'],
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'AdminVault.sol:36-44',
  });
  cx.rel('WRITES', withdrawFunds.id, vaultBalance.id, [span('AdminVault.sol', 38)]);
  cx.emit(withdrawFunds, 'Withdrawn(uint256)', [span('AdminVault.sol', 39)]);
  const governance = cx.contract('Governance', 'governance');
  const governor = cx.svar(governance, 'governor', 'IGovernance');
  const proposals = cx.svar(governance, 'proposals', 'mapping(bytes32=>bool)');
  const submitProposal = cx.fn(governance, 'submitProposal', {
    parameters: [{ name: 'proposal', type: 'bytes32' }],
    source: 'Governance.sol:10-20',
  });
  cx.rel('READS', submitProposal.id, governor.id, [span('Governance.sol', 12)]);
  cx.rel('WRITES', submitProposal.id, proposals.id, [span('Governance.sol', 13)]);
  cx.emit(submitProposal, 'ProposalSubmitted(bytes32)', [span('Governance.sol', 14)]);
  const executeProposal = cx.fn(governance, 'executeProposal', {
    parameters: [{ name: 'proposal', type: 'bytes32' }],
    source: 'Governance.sol:22-32',
  });
  cx.rel('READS', executeProposal.id, governor.id, [span('Governance.sol', 24)]);
  cx.rel('WRITES', executeProposal.id, proposals.id, [span('Governance.sol', 25)]);
  cx.emit(executeProposal, 'ProposalExecuted(bytes32)', [span('Governance.sol', 26)]);
  return cx.input({ fileCount: 3 });
}

function buildCallbackToken(): SemanticInput {
  const cx = new Cx();
  // EVIDENCE: hook interface implemented by a foreign contract (consumed
  // direction); movement-signature call from an asset-less contract (C7).
  const receiverIface = cx.contract('IERC721Receiver', 'interface');
  const receiver = cx.contract('Receiver', 'core');
  cx.rel('IMPLEMENTS', receiver.id, receiverIface.id, [span('Receiver.sol', 1)]);
  cx.svar(receiver, 'sink', 'uint256');
  const nft = cx.contract('SimpleNFT', 'core');
  const owners = cx.svar(nft, 'owners', 'mapping(uint256=>address)');
  const transferFrom = cx.fn(nft, 'transferFrom', {
    parameters: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    source: 'SimpleNFT.sol:10-20',
  });
  cx.rel('READS', transferFrom.id, owners.id, [span('SimpleNFT.sol', 12)]);
  cx.rel('WRITES', transferFrom.id, owners.id, [span('SimpleNFT.sol', 13)]);
  cx.emit(transferFrom, 'Transfer(address,address,uint256)', [span('SimpleNFT.sol', 14)]);
  // DERIVED SEMANTICS: movements stay empty (B4/C7 never wired); the
  // transferFrom call from asset-less NFTVault yields a C7 unknown entry.
  const vault = cx.contract('NFTVault', 'core');
  const heldTokenId = cx.svar(vault, 'heldTokenId', 'uint256');
  cx.svar(vault, 'operator', 'address');
  const onReceive = cx.fn(vault, 'onERC721Received', {
    parameters: [
      { name: 'operator', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    source: 'NFTVault.sol:10-20',
  });
  cx.rel('WRITES', onReceive.id, heldTokenId.id, [span('NFTVault.sol', 12)]);
  cx.emit(onReceive, 'Received(address,address,uint256,bytes)', [span('NFTVault.sol', 13)]);
  const withdrawTo = cx.fn(vault, 'withdrawTo', {
    parameters: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    source: 'NFTVault.sol:22-34',
  });
  cx.rel('READS', withdrawTo.id, heldTokenId.id, [span('NFTVault.sol', 24)]);
  cx.rel('WRITES', withdrawTo.id, heldTokenId.id, [span('NFTVault.sol', 25)]);
  cx.rel('CALLS', withdrawTo.id, transferFrom.id, [span('NFTVault.sol', 26)], {
    call_kind: 'external',
  });
  cx.emit(withdrawTo, 'Withdrawn(address,uint256)', [span('NFTVault.sol', 27)]);
  return cx.input({ fileCount: 4 });
}

function buildAmbiguous(): SemanticInput {
  const cx = new Cx();
  // EVIDENCE: every name-bait signal with no backing — plain-typed vars,
  // modifier without role storage, oracle-named reads, Transfer event without
  // token surface, mint without supply effect, partial ERC20 subset.
  const partial = cx.contract('PartialToken', 'core');
  const ledger = cx.svar(partial, 'ledger', 'mapping(address=>uint256)');
  const partialTransfer = cx.fn(partial, 'transfer', {
    parameters: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    source: 'PartialToken.sol:8-14',
  });
  cx.rel('WRITES', partialTransfer.id, ledger.id, [span('PartialToken.sol', 10)]);
  cx.emit(partialTransfer, 'Transfer(address,uint256)', [span('PartialToken.sol', 11)]);
  const partialApprove = cx.fn(partial, 'approve', {
    parameters: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    source: 'PartialToken.sol:16-22',
  });
  cx.rel('WRITES', partialApprove.id, ledger.id, [span('PartialToken.sol', 18)]);
  cx.emit(partialApprove, 'Approval(address,uint256)', [span('PartialToken.sol', 19)]);
  // DERIVED SEMANTICS: zero non-unknown classifications; unknowns populated.
  const trap = cx.contract('Trap', 'core');
  cx.svar(trap, 'collateral', 'uint256');
  cx.svar(trap, 'treasury', 'address');
  const oracleVar = cx.svar(trap, 'oracle', 'address');
  const ownerVar = cx.svar(trap, 'owner', 'address');
  const totalMinted = cx.svar(trap, 'totalMinted', 'uint256');
  cx.svar(trap, 'tokenRef', 'PartialToken');
  const mint = cx.fn(trap, 'mint', {
    parameters: [{ name: 'amount', type: 'uint256' }],
    source: 'Trap.sol:10-16',
  });
  cx.rel('WRITES', mint.id, totalMinted.id, [span('Trap.sol', 12)]);
  cx.emit(mint, 'Transfer(address,address,uint256)', [span('Trap.sol', 13)]);
  const setAdmin = cx.fn(trap, 'setAdmin', {
    modifiers: ['onlyOwner'],
    parameters: [{ name: 'newAdmin', type: 'address' }],
    source: 'Trap.sol:18-26',
  });
  cx.rel('WRITES', setAdmin.id, ownerVar.id, [span('Trap.sol', 20)]);
  cx.emit(setAdmin, 'AdminSet(address)', [span('Trap.sol', 21)]);
  const collateralVar = cx.stateVariables.find((v) => v.name === 'collateral')!;
  const getCollateral = cx.fn(trap, 'getCollateral', {
    mutability: 'view',
    source: 'Trap.sol:28-32',
  });
  cx.rel('READS', getCollateral.id, collateralVar.id, [span('Trap.sol', 30)]);
  cx.fact(getCollateral.id, 'READS', [span('Trap.sol', 30)], collateralVar.id);
  const readOracle = cx.fn(trap, 'readOracle', {
    mutability: 'view',
    source: 'Trap.sol:34-38',
  });
  cx.rel('READS', readOracle.id, oracleVar.id, [span('Trap.sol', 36)]);
  cx.fact(readOracle.id, 'READS', [span('Trap.sol', 36)], oracleVar.id);
  const baitTransfer = cx.fn(trap, 'transfer', {
    parameters: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    source: 'Trap.sol:40-48',
  });
  cx.rel('WRITES', baitTransfer.id, collateralVar.id, [span('Trap.sol', 42)]);
  cx.emit(baitTransfer, 'Transfer(address,uint256)', [span('Trap.sol', 43)]);
  return cx.input({ fileCount: 1 });
}

export function buildSemanticCorpus(name: CorpusName): SemanticInput {
  switch (name) {
    case 'vault':
      return buildVault();
    case 'lending':
      return buildLending();
    case 'staking':
      return buildStaking();
    case 'amm':
      return buildAmm();
    case 'oracle-dependent':
      return buildOracleDependent();
    case 'upgradeable-proxy':
      return buildUpgradeableProxy();
    case 'role-based':
      return buildRoleBased();
    case 'callback-token':
      return buildCallbackToken();
    case 'ambiguous':
      return buildAmbiguous();
  }
}

export interface FidelityInputs {
  syntactic: SemanticInput;
  droppedFile: SemanticInput;
  assembly: SemanticInput;
}

// Isolated fidelity-degradation states (spec §16.2.3) feeding SINV-13/B6
// golden assertions. Additive inputs only — no rule changes (IC-2: the
// dropped-file branch is exercised with input data, not manufactured logic).
export function buildFidelityInputs(): FidelityInputs {
  const syntacticCx = new Cx();
  const solo = syntacticCx.contract('Solo', 'core');
  const x = syntacticCx.svar(solo, 'x', 'uint256');
  const go = syntacticCx.fn(solo, 'go', { source: 'Solo.sol:5-12' });
  syntacticCx.rel('WRITES', go.id, x.id, [span('Solo.sol', 7)]);
  syntacticCx.emit(go, 'Went()', [span('Solo.sol', 8)]);
  const syntactic = syntacticCx.input({ fidelity: 'syntactic', fileCount: 1 });

  const droppedCx = new Cx();
  const drop = droppedCx.contract('Drop', 'core');
  const y = droppedCx.svar(drop, 'y', 'uint256');
  const gone = droppedCx.fn(drop, 'gone', { source: 'Drop.sol:5-12' });
  droppedCx.rel('WRITES', gone.id, y.id, [span('Drop.sol', 7)]);
  droppedCx.emit(gone, 'Gone()', [span('Drop.sol', 8)]);
  const droppedFile = droppedCx.input({
    fileCount: 1,
    issues: [
      {
        severity: 'RECOVERABLE',
        code: 'compilation_failed',
        message: 'dropping Drop.sol: syntax errors prevent parsing',
        file: 'Drop.sol',
      },
    ],
  });

  const asmCx = new Cx();
  const asm = asmCx.contract('Asm', 'core');
  const z = asmCx.svar(asm, 'z', 'uint256');
  const hot = asmCx.fn(asm, 'hot', { source: 'Asm.sol:5-12' });
  asmCx.rel('WRITES', hot.id, z.id, [span('Asm.sol', 7)]);
  asmCx.emit(hot, 'Hot()', [span('Asm.sol', 8)]);
  const assembly = asmCx.input({
    fileCount: 1,
    issues: [
      {
        severity: 'UNSUPPORTED',
        code: 'unsupported_assembly',
        message: 'assembly block skipped in Asm.sol',
        file: 'Asm.sol',
      },
    ],
  });

  return { syntactic, droppedFile, assembly };
}
