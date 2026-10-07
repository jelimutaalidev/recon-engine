// OD-8 (spec §7 C3): pin lists are grounded ONLY in Task 15 corpus ABI
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
