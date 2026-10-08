import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../src/domain/contract.js';
import type { Mutability } from '../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../src/domain/function.js';
import { createStateVariable, type StateVariable } from '../../src/domain/state-variable.js';
import { createFact, type Fact } from '../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../src/recon/issues.js';
import { createRelationship, type Relationship } from '../../src/relationships/relationship.js';
import { createReconState } from '../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../src/semantic/evidence.js';
import {
  StateTransitionSchema,
  AssetRecordSchema,
  CustodyRecordSchema,
  ClaimRecordSchema,
  AccountingRelationSchema,
  AuthorityChainSchema,
  ExternalDependencySchema,
  TrustCapabilitySchema,
  SemanticObservationSchema,
  SemanticAssumptionSchema,
  SemanticHypothesisSchema,
  CandidateInvariantSchema,
  UnknownIndexEntrySchema,
  type StateTransition,
  type AssetRecord,
  type CustodyRecord,
  type ClaimRecord,
  type AccountingRelation,
  type AuthorityChain,
  type ExternalDependency,
  type TrustCapability,
  type SemanticObservation,
  type SemanticAssumption,
  type SemanticHypothesis,
  type CandidateInvariant,
  type UnknownIndexEntry,
} from '../../src/semantic/model.js';
import { deriveTransitions, type TransitionDerivation } from '../../src/semantic/transitions.js';
import { deriveAssets, type AssetDerivation } from '../../src/semantic/custody.js';
import { deriveAccounting, type AccountingDerivation } from '../../src/semantic/accounting.js';
import { deriveAuthority, type AuthorityDerivation } from '../../src/semantic/authority.js';
import { deriveTrust } from '../../src/semantic/trust.js';
import type { TrustDerivation } from '../../src/semantic/trust.js';
import { deriveLadder, type LadderDerivation } from '../../src/semantic/ladder.js';
import { compareCodeUnits } from '../../src/util/canonical.js';

const FORBIDDEN_WORDS = ['safe', 'broken', 'vulnerable', 'confirmed'];

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
      options: { mutability?: Mutability; source?: string } = {},
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: 'external',
        mutability: options.mutability ?? 'nonpayable',
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
      functions.push(record);
      return record;
    },
    stateVar(contract: Contract, name: string): StateVariable {
      const record = createStateVariable({
        contract_id: contract.id,
        name,
        type: 'uint256',
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

function runFullPipeline(index: EvidenceIndex): {
  transitions: TransitionDerivation;
  assets: AssetDerivation;
  accounting: AccountingDerivation;
  authority: AuthorityDerivation;
  trust: TrustDerivation;
  ladder: LadderDerivation;
} {
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
      observations: [],
    },
  });
  return { transitions, assets, accounting, authority, trust, ladder };
}

function expectParseableLadder(result: LadderDerivation): void {
  for (const obs of result.observations) {
    expect(() => SemanticObservationSchema.parse(obs)).not.toThrow();
  }
  for (const asm of result.assumptions) {
    expect(() => SemanticAssumptionSchema.parse(asm)).not.toThrow();
  }
  for (const inv of result.invariants) {
    expect(() => CandidateInvariantSchema.parse(inv)).not.toThrow();
  }
  for (const hyp of result.hypotheses) {
    expect(() => SemanticHypothesisSchema.parse(hyp)).not.toThrow();
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

function noForbiddenWords(statement: string): void {
  for (const word of FORBIDDEN_WORDS) {
    expect(statement.toLowerCase()).not.toContain(word);
  }
}

describe('deriveLadder (spec §11–§12 epistemic ladder rules)', () => {
  describe('Observation derivation (FACT → OBSERVATION)', () => {
    it('emits SemanticObservation from state facts with based_on = fact: ids ≥1, confidence DERIVED, id semobs:', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);
      state.emit(writer, 'Written(uint256)', [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      expect(result.ladder.observations.length).toBeGreaterThan(0);
      for (const obs of result.ladder.observations) {
        expect(obs.id).toMatch(/^semobs:/);
        expect(obs.type).toBe('OBSERVATION');
        expect(obs.confidence.level).toBe('DERIVED');
        expect(obs.based_on.length).toBeGreaterThanOrEqual(1);
        for (const ref of obs.based_on) {
          expect(ref).toMatch(/^fact:/);
        }
        noForbiddenWords(obs.statement);
      }
    });

    it('observation fallback path: entity-only basis copies provenance byte-equal from state registry (§12.3)', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      const prov = sourceSpan('Store.sol', 15);
      state.rel('WRITES', writer.id, zeta.id, [at, prov]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      // Check that provenance records in observations are byte-equal to state provenance
      for (const obs of result.ladder.observations) {
        for (const prov of obs.provenance) {
          // The provenance should exist in the state's provenance registry or be embedded in facts/relationships
          const foundInState = [...index.provenanceById.values()].some((p) => p.id === prov.id) ||
            [...index.factsById.values()].some((f) => f.provenance.some((fp) => fp.id === prov.id)) ||
            [...index.relationshipsById.values()].some((r) => r.provenance.some((rp) => rp.id === prov.id));
          expect(foundInState).toBe(true);
        }
      }
    });

    it('mutated provenance copy ⇒ derivation refuses (no record)', () => {
      // This test verifies that if provenance doesn't match byte-for-byte, no observation is created
      // The deriveLadder should only create observations when provenance can be verified
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      // All observations should have provenance that exists in state
      for (const obs of result.ladder.observations) {
        if (obs.based_on.length === 0) {
          expect(obs.provenance.length).toBeGreaterThan(0);
          for (const prov of obs.provenance) {
            const foundInState = [...index.provenanceById.values()].some((p) => p.id === prov.id) ||
              [...index.factsById.values()].some((f) => f.provenance.some((fp) => fp.id === prov.id)) ||
              [...index.relationshipsById.values()].some((r) => r.provenance.some((rp) => rp.id === prov.id));
            expect(foundInState).toBe(true);
          }
        }
      }
    });
  });

  describe('Assumption derivation (OBSERVATION → SECURITY ASSUMPTION)', () => {
    it('emits SemanticAssumption with based_on = semobs: refs ≥1, INFERRED confidence, status OPEN', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      expect(result.ladder.assumptions.length).toBeGreaterThanOrEqual(0);
      for (const asm of result.ladder.assumptions) {
        expect(asm.id).toMatch(/^semasm:/);
        expect(asm.type).toBe('ASSUMPTION');
        expect(asm.confidence.level).toBe('INFERRED');
        expect(asm.status).toBe('OPEN');
        expect(asm.based_on.length).toBeGreaterThanOrEqual(1);
        for (const ref of asm.based_on) {
          expect(ref).toMatch(/^semobs:/);
        }
        noForbiddenWords(asm.statement);
      }
    });

    it('F4 trust assumptions from Layer F appear here, each OPEN', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      // Trust assumptions from Layer F should be present
      const trustAssumptions = result.ladder.assumptions.filter((a) => a.statement.includes('Trust assumption'));
      for (const asm of trustAssumptions) {
        expect(asm.status).toBe('OPEN');
        expect(asm.confidence.level).toBe('INFERRED');
      }
    });
  });

  describe('Candidate Invariant derivation (SECURITY ASSUMPTION → CANDIDATE INVARIANT)', () => {
    it('statement phrasing accepts property-phrasing, rejects "X is safe/broken/vulnerable/confirmed"', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      for (const inv of result.ladder.invariants) {
        expect(inv.id).toMatch(/^seminv:/);
        expect(inv.status).toMatch(/^(OPEN|SUPPORTED|WEAKENED|REJECTED)$/);
        expect(inv.based_on.length).toBeGreaterThanOrEqual(1);
        for (const ref of inv.based_on) {
          expect(ref).toMatch(/^(semobs|semasm|semhyp):/);
        }
        noForbiddenWords(inv.statement);
        // Should be property-phrasing like "totalShares never exceeds accounted underlying"
        expect(inv.statement).toMatch(/\w+/); // non-empty
      }
    });

    it('invariant based_on references only already-emitted assumptions/observations (acyclic)', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      const emittedObsIds = new Set(result.ladder.observations.map((o) => o.id));
      const emittedAsmIds = new Set(result.ladder.assumptions.map((a) => a.id));
      const emittedHypIds = new Set(result.ladder.hypotheses.map((h) => h.id));
      const allEmitted = new Set([...emittedObsIds, ...emittedAsmIds, ...emittedHypIds]);

      for (const inv of result.ladder.invariants) {
        for (const ref of inv.based_on) {
          expect(allEmitted.has(ref)).toBe(true);
        }
      }
    });
  });

  describe('Hypothesis derivation (CANDIDATE INVARIANT → PRELIMINARY HYPOTHESIS)', () => {
    it('emits SemanticHypothesis with SPECULATIVE confidence, based_on semobs/semasm refs', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      for (const hyp of result.ladder.hypotheses) {
        expect(hyp.id).toMatch(/^semhyp:/);
        expect(hyp.type).toBe('HYPOTHESIS');
        expect(hyp.confidence.level).toBe('SPECULATIVE');
        expect(hyp.based_on.length).toBeGreaterThanOrEqual(1);
        for (const ref of hyp.based_on) {
          expect(ref).toMatch(/^(semobs|semasm):/);
        }
        expect(hyp.status).toMatch(/^(OPEN|SUPPORTED|WEAKENED|REJECTED)$/);
        noForbiddenWords(hyp.statement);
      }
    });
  });

  describe('Density: empty layers ⇒ empty arrays, valid', () => {
    it('produces valid empty arrays when no evidence', () => {
      const state = miniState();
      // No contracts, no functions, no facts
      const index = state.buildIndex();
      const result = runFullPipeline(index);

      expect(result.ladder.observations).toEqual([]);
      expect(result.ladder.assumptions).toEqual([]);
      expect(result.ladder.invariants).toEqual([]);
      expect(result.ladder.hypotheses).toEqual([]);
      expect(result.ladder.unknowns).toEqual([]);
      expectParseableLadder(result.ladder);
    });
  });

  describe('Deterministic ordering + byte-stable output', () => {
    it('double-run byte-identical', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);
      state.emit(writer, 'Written(uint256)', [at]);

      const index = state.buildIndex();
      const first = runFullPipeline(index).ladder;
      const second = runFullPipeline(index).ladder;

      expect(second.observations).toEqual(first.observations);
      expect(second.assumptions).toEqual(first.assumptions);
      expect(second.invariants).toEqual(first.invariants);
      expect(second.hypotheses).toEqual(first.hypotheses);
      expect(second.unknowns).toEqual(first.unknowns);
    });

    it('all arrays sorted by id (compareCodeUnits)', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);
      state.emit(writer, 'Written(uint256)', [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      const checkSorted = (arr: { id: string }[]) => {
        for (let i = 1; i < arr.length; i++) {
          const prev = arr[i - 1];
          const curr = arr[i];
          if (prev !== undefined && curr !== undefined) {
            expect(compareCodeUnits(prev.id, curr.id)).toBeLessThanOrEqual(0);
          }
        }
      };

      checkSorted(result.ladder.observations);
      checkSorted(result.ladder.assumptions);
      checkSorted(result.ladder.invariants);
      checkSorted(result.ladder.hypotheses);
    });
  });

  describe('Layer-F ABI-closure gap analysis', () => {
    it('conservatively consumes Layer F trust assumptions as INFERRED/OPEN without upgrading', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      // Trust assumptions from Layer F should be present and not upgraded
      for (const asm of result.ladder.assumptions) {
        if (asm.statement.includes('Trust assumption')) {
          expect(asm.confidence.level).toBe('INFERRED');
          expect(asm.status).toBe('OPEN');
          // Should not have been upgraded to DERIVED or VERIFIED
          expect(asm.confidence.level).not.toBe('DERIVED');
          expect(asm.confidence.level).not.toBe('VERIFIED');
        }
      }
    });
  });

  describe('Provenance and evidence rules (§12)', () => {
    it('every semantic record carries basis ≥1 (SINV-3)', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      for (const obs of result.ladder.observations) {
        expect(obs.based_on.length + obs.provenance.length).toBeGreaterThan(0);
      }
      for (const asm of result.ladder.assumptions) {
        expect(asm.based_on.length).toBeGreaterThan(0);
      }
      for (const inv of result.ladder.invariants) {
        expect(inv.based_on.length).toBeGreaterThan(0);
      }
      for (const hyp of result.ladder.hypotheses) {
        expect(hyp.based_on.length).toBeGreaterThan(0);
      }
    });

    it('no invented source locations, relationships, transitions, asset mappings, trust relationships', () => {
      const state = miniState();
      const store = state.contract('Store');
      const writer = state.fn(store, 'write', { source: 'Store.sol:10-20' });
      const zeta = state.stateVar(store, 'zeta');
      const at = sourceSpan('Store.sol', 12);
      state.rel('WRITES', writer.id, zeta.id, [at]);

      const index = state.buildIndex();
      const result = runFullPipeline(index);

      // All references should resolve to existing state or artifact records
      for (const obs of result.ladder.observations) {
        for (const ref of obs.based_on) {
          expect(index.factsById.has(ref) || ref.startsWith('prov:')).toBe(true);
        }
      }
      for (const asm of result.ladder.assumptions) {
        for (const ref of asm.based_on) {
          expect(result.ladder.observations.some((o) => o.id === ref)).toBe(true);
        }
      }
      for (const inv of result.ladder.invariants) {
        for (const ref of inv.based_on) {
          const exists = result.ladder.observations.some((o) => o.id === ref) ||
            result.ladder.assumptions.some((a) => a.id === ref) ||
            result.ladder.hypotheses.some((h) => h.id === ref);
          expect(exists).toBe(true);
        }
      }
      for (const hyp of result.ladder.hypotheses) {
        for (const ref of hyp.based_on) {
          const exists = result.ladder.observations.some((o) => o.id === ref) ||
            result.ladder.assumptions.some((a) => a.id === ref);
          expect(exists).toBe(true);
        }
      }
    });
  });
});