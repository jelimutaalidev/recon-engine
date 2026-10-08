import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../src/domain/state-variable.js';
import { createFact, type Fact } from '../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import { createRelationship, type Relationship } from '../../src/relationships/relationship.js';
import { createReconState } from '../../src/recon-state/state.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import { buildEvidenceIndex, resolveProvenanceCopy, type EvidenceIndex } from '../../src/semantic/evidence.js';
import { deriveAccounting } from '../../src/semantic/accounting.js';
import { deriveAuthority } from '../../src/semantic/authority.js';
import { deriveAssets } from '../../src/semantic/custody.js';
import { deriveLadder } from '../../src/semantic/ladder.js';
import { finalizeSemanticModel } from '../../src/semantic/report.js';
import { validateSemanticModel } from '../../src/semantic/validate.js';
import { deriveTransitions, type TransitionDerivation } from '../../src/semantic/transitions.js';
import {
  ExternalDependencySchema,
  TrustCapabilitySchema,
  SemanticAssumptionSchema,
  UnknownIndexEntrySchema,
  type ExternalDependency,
  type TrustCapability,
  type SemanticAssumption,
  type UnknownIndexEntry,
} from '../../src/semantic/model.js';
import { deriveTrust } from '../../src/semantic/trust.js';
import { ORACLE_PINS, DEX_PINS } from '../../src/semantic/pins.js';

const FORBIDDEN_KEYS = ['severity', 'unsafe', 'vulnerable', 'finding', 'attack', 'exploit', 'confirmed', 'critical'];

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
    contract(name: string, contractType: Contract['contract_type'] = 'core'): Contract {
      const record = createContract({ name, contract_type: contractType });
      contracts.push(record);
      return record;
    },
    interfaceContract(name: string): Contract {
      const record = createContract({ name, contract_type: 'interface' });
      contracts.push(record);
      return record;
    },
    fn(
      contract: Contract,
      name: string,
      options: { mutability?: Mutability; visibility?: Visibility; modifiers?: string[]; source?: string; parameters?: { name?: string; type: string }[] } = {},
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: options.visibility ?? 'external',
        mutability: options.mutability ?? 'nonpayable',
        modifiers: options.modifiers ?? [],
        parameters: options.parameters ?? [],
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
      functions.push(record);
      return record;
    },
    stateVar(
      contract: Contract,
      name: string,
      type = 'uint256',
      visibility: 'public' | 'internal' | 'private' = 'public',
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

function expectParseableTrust(result: {
  dependencies: ExternalDependency[];
  capabilities: TrustCapability[];
  assumptions: SemanticAssumption[];
  unknowns: UnknownIndexEntry[];
}): void {
  for (const dep of result.dependencies) {
    expect(() => ExternalDependencySchema.parse(dep)).not.toThrow();
  }
  for (const cap of result.capabilities) {
    expect(() => TrustCapabilitySchema.parse(cap)).not.toThrow();
  }
  for (const asm of result.assumptions) {
    expect(() => SemanticAssumptionSchema.parse(asm)).not.toThrow();
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

describe('deriveTrust (spec §10 rules F1–F5)', () => {
  describe('F1: dependency candidate — named out-of-scope call target ⇒ ExternalDependency with dependency_type: unknown (+ pinned kind when pinned mapping hits); unresolved target with no named ref ⇒ no dependency record + unknown out_of_scope_target; selector-only ⇒ unknown (OD-6)', () => {
    it('F1: named out-of-scope CALLS target (resolved to external contract) yields ExternalDependency with dependency_type unknown', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const getData = state.fn(oracle, 'getData', {
        source: 'Oracle.sol:1-10',
        parameters: [{ name: 'query', type: 'bytes' }],
      });
      state.rel('CALLS', readPrice.id, getData.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      // Oracle has getData(bytes) which doesn't match any pin
      // So dependency_type should be unknown

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const dep = result.dependencies.find((d) => d.name === 'Oracle');
      expect(dep).toBeDefined();
      expect(dep?.dependency_type).toBe('unknown');
      expect(dep?.basis.length).toBeGreaterThan(0);
    });

    it('F1: named out-of-scope CALLS target matching oracle pin yields dependency_type oracle', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', {
        source: 'Oracle.sol:1-10',
        parameters: [{ name: 'asset', type: 'address' }],
      });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const dep = result.dependencies.find((d) => d.name === 'Oracle');
      expect(dep).toBeDefined();
      expect(dep?.dependency_type).toBe('oracle');
      expect(dep?.basis.length).toBeGreaterThan(0);
    });

    it('F1: named out-of-scope CALLS target matching DEX pin yields dependency_type dex', () => {
      const state = miniState();
      const pair = state.contract('Pair', 'amm');
      const router = state.contract('Router', 'router');
      const irouter = state.interfaceContract('IRouter');
      const swap = state.fn(pair, 'swapThroughRouter', { source: 'Pair.sol:50-65' });
      const swapFn = state.fn(router, 'swapExactTokensForTokens', {
        source: 'Router.sol:1-20',
        parameters: [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      });
      state.rel('CALLS', swap.id, swapFn.id, [sourceSpan('Pair.sol', 55)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', router.id, irouter.id, [sourceSpan('Router.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      console.log('Dependencies:', result.dependencies.map(d => ({ name: d.name, type: d.dependency_type, basis: d.basis })));
      console.log('Router fn signature:', swapFn.signature);

      const dep = result.dependencies.find((d) => d.name === 'Router');
      expect(dep).toBeDefined();
      expect(dep?.dependency_type).toBe('dex');
      expect(dep?.basis.length).toBeGreaterThan(0);
    });

    it('F1: unresolved CALLS target (no named ref, target_evidence E3) yields no dependency record + unknown out_of_scope_target', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      state.marker(readPrice, 'CALLS', 'unresolved-lowlevel-call', [sourceSpan('Consumer.sol', 15)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      expect(result.dependencies).toHaveLength(0);
      const unknown = result.unknowns.find(
        (u) => u.reason === 'out_of_scope_target' && u.record_ref.startsWith('semt:'),
      );
      expect(unknown).toBeDefined();
      expect(unknown?.basis.length).toBeGreaterThan(0);
    });

    it('F1: CALLS to state variable (not a function) yields dependency_type unknown', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracleVar = state.stateVar(consumer, 'oracle', 'address');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      state.rel('CALLS', readPrice.id, oracleVar.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const dep = result.dependencies.find((d) => d.name === 'oracle');
      expect(dep).toBeDefined();
      expect(dep?.dependency_type).toBe('unknown');
    });
  });

  describe('F2: observed capability — outbound CALLS with call_kind ⇒ TrustCapability{direction: observed}', () => {
    it('F2: outbound CALLS with call_kind yields TrustCapability direction observed', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const dep = result.dependencies.find((d) => d.name === 'Oracle');
      expect(dep).toBeDefined();
      const cap = result.capabilities.find((c) => c.dependency_ref === dep?.id);
      expect(cap).toBeDefined();
      expect(cap?.direction).toBe('observed');
      expect(cap?.capabilities.length).toBeGreaterThan(0);
    });

    it('F2: multiple outbound CALLS to same dependency aggregate into one capability', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const readFreshness = state.fn(consumer, 'readFreshness', { source: 'Consumer.sol:30-40' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      const latestTimestamp = state.fn(oracle, 'latestTimestamp', { source: 'Oracle.sol:11-20' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('CALLS', readFreshness.id, latestTimestamp.id, [sourceSpan('Consumer.sol', 32)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const dep = result.dependencies.find((d) => d.name === 'Oracle');
      expect(dep).toBeDefined();
      const caps = result.capabilities.filter((c) => c.dependency_ref === dep?.id);
      expect(caps).toHaveLength(1);
      expect(caps[0]?.direction).toBe('observed');
      expect(caps[0]?.capabilities.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('F3: consumed capability — public/external functions accepting addresses/calldata callbacks + in-scope hook interface ⇒ direction: consumed; not provable ⇒ field unknown + unknown no_evidence (record kept when F1 held)', () => {
    it('F3: public function with address parameter and in-scope hook interface yields direction consumed', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const hook = state.contract('Hook');
      const ihook = state.interfaceContract('IHook');
      const deposit = state.fn(vault, 'deposit', {
        visibility: 'external',
        source: 'Vault.sol:10-30',
        parameters: [{ name: 'receiver', type: 'address' }],
      });
      const onDeposit = state.fn(hook, 'onDeposit', {
        visibility: 'external',
        source: 'Hook.sol:1-10',
      });
      state.rel('IMPLEMENTS', hook.id, ihook.id, [sourceSpan('Hook.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const cap = result.capabilities.find((c) => c.direction === 'consumed');
      expect(cap).toBeDefined();
    });

    it('F3: callback capability not provable yields direction unknown + unknown no_evidence', () => {
      const state = miniState();
      const vault = state.contract('Vault');
      const deposit = state.fn(vault, 'deposit', {
        visibility: 'external',
        source: 'Vault.sol:10-30',
        parameters: [{ name: 'receiver', type: 'address' }],
      });

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const cap = result.capabilities.find((c) => c.direction === 'unknown');
      expect(cap).toBeDefined();
      const unknown = result.unknowns.find(
        (u) => u.reason === 'no_evidence' && u.field === 'direction' && u.record_ref === deposit.id,
      );
      expect(unknown).toBeDefined();
    });
  });

  describe('F4: trust assumption — every capability carries trust_assumption_ref pointing at SemanticAssumption with confidence.level INFERRED, status OPEN; capability without assumption ⇒ validator will fail', () => {
    it('F4: every TrustCapability has trust_assumption_ref to SemanticAssumption with INFERRED/OPEN', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const cap of result.capabilities) {
        expect(cap.trust_assumption_ref).toBeDefined();
        expect(cap.trust_assumption_ref).toMatch(/^semasm:/);
        const asm = result.assumptions.find((a) => a.id === cap.trust_assumption_ref);
        expect(asm).toBeDefined();
        expect(asm?.confidence.level).toBe('INFERRED');
        expect(asm?.status).toBe('OPEN');
        expect(asm?.based_on.length).toBeGreaterThan(0);
      }
      expect(result.capabilities.length).toBeGreaterThan(0);
    });

    it('F4: assumption statement references the capability and relevant observations', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const asm of result.assumptions) {
        expect(asm.statement.length).toBeGreaterThan(0);
        expect(asm.based_on.length).toBeGreaterThan(0);
        for (const ref of asm.based_on) {
          expect(ref).toMatch(/^semobs:/);
        }
      }
    });
  });

  describe('F5: failure semantics — failure_semantics: unknown with unknown no_evidence (no data-flow claims)', () => {
    it('F5: every TrustCapability has failure_semantics: unknown', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const cap of result.capabilities) {
        expect(cap.failure_semantics).toBe('unknown');
      }
    });

    it('F5: unknown no_evidence entry for failure_semantics on each capability', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const cap of result.capabilities) {
        const unknown = result.unknowns.find(
          (u) => u.reason === 'no_evidence' && u.field === 'failure_semantics' && u.record_ref === cap.id,
        );
        expect(unknown).toBeDefined();
        expect(unknown?.basis.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Trust posture: no forbidden vocabulary in records', () => {
    it('no record contains forbidden keys (severity, unsafe, vulnerable, etc.)', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const allRecords = [
        ...result.dependencies,
        ...result.capabilities,
        ...result.assumptions,
        ...result.unknowns,
      ];
      for (const record of allRecords) {
        const found = new Set<string>();
        collectKeys(record, found);
        const forbidden = [...found].filter((key) => FORBIDDEN_KEYS.includes(key));
        expect(forbidden).toEqual([]);
      }
    });
  });

  describe('Provenance: every record has basis >= 1 real intake ids', () => {
    it('every ExternalDependency has basis referencing state entities', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      const callRel = state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const dep of result.dependencies) {
        expect(dep.basis.length).toBeGreaterThan(0);
        for (const basisId of dep.basis) {
          expect(
            basisId.startsWith('rel:') ||
              basisId.startsWith('function:') ||
              basisId.startsWith('contract:'),
          ).toBe(true);
        }
      }
    });

    it('every TrustCapability has basis referencing transitions/relationships', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const cap of result.capabilities) {
        expect(cap.basis.length).toBeGreaterThan(0);
        expect(cap.dependency_ref).toMatch(/^semdep:/);
        expect(cap.trust_assumption_ref).toMatch(/^semasm:/);
      }
    });

    it('every SemanticAssumption has based_on referencing observations', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      for (const asm of result.assumptions) {
        expect(asm.based_on.length).toBeGreaterThan(0);
        for (const ref of asm.based_on) {
          expect(ref).toMatch(/^semobs:/);
        }
      }
    });
  });

  describe('Determinism: no Date.now/Math.random; arrays sorted by id', () => {
    it('repeated derivation over same index is byte-equal', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const router = state.contract('Router', 'router');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const irouter = state.interfaceContract('IRouter');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const swap = state.fn(consumer, 'swap', { source: 'Consumer.sol:30-40' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      const swapFn = state.fn(router, 'swapExactTokensForTokens', { source: 'Router.sol:1-20' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('CALLS', swap.id, swapFn.id, [sourceSpan('Consumer.sol', 32)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);
      state.rel('IMPLEMENTS', router.id, irouter.id, [sourceSpan('Router.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const first = deriveTrust(index, transitions.transitions);
      const second = deriveTrust(index, transitions.transitions);

      expect(second.dependencies).toEqual(first.dependencies);
      expect(second.capabilities).toEqual(first.capabilities);
      expect(second.assumptions).toEqual(first.assumptions);
      expect(second.unknowns).toEqual(first.unknowns);
    });

    it('arrays are sorted by id (dependencies, capabilities, assumptions, unknowns)', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const router = state.contract('Router', 'router');
      const ipriceOracle = state.interfaceContract('IPriceOracle');
      const irouter = state.interfaceContract('IRouter');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const swap = state.fn(consumer, 'swap', { source: 'Consumer.sol:30-40' });
      const latestPrice = state.fn(oracle, 'latestPrice', { source: 'Oracle.sol:1-10' });
      const swapFn = state.fn(router, 'swapExactTokensForTokens', { source: 'Router.sol:1-20' });
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('CALLS', swap.id, swapFn.id, [sourceSpan('Consumer.sol', 32)], {
        call_kind: 'external',
      });
      state.rel('IMPLEMENTS', oracle.id, ipriceOracle.id, [sourceSpan('Oracle.sol', 1)]);
      state.rel('IMPLEMENTS', router.id, irouter.id, [sourceSpan('Router.sol', 1)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      const depIds = result.dependencies.map((d) => d.id);
      expect(depIds).toEqual([...depIds].sort());

      const capIds = result.capabilities.map((c) => c.id);
      expect(capIds).toEqual([...capIds].sort());

      const asmIds = result.assumptions.map((a) => a.id);
      expect(asmIds).toEqual([...asmIds].sort());

      const unkIds = result.unknowns.map((u) => u.record_ref + u.field + u.reason);
      expect(unkIds).toEqual([...unkIds].sort());
    });
  });

  describe('Layer-F observations are emitted and assumption based_on resolves (Task 13 adjudication fix)', () => {
    it('deriveTrust returns observations; every assumption cites an emitted observation', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', {
        source: 'Oracle.sol:1-10',
        parameters: [{ name: 'asset', type: 'address' }],
      });
      const price = state.stateVar(oracle, 'price', 'uint256');
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('READS', latestPrice.id, price.id, [sourceSpan('Oracle.sol', 4)]);
      state.emit(readPrice, 'PriceRead(address)', [sourceSpan('Consumer.sol', 14)]);

      const index = state.buildIndex();
      const transitions = deriveTransitions(index);
      const result = deriveTrust(index, transitions.transitions);
      expectParseableTrust(result);

      expect(result.capabilities.length).toBeGreaterThan(0);
      expect(result.observations.length).toBe(result.capabilities.length);
      const emittedObsIds = new Set(result.observations.map((obs) => obs.id));
      for (const cap of result.capabilities) {
        const asm = result.assumptions.find((candidate) => candidate.id === cap.trust_assumption_ref);
        expect(asm).toBeDefined();
        expect(asm!.based_on.length).toBeGreaterThanOrEqual(1);
        for (const ref of asm!.based_on) {
          expect(emittedObsIds.has(ref)).toBe(true);
        }
      }
      // Observation provenance is byte-equal to state evidence (registry or embedded).
      for (const obs of result.observations) {
        for (const prov of obs.provenance) {
          expect(resolveProvenanceCopy(index, prov)).toBe(true);
        }
      }
    });

    it('full pipeline with Layer-F observations threaded validates end to end', () => {
      const state = miniState();
      const consumer = state.contract('Consumer');
      const oracle = state.contract('Oracle', 'oracle');
      const readPrice = state.fn(consumer, 'readPrice', { source: 'Consumer.sol:10-20' });
      const latestPrice = state.fn(oracle, 'latestPrice', {
        source: 'Oracle.sol:1-10',
        parameters: [{ name: 'asset', type: 'address' }],
      });
      const price = state.stateVar(oracle, 'price', 'uint256');
      state.rel('CALLS', readPrice.id, latestPrice.id, [sourceSpan('Consumer.sol', 12)], {
        call_kind: 'external',
      });
      state.rel('READS', latestPrice.id, price.id, [sourceSpan('Oracle.sol', 4)]);
      state.emit(readPrice, 'PriceRead(address)', [sourceSpan('Consumer.sol', 14)]);

      const index = state.buildIndex();
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
      const finalized = finalizeSemanticModel({
        schema_version: 'semantic-model/v1',
        status: 'COMPLETE',
        input: {
          fidelity: index.input.meta.fidelity,
          state_output_hash: index.stateHash,
          file_count: index.input.meta.fileCount,
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
      expect(finalized.epistemic.observations.length).toBeGreaterThan(0);
      expect(finalized.epistemic.assumptions.length).toBeGreaterThan(0);
      expect(() => validateSemanticModel(finalized, { state: index.input.state })).not.toThrow();
      expect(index.stateHash).toBe(computeOutputIdentity(index.input.state).output_hash);
      // Re-finalizing the validated model is byte-identical (deterministic hash).
      const { semantic_hash: _drop, counts: _dropCounts, ...draft } = finalized;
      expect(finalizeSemanticModel(draft).semantic_hash).toBe(finalized.semantic_hash);
    });
  });
});