// OD-8 (spec §7 C3, §9 E6, §10 F1): pin lists are grounded ONLY in corpus ABI
// observations (tests/semantic/pins.test.ts evidence gate asserts every entry
// was observed in >=1 corpus analysis). Every entry cites its corpus source.
//
// Classes/patterns intentionally OMITTED (no unambiguous corpus evidence;
// OD-8 forbids inventing lists, so classification stays 'unknown'):
//   - share: spec §7's share family (`convertToShares(uint256)`-family +
//     `asset()`) is declared nowhere in the corpus; the vault corpus's
//     `deposit(uint256)` / `totalAssets()` / `previewDeposit(uint256)` surface
//     does not pin down an exact share subset (ambiguous ⇒ omitted).
//   - spec §7's debt family `totalDebt()`-family exists only as public
//     state-variable getters, which the extractor does not surface as
//     functions (Task 15 report §7.2); DEBT_PINS below pins the observable
//     debt-ledger write surface instead of inventing getter signatures.
//   - receipt: no brief-declared list; staking receipt surface
//     (`receiptOf`/`totalReceipts`) is likewise getter-only (unobservable).
//   - default_admin, guardian, multisig, timelock: no in-scope interface or
//     contract declares/inherits a surface for these role kinds (OD-8 E6).

export const ERC20_PINS: readonly string[] = [
  'transfer(address,uint256)',
  'approve(address,uint256)',
  'balanceOf(address)',
  'transferFrom(address,address,uint256)',
];

// OD-8 debt surface: the two explicit lending-corpus functions that write the
// debt ledger (`debtOf`/`totalDebt`); getters of `totalDebt()` are unobservable.
export const DEBT_PINS: readonly string[] = [
  'borrow(uint256)', // OD-8: derived from fixtures/solidity/semantics/lending ABI, debt surface
  'repay(uint256)', // OD-8: derived from fixtures/solidity/semantics/lending ABI, debt surface
];

// OD-8 collateral surface: the paired collateral deposit/withdraw functions of
// the lending corpus (spec §7 C3 delegates the collateral subset to OD-8).
export const COLLATERAL_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/lending ABI, collateral surface
  'depositCollateral(uint256)',
  // OD-8: derived from fixtures/solidity/semantics/lending ABI, collateral surface
  'withdrawCollateral(uint256)',
];

// OD-8 reward surface: spec §7 C3's named `earned(address)`-family, observed
// as an explicit function declaration in the staking corpus.
export const REWARD_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/staking ABI, reward surface
  'earned(address)',
];

// OD-8 LP surface: the amm corpus's paired LP mint/burn functions over
// reserves (spec §7 C3's `mint(uint256)`-family is corpus-unobservable except
// as the supply-less adversarial `mint` trap, which is not LP evidence).
export const LP_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/amm ABI, LP surface
  'addLiquidity(uint256,uint256)',
  // OD-8: derived from fixtures/solidity/semantics/amm ABI, LP surface
  'removeLiquidity(uint256)',
];

// OD-8 fee-split surface (spec §8 fees_protocol_user): corpus-wide analysis
// (all 9 corpora) observed exactly one fee-split function — LendingPool's
// accrueFees, which writes two split destinations (protocolFees + userRebates).
// No other corpus declares any fee-like signature; ambiguous ⇒ nothing added.
export const FEE_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/lending ABI, fee-split surface
  'accrueFees(uint256)',
];

// OD-8 E6 role pins: derived ONLY from in-scope role interfaces/contracts
// actually declared/inherited in the corpus. Every entry corpus-cited.
// Omitted role kinds (no corpus evidence): default_admin, guardian, multisig, timelock.

// Owner role: IOwnable interface (roles/IOwnable.sol) + AdminVault owner storage
export const OWNER_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/roles/IOwnable ABI, owner surface
  'owner()',
  // OD-8: derived from fixtures/solidity/semantics/roles/IOwnable ABI, owner surface
  'transferOwnership(address)',
];

// Admin role: IAdmin interface (roles/IAdmin.sol) + AdminVault implementation
export const ADMIN_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/roles/IAdmin ABI, admin surface
  'setAdmin(address,bool)',
  // OD-8: derived from fixtures/solidity/semantics/roles/IAdmin ABI, admin surface
  'isAdmin(address)',
];

// Governance role: IGovernance interface (roles/IGovernance.sol) + Governance implementation
export const GOVERNANCE_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/roles/IGovernance ABI, governance surface
  'submitProposal(bytes32)',
  // OD-8: derived from fixtures/solidity/semantics/roles/IGovernance ABI, governance surface
  'executeProposal(bytes32)',
];

// Upgrader role: Proxy contract (proxy/Proxy.sol) with upgrader storage + onlyUpgrader modifier
export const UPGRADER_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/proxy/Proxy ABI, upgrader surface
  'upgradeTo(address)',
];

// Pauser role: LendingPool contract (lending/LendingPool.sol) with pauser storage + onlyPauser modifier
export const PAUSER_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/lending/LendingPool ABI, pauser surface
  'setPaused(bool)',
];

// Keeper role: StakingPool contract (staking/StakingPool.sol) with keeper storage + onlyKeeper modifier
export const KEEPER_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/staking/StakingPool ABI, keeper surface
  'notifyRewardAmount(uint256)',
];

// Relayer role: StakingPool contract (staking/StakingPool.sol) with relayer storage + onlyRelayer modifier
export const RELAYER_PINS: readonly string[] = [
  // OD-8: derived from fixtures/solidity/semantics/staking/StakingPool ABI, relayer surface
  'syncRewards(uint256)',
];

// No corpus evidence for these role kinds — intentionally omitted per OD-8:
// DEFAULT_ADMIN_PINS, GUARDIAN_PINS, MULTISIG_PINS, TIMELOCK_PINS
