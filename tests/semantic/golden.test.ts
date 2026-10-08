import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildFidelityInputs,
  buildSemanticCorpus,
  type CorpusName,
} from '../../fixtures/semantic.js';
import type { SemanticInput } from '../../src/semantic/evidence.js';
import { buildEvidenceIndex } from '../../src/semantic/evidence.js';
import { deriveAccounting } from '../../src/semantic/accounting.js';
import { deriveAuthority } from '../../src/semantic/authority.js';
import { deriveAssets } from '../../src/semantic/custody.js';
import { deriveLadder } from '../../src/semantic/ladder.js';
import {
  finalizeSemanticModel,
  serializeSemanticModel,
} from '../../src/semantic/report.js';
import { deriveTransitions } from '../../src/semantic/transitions.js';
import { deriveTrust } from '../../src/semantic/trust.js';
import { validateSemanticModel } from '../../src/semantic/validate.js';
import type { SemanticModel } from '../../src/semantic/model.js';

const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TMP = tmpdir();
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';
// Leakage regexes copied from tests/scope/golden.test.ts:23-24 (Phase 3 pattern).
const ISO_DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const TIMESTAMP_KEY = /timestamp|generated_at|date/i;
const FORBIDDEN_VOCAB = [
  'is vulnerable',
  'vulnerable',
  'exploit',
  'severity',
  'critical',
  'finding',
  'attack',
  'poc',
  'confirmed',
];

const CORPUS_NAMES: CorpusName[] = [
  'vault',
  'lending',
  'staking',
  'amm',
  'oracle-dependent',
  'upgradeable-proxy',
  'role-based',
  'callback-token',
  'ambiguous',
];

// Full derivation orchestration mirroring src/semantic/analyze.ts (intake →
// B–G → finalize → validate), over hand-built in-process states instead of a
// compiled AnalysisResult. contracts: [] — no Layer-A producer exists in
// Tasks 1–12 (DEFERRED GAP, Task 13 adjudication 1); trust observations are
// threaded (IMPLEMENTATION DEFECT fix, f2c10e2).
function runGolden(input: SemanticInput): { model: SemanticModel; serialized: string } {
  const index = buildEvidenceIndex(input);
  const transitions = deriveTransitions(index);
  const assets = deriveAssets(index);
  const accounting = deriveAccounting(index, { assets: assets.assets });
  const authority = deriveAuthority(index, transitions.transitions);
  const trust = deriveTrust(index, transitions.transitions);
  const ladder = deriveLadder(index, {
    transitions: transitions.transitions,
    assets: assets.assets,
    custody: assets.custody,
    claims: assets.claims,
    accounting: accounting.accounting,
    authority: authority.authority,
    trust: {
      dependencies: trust.dependencies,
      capabilities: trust.capabilities,
      assumptions: trust.assumptions,
      observations: trust.observations,
    },
  });
  const unknowns = [
    ...transitions.unknowns,
    ...assets.unknowns,
    ...accounting.unknowns,
    ...authority.unknowns,
    ...trust.unknowns,
    ...ladder.unknowns,
  ];
  const degradation: string[] = input.meta.fidelity === 'syntactic' ? ['syntactic_fidelity'] : [];
  let status: 'COMPLETE' | 'PARTIAL' = degradation.length > 0 ? 'PARTIAL' : 'COMPLETE';
  if (status === 'COMPLETE') {
    const flagged =
      unknowns.some(
        (entry) =>
          entry.reason === 'dropped_file' ||
          entry.reason === 'unsupported_assembly' ||
          entry.reason === 'syntactic_fidelity',
      ) || transitions.transitions.some((record) => record.fidelity_flags.length > 0);
    if (flagged) status = 'PARTIAL';
  }
  const finalized = finalizeSemanticModel({
    schema_version: 'semantic-model/v1',
    status,
    input: {
      fidelity: input.meta.fidelity,
      state_output_hash: index.stateHash,
      file_count: input.meta.fileCount,
      ...(degradation.length > 0 ? { degradation } : {}),
    },
    binding: {},
    contracts: [],
    transitions: transitions.transitions,
    assets: assets.assets,
    custody: assets.custody,
    claims: assets.claims,
    accounting: accounting.accounting,
    authority: authority.authority,
    trust: { dependencies: trust.dependencies, capabilities: trust.capabilities },
    epistemic: {
      observations: [...ladder.observations, ...trust.observations],
      assumptions: ladder.assumptions,
      hypotheses: ladder.hypotheses,
      invariants: ladder.invariants,
    },
    unknowns,
  });
  const model = validateSemanticModel(finalized, { state: input.state });
  return { model, serialized: serializeSemanticModel(model) };
}

function goldenPath(name: CorpusName): string {
  return join(GOLDEN_DIR, `${name}.json`);
}

function missingGolden(name: CorpusName): Error {
  return new Error(
    `missing golden for corpus "${name}" at ${goldenPath(name)} — run UPDATE_GOLDEN=1 to freeze it`,
  );
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function stateVarId(input: SemanticInput, name: string): string {
  const record = input.state.state_variables.find((candidate) => candidate.name === name);
  if (record === undefined) throw new Error(`no state variable named ${name}`);
  return record.id;
}

function functionId(input: SemanticInput, name: string): string {
  const matches = input.state.functions.filter((candidate) => candidate.name === name);
  if (matches.length !== 1) throw new Error(`expected exactly one function named ${name}`);
  return matches[0]!.id;
}

describe('semantic golden corpus (spec §16)', () => {
  it('each corpus matches its frozen golden byte-for-byte', () => {
    for (const name of CORPUS_NAMES) {
      const { serialized } = runGolden(buildSemanticCorpus(name));
      const path = goldenPath(name);
      if (UPDATE_GOLDEN) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, serialized, 'utf8');
        continue;
      }
      if (!existsSync(path)) throw missingGolden(name);
      const frozen = readFileSync(path, 'utf8').replace(/\r/g, '');
      expect(serialized, `corpus "${name}" drifted from its frozen golden`).toBe(frozen);
    }
  });

  it('each corpus derives byte-identically on fresh rebuild (double-run identity)', () => {
    for (const name of CORPUS_NAMES) {
      const first = runGolden(buildSemanticCorpus(name));
      const second = runGolden(buildSemanticCorpus(name));
      expect(second.serialized, `corpus "${name}" is not byte-stable across runs`).toBe(
        first.serialized,
      );
      expect(second.model.semantic_hash).toBe(first.model.semantic_hash);
    }
  });

  it('each corpus is insertion-order independent (reversed state arrays)', () => {
    for (const name of CORPUS_NAMES) {
      const input = buildSemanticCorpus(name);
      const reverse = <T>(items: readonly T[]): T[] => [...items].reverse();
      const reversed: SemanticInput = {
        state: {
          ...input.state,
          contracts: reverse(input.state.contracts),
          functions: reverse(input.state.functions),
          state_variables: reverse(input.state.state_variables),
          relationships: reverse(input.state.relationships),
          facts: reverse(input.state.facts),
        },
        issues: input.issues,
        meta: input.meta,
      };
      expect(runGolden(reversed).serialized, `corpus "${name}" depends on insertion order`).toBe(
        runGolden(input).serialized,
      );
    }
  });

  it('no golden contains timestamps, absolute paths, or backslashes', () => {
    for (const name of CORPUS_NAMES) {
      const path = goldenPath(name);
      if (!existsSync(path)) throw missingGolden(name);
      const raw = readFileSync(path, 'utf8');
      expect(raw, `golden "${name}" must not carry an ISO timestamp`).not.toMatch(ISO_DATE);
      expect(raw, `golden "${name}" must not contain the temp dir`).not.toContain(TMP);
      expect(raw, `golden "${name}" must not contain the repository root`).not.toContain(REPO_ROOT);
      const model = JSON.parse(raw) as SemanticModel;
      for (const key of collectKeys(model)) {
        expect(key, `golden "${name}" key ${key} looks timestamp-shaped`).not.toMatch(
          TIMESTAMP_KEY,
        );
      }
      for (const value of collectStrings(model)) {
        expect(value.startsWith('/'), `golden "${name}" value ${value} is absolute`).toBe(false);
        expect(value.includes('\\'), `golden "${name}" value ${value} contains a backslash`).toBe(
          false,
        );
      }
    }
  });

  it('no golden carries finding language (forbidden vocabulary)', () => {
    for (const name of CORPUS_NAMES) {
      const path = goldenPath(name);
      if (!existsSync(path)) throw missingGolden(name);
      const model = JSON.parse(readFileSync(path, 'utf8')) as SemanticModel;
      for (const value of collectStrings(model)) {
        for (const word of FORBIDDEN_VOCAB) {
          expect(
            value.toLowerCase().includes(word),
            `golden "${name}" value carries forbidden vocabulary '${word}': ${value}`,
          ).toBe(false);
        }
      }
    }
  });

  it('every frozen golden passes validateSemanticModel (SINV-1..14)', () => {
    for (const name of CORPUS_NAMES) {
      const path = goldenPath(name);
      if (!existsSync(path)) throw missingGolden(name);
      const model = JSON.parse(readFileSync(path, 'utf8')) as SemanticModel;
      const input = buildSemanticCorpus(name);
      expect(() => validateSemanticModel(model, { state: input.state }), `golden "${name}" fails validation`).not.toThrow();
      const { model: fresh } = runGolden(input);
      expect(fresh.semantic_hash).toBe(model.semantic_hash);
    }
  });

  it('vault: erc20 asset + custody prove; shares relation absent; hints stay unknown', () => {
    const input = buildSemanticCorpus('vault');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    expect(model.contracts).toEqual([]);
    const erc20 = model.assets.filter((asset) => asset.asset_type === 'erc20');
    expect(erc20.length).toBeGreaterThanOrEqual(1);
    const assetVar = stateVarId(input, 'asset');
    const assetRecord = model.assets.find((asset) => asset.basis.includes(assetVar));
    expect(assetRecord?.asset_type).toBe('erc20');
    expect(assetRecord?.evidence_class).toBe('E2');
    const vaultContract = input.state.contracts.find((c) => c.name === 'Vault')!.id;
    expect(
      model.custody.some(
        (record) => record.asset_id === assetRecord!.id && record.holder_contract_id === vaultContract,
      ),
    ).toBe(true);
    // Share surface is unclassifiable (OD-8 share pins omitted): no
    // assets_shares relation is emitted rather than fabricated.
    expect(model.accounting.filter((rel) => rel.relation_kind === 'assets_shares')).toEqual([]);
    // Out-of-scope hint: plain-address treasury yields no asset record.
    expect(model.assets.some((asset) => asset.basis.includes(stateVarId(input, 'treasury')))).toBe(
      false,
    );
    expect(
      model.unknowns.some(
        (entry) => entry.record_ref === stateVarId(input, 'treasury') && entry.reason === 'no_evidence',
      ),
    ).toBe(true);
  });

  it('lending: debt+collateral relation requires paired access; control pair yields none', () => {
    const input = buildSemanticCorpus('lending');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    const debtAsset = model.assets.find((asset) => asset.asset_type === 'debt');
    const collateralAsset = model.assets.find((asset) => asset.asset_type === 'collateral');
    expect(debtAsset).toBeDefined();
    expect(collateralAsset).toBeDefined();
    expect(debtAsset?.represents_asset_id).toBeDefined();
    expect(collateralAsset?.represents_asset_id).toBeDefined();
    const pair = model.accounting.filter((rel) => rel.relation_kind === 'debt_collateral');
    expect(pair).toHaveLength(1);
    expect(pair[0]!.derivation).toBe('paired-storage');
    expect(pair[0]!.endpoints).toContain(debtAsset!.id);
    expect(pair[0]!.endpoints).toContain(collateralAsset!.id);
    // Control pair (same classes, no shared accessor) yields no relation.
    const controlDebt = model.assets.find((asset) => asset.basis.includes(stateVarId(input, 'controlDebt')));
    const controlCollateral = model.assets.find((asset) =>
      asset.basis.includes(stateVarId(input, 'controlCollateral')),
    );
    expect(controlDebt?.asset_type).toBe('debt');
    expect(controlCollateral?.asset_type).toBe('collateral');
    expect(
      model.accounting.some(
        (rel) => rel.endpoints.includes(controlDebt!.id) || rel.endpoints.includes(controlCollateral!.id),
      ),
    ).toBe(false);
    // Fee split surface yields fees_protocol_user.
    expect(model.accounting.some((rel) => rel.relation_kind === 'fees_protocol_user')).toBe(true);
    // Naming traps: plain-uint fee/destination vars yield no asset records.
    expect(
      model.assets.some((asset) => asset.basis.includes(stateVarId(input, 'protocolFees'))),
    ).toBe(false);
    // Pauser surface classifies nothing (role pins never classify authority).
    const pauser = model.authority.find((chain) => chain.links.function_id === functionId(input, 'setPaused'));
    expect(pauser?.authority_kind).toBe('unknown');
  });

  it('staking: reward classifies only via REWARD_PINS; receipt relation absent', () => {
    const input = buildSemanticCorpus('staking');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    const reward = model.assets.find((asset) => asset.basis.includes(stateVarId(input, 'rewardPosition')));
    expect(reward?.asset_type).toBe('reward');
    const stake = model.assets.find((asset) => asset.basis.includes(stateVarId(input, 'stakePosition')));
    expect(stake?.asset_type).toBe('unknown');
    // Receipt representations are unpinnable (OD-8): no rewards_eligible_stake.
    expect(
      model.accounting.filter((rel) => rel.relation_kind === 'rewards_eligible_stake'),
    ).toEqual([]);
    // Keeper/relayer surfaces classify nothing without role-typed storage.
    for (const name of ['notifyRewardAmount', 'syncRewards']) {
      const chain = model.authority.find((c) => c.links.function_id === functionId(input, name));
      expect(chain?.authority_kind, `${name} must stay unknown`).toBe('unknown');
    }
  });

  it('amm: named router yields unknown-typed dependency; unresolved target yields no record', () => {
    const input = buildSemanticCorpus('amm');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    const routerDep = model.trust.dependencies.find((dep) => dep.name === 'router');
    expect(routerDep).toBeDefined();
    expect(routerDep?.dependency_type).toBe('unknown');
    const routerCaps = model.trust.capabilities.filter((cap) => cap.dependency_ref === routerDep!.id);
    expect(routerCaps.length).toBeGreaterThanOrEqual(1);
    for (const cap of routerCaps) {
      expect(cap.failure_semantics).toBe('unknown');
      const asm = model.epistemic.assumptions.find((candidate) => candidate.id === cap.trust_assumption_ref);
      expect(asm?.status).toBe('OPEN');
    }
    // Unresolved indirect call: E3 effect + ledger entry, but no dependency record.
    const fallbackFn = functionId(input, 'routeViaFallback');
    const fallbackTransition = model.transitions.find((t) => t.function_id === fallbackFn);
    expect(
      fallbackTransition?.external_effects.some(
        (effect) => effect.call_kind === 'indirect' && effect.target_evidence === 'E3' && effect.target_ref === undefined,
      ),
    ).toBe(true);
    expect(
      model.unknowns.some((entry) => entry.reason === 'unresolved_call'),
    ).toBe(true);
    expect(
      model.trust.dependencies.some((dep) => dep.basis.some((ref) => ref === fallbackFn)),
    ).toBe(false);
    // Reserves + LP pair with paired access.
    expect(
      model.accounting.some((rel) => rel.relation_kind === 'reserves_liquidity'),
    ).toBe(true);
  });

  it('oracle-dependent: observed oracle capability carries OPEN assumption; failure stays unknown', () => {
    const input = buildSemanticCorpus('oracle-dependent');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    const oracleDep = model.trust.dependencies.find((dep) => dep.dependency_type === 'oracle');
    expect(oracleDep).toBeDefined();
    const observed = model.trust.capabilities.filter(
      (cap) => cap.dependency_ref === oracleDep!.id && cap.direction === 'observed',
    );
    expect(observed.length).toBeGreaterThanOrEqual(1);
    for (const cap of observed) {
      expect(cap.failure_semantics).toBe('unknown');
      const asm = model.epistemic.assumptions.find((candidate) => candidate.id === cap.trust_assumption_ref);
      expect(asm).toBeDefined();
      expect(asm?.status).toBe('OPEN');
      expect(asm?.confidence.level).toBe('INFERRED');
    }
    expect(
      model.unknowns.some(
        (entry) => entry.field === 'failure_semantics' && entry.reason === 'no_evidence',
      ),
    ).toBe(true);
    // Push-style consumed capability present.
    expect(model.trust.capabilities.some((cap) => cap.direction === 'consumed')).toBe(true);
    // Fake oracle: oracle-named plain-address var with reads but no oracle
    // interface yields no dependency record.
    const staleFn = functionId(input, 'readStale');
    expect(
      model.trust.dependencies.some((dep) => dep.basis.some((ref) => ref === staleFn)),
    ).toBe(false);
  });

  it('upgradeable-proxy: no proxy record from naming; delegatecall effect typed; upgrader unknown', () => {
    const input = buildSemanticCorpus('upgradeable-proxy');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    // No Layer-A producer exists: proxy kind is unprovable, never named.
    expect(model.contracts).toEqual([]);
    const forwardFn = functionId(input, 'forwardCall');
    const forward = model.transitions.find((t) => t.function_id === forwardFn);
    expect(
      forward?.external_effects.some(
        (effect) => effect.call_kind === 'delegatecall' && effect.target_evidence === 'E3',
      ),
    ).toBe(true);
    const upgradeChain = model.authority.find((chain) => chain.links.function_id === functionId(input, 'upgradeTo'));
    expect(upgradeChain?.authority_kind).toBe('unknown');
    expect(upgradeChain?.links.impact).toBe('unknown');
    const forwardChain = model.authority.find((chain) => chain.links.function_id === forwardFn);
    expect(forwardChain?.links.impact).toBe('delegatecall');
  });

  it('role-based: pinned role storage classifies; modifier names alone do not', () => {
    const input = buildSemanticCorpus('role-based');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    expect(
      model.authority.find((chain) => chain.links.function_id === functionId(input, 'transferOwnership'))?.authority_kind,
    ).toBe('owner');
    expect(
      model.authority.find((chain) => chain.links.function_id === functionId(input, 'submitProposal'))?.authority_kind,
    ).toBe('governance');
    // Fake setAdmin: pin-exact signature but no IAdmin-typed storage ⇒ unknown.
    expect(
      model.authority.find((chain) => chain.links.function_id === functionId(input, 'setAdmin'))?.authority_kind,
    ).toBe('unknown');
    // onlyOwner modifier without touching owner storage ⇒ unknown.
    expect(
      model.authority.find((chain) => chain.links.function_id === functionId(input, 'withdrawFunds'))?.authority_kind,
    ).toBe('unknown');
  });

  it('callback-token: no asset movements; consumed capabilities present', () => {
    const input = buildSemanticCorpus('callback-token');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    for (const transition of model.transitions) {
      expect(transition.asset_movements, `${transition.function_id} must not move assets`).toEqual([]);
    }
    expect(model.trust.capabilities.some((cap) => cap.direction === 'consumed')).toBe(true);
    // Movement-signature call from a contract holding no classified asset.
    expect(
      model.unknowns.some((entry) => entry.field === 'asset_ref' && entry.reason === 'no_evidence'),
    ).toBe(true);
    expect(model.assets).toEqual([]);
  });

  it('ambiguous: zero non-unknown classifications; unknown index populated', () => {
    const input = buildSemanticCorpus('ambiguous');
    const { model } = runGolden(input);
    expect(model.status).toBe('COMPLETE');
    const classifiedAssets = model.assets.filter((asset) => asset.asset_type !== 'unknown');
    const classifiedAuthority = model.authority.filter((chain) => chain.authority_kind !== 'unknown');
    const classifiedDeps = model.trust.dependencies.filter((dep) => dep.dependency_type !== 'unknown');
    expect([...classifiedAssets, ...classifiedAuthority, ...classifiedDeps]).toEqual([]);
    expect(model.unknowns.length).toBeGreaterThan(0);
    expect(
      model.unknowns.some(
        (entry) => entry.record_ref === stateVarId(input, 'collateral') && entry.reason === 'no_evidence',
      ),
    ).toBe(true);
    // Transfer event without token surface: observation only, no asset/movement.
    const mintFn = functionId(input, 'mint');
    const mintTransition = model.transitions.find((t) => t.function_id === mintFn);
    expect(mintTransition?.post_state_observations.length).toBeGreaterThan(0);
    expect(mintTransition?.asset_movements).toEqual([]);
    // Partial ERC20 surface (transfer+approve only) stays unknown.
    const partial = model.assets.find((asset) => asset.basis.includes(stateVarId(input, 'tokenRef')));
    expect(partial?.asset_type).toBe('unknown');
  });

  it('epistemic ladder is preserved: forced confidences, resolvable acyclic based_on, no findings', () => {
    for (const name of CORPUS_NAMES) {
      const input = buildSemanticCorpus(name);
      const { model } = runGolden(input);
      for (const obs of model.epistemic.observations) {
        expect(obs.confidence.level).toBe('DERIVED');
        expect(obs.based_on.length + obs.provenance.length).toBeGreaterThan(0);
      }
      for (const asm of model.epistemic.assumptions) {
        expect(asm.confidence.level).toBe('INFERRED');
        expect(asm.status).toBe('OPEN');
        expect(asm.based_on.length).toBeGreaterThanOrEqual(1);
      }
      for (const hyp of model.epistemic.hypotheses) {
        expect(hyp.confidence.level).toBe('SPECULATIVE');
      }
      // Invariants/hypotheses are empty in v1 (invariant-emission wiring is a
      // DEFERRED GAP; empty output is spec-valid per §11.2.5).
      expect(model.epistemic.invariants).toEqual([]);
      expect(model.epistemic.hypotheses).toEqual([]);
    }
  });

  it('fidelity degradation: syntactic fallback is PARTIAL with flags and notes', () => {
    const { syntactic } = buildFidelityInputs();
    const { model } = runGolden(syntactic);
    expect(model.status).toBe('PARTIAL');
    expect(model.input.fidelity).toBe('syntactic');
    expect(model.input.degradation).toContain('syntactic_fidelity');
    expect(model.transitions.length).toBeGreaterThan(0);
    for (const transition of model.transitions) {
      expect(transition.fidelity_flags).toContain('syntactic');
    }
  });

  it('fidelity degradation: dropped file yields no transition plus dropped_file unknown', () => {
    const { droppedFile } = buildFidelityInputs();
    const { model } = runGolden(droppedFile);
    expect(model.status).toBe('PARTIAL');
    expect(model.transitions).toEqual([]);
    expect(
      model.unknowns.some(
        (entry) => entry.field === 'transition' && entry.reason === 'dropped_file',
      ),
    ).toBe(true);
    for (const chain of model.authority) {
      expect(chain.links.transition_id).toBeUndefined();
    }
  });

  it('fidelity degradation: assembly-bearing function is flagged and unlinked', () => {
    const { assembly } = buildFidelityInputs();
    const { model } = runGolden(assembly);
    expect(model.status).toBe('PARTIAL');
    expect(model.transitions).toHaveLength(1);
    expect(model.transitions[0]!.fidelity_flags).toContain('assembly_skipped');
    expect(
      model.unknowns.some(
        (entry) => entry.reason === 'unsupported_assembly',
      ),
    ).toBe(true);
    for (const chain of model.authority) {
      expect(chain.links.transition_id).toBeUndefined();
    }
  });

  it('pin removal fails closed: dropping one ERC20 pin degrades the vault asset to unknown', () => {
    const input = buildSemanticCorpus('vault');
    const pruned = {
      ...input.state,
      functions: input.state.functions.filter((fn) => fn.signature !== 'balanceOf(address)'),
    };
    const { model } = runGolden({ state: pruned, issues: input.issues, meta: input.meta });
    const assetRecord = model.assets.find((asset) => asset.basis.includes(stateVarId(input, 'asset')));
    expect(assetRecord?.asset_type).toBe('unknown');
  });

  it('removed reward evidence fails closed: dropping earned degrades the staking reward to unknown', () => {
    const input = buildSemanticCorpus('staking');
    const pruned = {
      ...input.state,
      functions: input.state.functions.filter((fn) => fn.signature !== 'earned(address)'),
    };
    const { model } = runGolden({ state: pruned, issues: input.issues, meta: input.meta });
    const reward = model.assets.find((asset) => asset.basis.includes(stateVarId(input, 'rewardPosition')));
    expect(reward?.asset_type).toBe('unknown');
  });
});
