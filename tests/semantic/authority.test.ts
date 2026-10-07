import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../src/domain/contract.js';
import type { Mutability, Visibility, StateVisibility } from '../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../src/domain/state-variable.js';
import { createFact, type Fact } from '../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import { createRelationship, type Relationship } from '../../src/relationships/relationship.js';
import { createReconState } from '../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../src/semantic/evidence.js';
import { deriveTransitions, type TransitionDerivation } from '../../src/semantic/transitions.js';
import {
  AuthorityChainSchema,
  UnknownIndexEntrySchema,
  type AuthorityChain,
  type UnknownIndexEntry,
} from '../../src/semantic/model.js';
import { deriveAuthority } from '../../src/semantic/authority.js';
import {
  OWNER_PINS,
  ADMIN_PINS,
  GOVERNANCE_PINS,
  UPGRADER_PINS,
  PAUSER_PINS,
  KEEPER_PINS,
  RELAYER_PINS,
} from '../../src/semantic/pins.js';

const FORBIDDEN_KEYS = ['executes', 'path', 'order', 'value'];

function sourceSpan(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const stateVariables: StateVariable[] = [];
  const relationships: Relationship[] = [];
  const facts: Fact[] = [];
  const issues: ReconIssue[] = [];

  return {
    contract(name: string): Contract {
      const record = createContract({ name, contract_type: 'core' });
      contracts.push(record);
      return record;
    },
    fn(
      contract: Contract,
      name: string,
      options: {
        mutability?: Mutability;
        visibility?: Visibility;
        modifiers?: string[];
        source?: string;
      } = {},
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: options.visibility ?? 'external',
        mutability: options.mutability ?? 'nonpayable',
        modifiers: options.modifiers ?? [],
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
      functions.push(record);
      return record;
    },
    stateVar(
      contract: Contract,
      name: string,
      type = 'uint256',
      visibility: StateVisibility = 'public',
    ): StateVariable {
      const record = createStateVariable({
        contract_id: contract.id,
        name,
        type,
        visibility,
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
    emit(subject: SolidityFunction, signature: string, provenance: ProvenanceInput[]): Fact {
      const record = createFact({
        subject_id: subject.id,
        predicate: 'EMITS',
        value: signature,
        provenance,
        created_at: '2024-01-01T00:00:00.000Z',
      });
      facts.push(record);
      return record;
    },
    marker(
      subject: SolidityFunction,
      predicate: 'CALLS' | 'DELEGATES_TO',
      value: string,
      provenance: ProvenanceInput[],
    ): Fact {
      const record = createFact({
        subject_id: subject.id,
        predicate,
        value,
        provenance,
        created_at: '2024-01-01T00:00:00.000Z',
      });
      facts.push(record);
      return record;
    },
    issue(record: ReconIssue): void {
      issues.push(record);
    },
    buildIndex(options: { fidelity?: 'semantic' | 'syntactic' } = {}): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: stateVariables,
        relationships,
        facts,
      });
      return buildEvidenceIndex({
        state,
        issues: [...issues],
        meta: { fidelity: options.fidelity ?? 'semantic', fileCount: 1 },
      });
    },
  };
}

function expectParseableAuthority(result: {
  authority: AuthorityChain[];
  unknowns: UnknownIndexEntry[];
}): void {
  for (const chain of result.authority) {
    expect(() => AuthorityChainSchema.parse(chain)).not.toThrow();
  }
  for (const entry of result.unknowns) {
    expect(() => UnknownIndexEntrySchema.parse(entry)).not.toThrow();
  }
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

describe('deriveAuthority (spec §9 rules E1–E6)', () => {
  describe('E1: actor link from resolved in-scope CALLS; unknown caller ⇒ E3 + partial', () => {
    it('E1: resolved CALLS into gated function yields actor link with evidence E2', () => {
      const state = miniState();
      const caller = state.contract('Caller');
      const vault = state.contract('Vault');
      const callerFn = state.fn(caller, 'callWithdraw', {
        source: 'Caller.sol:10-20',
        mutability: 'nonpayable',
      });
      const withdraw = state.fn(vault, 'withdraw', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'address');
      state.rel('CALLS', callerFn.id, withdraw.id, [sourceSpan('Caller.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('WRITES', withdraw.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === withdraw.id);
      expect(chain).toBeDefined();
      expect(chain!.authority_kind).toBe('unknown'); // onlyOwner modifier name alone ⇒ unknown
      const actorLink = chain!.per_link.find((l) => l.link_kind === 'actor');
      expect(actorLink).toBeDefined();
      expect(actorLink!.evidence_class).toBe('E2');
      expect(actorLink!.basis).toContain(callerFn.id);
    });

    it('E1: unknown caller (no CALLS) yields link with evidence E3 and status partial', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const withdraw = state.fn(vault, 'withdraw', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'address');
      state.rel('WRITES', withdraw.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === withdraw.id);
      expect(chain).toBeDefined();
      expect(chain!.status).toBe('partial');
      const actorLink = chain!.per_link.find((l) => l.link_kind === 'actor');
      expect(actorLink).toBeDefined();
      expect(actorLink!.evidence_class).toBe('E3');
      expect(actorLink!.unknown).toBe(true);
    });

    it('E1: written address var typed by in-scope ownership interface ⇒ stored-authority-subject observation; plain address write ⇒ no actor link', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const setOwner = state.fn(vault, 'setOwner', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable'); // typed by in-scope interface
      const plainVar = state.stateVar(vault, 'treasury', 'address'); // plain address
      state.rel('WRITES', setOwner.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);
      state.rel('WRITES', setOwner.id, plainVar.id, [sourceSpan('Vault.sol', 13)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === setOwner.id);
      expect(chain).toBeDefined();
      const subjectLink = chain!.per_link.find((l) => l.link_kind === 'stored-authority-subject');
      expect(subjectLink).toBeDefined();
      expect(subjectLink!.evidence_class).toBe('E2');
      // plain address write should NOT produce an actor link (actor link comes from CALLS, not writes)
      // Since there's no CALLS, actor link should be E3 (unknown caller)
      const actorLink = chain!.per_link.find((l) => l.link_kind === 'actor');
      expect(actorLink).toBeDefined();
      expect(actorLink!.evidence_class).toBe('E3');
      expect(actorLink!.unknown).toBe(true);
    });
  });

  describe('E2: authority kind from in-scope inherited role interface with role-typed storage; modifier name alone ⇒ unknown + structural observation', () => {
    it('E2: in-scope inherited role interface with role-typed storage ⇒ authority_kind ∈ pinned kinds', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const withdraw = state.fn(vault, 'withdraw', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      state.rel('WRITES', withdraw.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === withdraw.id);
      expect(chain).toBeDefined();
      expect(chain!.authority_kind).toBe('owner');
    });

    it('E2: modifier invocation text alone (no role-typed storage) ⇒ authority_kind unknown + "modifier M gates f" observation', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const adminFn = state.fn(vault, 'adminAction', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyAdmin'],
      });
      // No role-typed storage written/read
      const plainVar = state.stateVar(vault, 'counter', 'uint256');
      state.rel('WRITES', adminFn.id, plainVar.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === adminFn.id);
      expect(chain).toBeDefined();
      expect(chain!.authority_kind).toBe('unknown');
      const obsLink = chain!.per_link.find((l) => l.link_kind === 'gate-observation');
      expect(obsLink).toBeDefined();
      expect(obsLink!.basis.some((b) => b.includes('modifier onlyAdmin gates'))).toBe(true);
    });
  });

  describe('E3: gate descriptor carries modifiers, visibility, mutability (never stateMutability)', () => {
    it('E3: gate descriptor has modifiers, visibility, mutability keys', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const withdraw = state.fn(vault, 'withdraw', {
        source: 'Vault.sol:10-20',
        visibility: 'external',
        mutability: 'payable',
        modifiers: ['onlyOwner', 'nonReentrant'],
      });

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === withdraw.id);
      expect(chain).toBeDefined();
      expect(chain!.gate.modifiers).toEqual(['nonReentrant', 'onlyOwner']); // sorted
      expect(chain!.gate.visibility).toBe('external');
      expect(chain!.gate.mutability).toBe('payable');
      // Ensure no stateMutability key exists
      const keys = new Set<string>();
      collectKeys(chain!.gate, keys);
      expect(keys.has('stateMutability')).toBe(false);
    });
  });

  describe('E4: transition present ⇒ transition_id linked; dropped transition ⇒ function-only link + unknown', () => {
    it('E4: transition present ⇒ transition_id linked in authority chain', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const withdraw = state.fn(vault, 'withdraw', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      state.rel('WRITES', withdraw.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === withdraw.id);
      expect(chain).toBeDefined();
      expect(chain!.links.transition_id).toBeDefined();
      expect(chain!.links.transition_id).toMatch(/^semt:/);
    });

    it('E4: dropped transition (assembly-bearing) ⇒ function-only link + unknown entry', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const assemblyFn = state.fn(vault, 'assemblyWithdraw', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      state.rel('WRITES', assemblyFn.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);
      // Mark as assembly-bearing
      state.issue({
        code: 'unsupported_assembly',
        severity: 'UNSUPPORTED',
        message: 'Assembly not supported',
        file: 'Vault.sol',
        line_start: 10,
        line_end: 20,
      });

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === assemblyFn.id);
      expect(chain).toBeDefined();
      expect(chain!.links.transition_id).toBeUndefined();
      const unknownEntry = result.unknowns.find(
        (u) => u.record_ref === chain!.id && u.field === 'transition_id',
      );
      expect(unknownEntry).toBeDefined();
      expect(unknownEntry!.reason).toBe('unsupported_assembly');
    });
  });

  describe('E5: transition with movements/effects ⇒ typed impact; none ⇒ unknown', () => {
    it('E5: transition with asset movements ⇒ typed impact', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const withdraw = state.fn(vault, 'withdraw', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      const assetVar = state.stateVar(vault, 'asset', 'IERC20');
      state.rel('WRITES', withdraw.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);
      state.rel('CALLS', withdraw.id, assetVar.id, [sourceSpan('Vault.sol', 13)], {
        call_kind: 'external',
      });

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      // Manually add asset movement to simulate Layer C recognition
      const transition = transitions.transitions.find((t) => t.function_id === withdraw.id)!;
      transition.asset_movements.push({
        kind: 'withdraw',
        asset_ref: 'sema:test',
        direction: 'out',
        evidence_class: 'E2',
        basis: [withdraw.id],
      });

      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === withdraw.id);
      expect(chain).toBeDefined();
      expect(chain!.links.impact).toMatch(/^withdraw|transfer|mint|burn|approve|deposit/);
    });

    it('E5: transition without movements/effects ⇒ impact unknown', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const setOwner = state.fn(vault, 'setOwner', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      state.rel('WRITES', setOwner.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === setOwner.id);
      expect(chain).toBeDefined();
      expect(chain!.links.impact).toBe('unknown');
    });
  });

  describe('E6: pinned governance surface ⇒ governance; unpinned/onlyOwner without in-scope backing ⇒ unknown', () => {
    it('E6: function gated by governance interface surface ⇒ authority_kind governance', () => {
      const state = miniState();
      const gov = state.contract('Governance');
      const execute = state.fn(gov, 'executeProposal', {
        source: 'Governance.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlySubmitted'],
      });
      // Governance-typed storage
      const proposalVar = state.stateVar(gov, 'executed', 'IGovernance');
      state.rel('WRITES', execute.id, proposalVar.id, [sourceSpan('Governance.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === execute.id);
      expect(chain).toBeDefined();
      expect(chain!.authority_kind).toBe('governance');
    });

    it('E6: onlyOwner modifier without in-scope IOwnable backing ⇒ authority_kind unknown', () => {
      const state = miniState();
      const trap = state.contract('Trap');
      const mint = state.fn(trap, 'mint', {
        source: 'Trap.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      // No IOwnable-typed storage, just a plain address
      const plainOwner = state.stateVar(trap, 'owner', 'address');
      state.rel('WRITES', mint.id, plainOwner.id, [sourceSpan('Trap.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === mint.id);
      expect(chain).toBeDefined();
      expect(chain!.authority_kind).toBe('unknown');
    });
  });

  describe('Un-gated public function ⇒ observation "no gate observed on f"', () => {
    it('un-gated public function yields "no gate observed on f" observation', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const publicFn = state.fn(vault, 'publicAction', {
        source: 'Vault.sol:10-20',
        visibility: 'public',
        mutability: 'nonpayable',
        modifiers: [],
      });
      const counter = state.stateVar(vault, 'counter', 'uint256');
      state.rel('WRITES', publicFn.id, counter.id, [sourceSpan('Vault.sol', 12)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);
      expectParseableAuthority(result);

      const chain = result.authority.find((c) => c.links.function_id === publicFn.id);
      expect(chain).toBeDefined();
      const obsLink = chain!.per_link.find((l) => l.link_kind === 'gate-observation');
      expect(obsLink).toBeDefined();
      expect(obsLink!.basis.some((b) => b.includes('no gate observed on'))).toBe(true);
      // Never assert "callable by anyone"
      const allBasis = chain!.per_link.flatMap((l) => l.basis).join(' ');
      expect(allBasis.toLowerCase()).not.toContain('callable by anyone');
    });
  });

  describe('Role pins (OD-8 E6) are exported and corpus-cited', () => {
    it('OWNER_PINS contains IOwnable signatures', () => {
      expect(OWNER_PINS).toContain('owner()');
      expect(OWNER_PINS).toContain('transferOwnership(address)');
    });
    it('ADMIN_PINS contains IAdmin signatures', () => {
      expect(ADMIN_PINS).toContain('setAdmin(address,bool)');
      expect(ADMIN_PINS).toContain('isAdmin(address)');
    });
    it('GOVERNANCE_PINS contains IGovernance signatures', () => {
      expect(GOVERNANCE_PINS).toContain('submitProposal(bytes32)');
      expect(GOVERNANCE_PINS).toContain('executeProposal(bytes32)');
    });
    it('UPGRADER_PINS contains Proxy upgradeTo signature', () => {
      expect(UPGRADER_PINS).toContain('upgradeTo(address)');
    });
    it('PAUSER_PINS contains LendingPool setPaused signature', () => {
      expect(PAUSER_PINS).toContain('setPaused(bool)');
    });
    it('KEEPER_PINS contains StakingPool notifyRewardAmount signature', () => {
      expect(KEEPER_PINS).toContain('notifyRewardAmount(uint256)');
    });
    it('RELAYER_PINS contains StakingPool syncRewards signature', () => {
      expect(RELAYER_PINS).toContain('syncRewards(uint256)');
    });
    it('omitted role kinds have no exported pin lists', async () => {
      // These should not be exported from pins.ts
      const pinsModule = await import('../../src/semantic/pins.js');
      expect('DEFAULT_ADMIN_PINS' in pinsModule).toBe(false);
      expect('GUARDIAN_PINS' in pinsModule).toBe(false);
      expect('MULTISIG_PINS' in pinsModule).toBe(false);
      expect('TIMELOCK_PINS' in pinsModule).toBe(false);
    });
  });

  describe('Determinism and ordering', () => {
    it('double-run produces byte-identical authority chains', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const fn1 = state.fn(vault, 'actionA', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const fn2 = state.fn(vault, 'actionB', {
        source: 'Vault.sol:30-40',
        mutability: 'nonpayable',
        modifiers: ['onlyAdmin'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      const adminVar = state.stateVar(vault, 'admin', 'IAdmin');
      state.rel('WRITES', fn1.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);
      state.rel('WRITES', fn2.id, adminVar.id, [sourceSpan('Vault.sol', 32)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result1 = deriveAuthority(index, transitions.transitions);
      const result2 = deriveAuthority(index, transitions.transitions);

      expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    });

    it('authority chains sorted by id', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const fn1 = state.fn(vault, 'actionA', {
        source: 'Vault.sol:10-20',
        mutability: 'nonpayable',
        modifiers: ['onlyOwner'],
      });
      const fn2 = state.fn(vault, 'actionB', {
        source: 'Vault.sol:30-40',
        mutability: 'nonpayable',
        modifiers: ['onlyAdmin'],
      });
      const ownerVar = state.stateVar(vault, 'owner', 'IOwnable');
      const adminVar = state.stateVar(vault, 'admin', 'IAdmin');
      state.rel('WRITES', fn1.id, ownerVar.id, [sourceSpan('Vault.sol', 12)]);
      state.rel('WRITES', fn2.id, adminVar.id, [sourceSpan('Vault.sol', 32)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveAuthority(index, transitions.transitions);

      for (let i = 1; i < result.authority.length; i++) {
        expect(result.authority[i - 1]!.id <= result.authority[i]!.id).toBe(true);
      }
    });
  });
});