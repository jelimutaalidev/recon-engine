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
  UnknownIndexEntrySchema,
  type StateTransition,
  type UnknownIndexEntry,
} from '../../src/semantic/model.js';
import { deriveTransitions, type TransitionDerivation } from '../../src/semantic/transitions.js';

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

function transitionOf(result: TransitionDerivation, fn: SolidityFunction): StateTransition {
  const found = result.transitions.find((record) => record.function_id === fn.id);
  if (found === undefined) throw new Error(`missing transition for ${fn.id}`);
  return found;
}

function expectParseable(result: TransitionDerivation): void {
  for (const transition of result.transitions) {
    expect(() => StateTransitionSchema.parse(transition)).not.toThrow();
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

describe('deriveTransitions (spec §6 rules B1–B7)', () => {
  it('B1: READS/WRITES relationships populate pre_state_reads/writes sorted by state-var id; absent sets are empty', () => {
    const state = miniState();
    const store = state.contract('Store');
    const writer = state.fn(store, 'writeAll', { source: 'Store.sol:10-40' });
    const quiet = state.fn(store, 'noop', { source: 'Store.sol:41-45' });
    const zeta = state.stateVar(store, 'zeta');
    const alpha = state.stateVar(store, 'alpha');
    const mu = state.stateVar(store, 'mu');
    const at = sourceSpan('Store.sol', 12);
    state.rel('READS', writer.id, zeta.id, [at]);
    state.rel('WRITES', writer.id, alpha.id, [at]);
    state.rel('READS', writer.id, mu.id, [at]);
    state.rel('WRITES', writer.id, mu.id, [at]);

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const populated = transitionOf(result, writer);
    expect(populated.pre_state_reads).toEqual([mu.id, zeta.id].sort());
    expect(populated.writes).toEqual([
      { state_var_id: alpha.id, kind: 'write' },
      { state_var_id: mu.id, kind: 'readwrite' },
    ]);
    expect(populated.state_mutation).toBe('storage');

    const empty = transitionOf(result, quiet);
    expect(empty.pre_state_reads).toEqual([]);
    expect(empty.writes).toEqual([]);
    expect(empty.state_mutation).toBe('none');
    expect(empty.function_id).toBe(quiet.id);
  });

  it('B2: resolved in-scope CALLS yields target_ref with E1; unresolved low-level marker yields E3 + unresolved_call unknown; metadata.call_kind flows into call_kind', () => {
    const state = miniState();
    const caller = state.contract('Caller');
    const token = state.contract('Token');
    const puller = state.fn(caller, 'pull', { source: 'Caller.sol:1-40' });
    const grabbed = state.fn(token, 'grab', { source: 'Token.sol:1-20' });
    const resolvedCall = state.rel(
      'CALLS',
      puller.id,
      grabbed.id,
      [sourceSpan('Caller.sol', 12)],
      { call_kind: 'external' },
    );
    const markerFact = state.marker(
      puller,
      'CALLS',
      'unresolved-lowlevel-call',
      [sourceSpan('Caller.sol', 20)],
    );

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const transition = transitionOf(result, puller);
    expect(transition.external_effects).toHaveLength(2);

    const resolved = transition.external_effects.find(
      (effect) => effect.target_evidence === 'E1',
    )!;
    expect(resolved.call_kind).toBe('external');
    expect(resolved.target_ref).toBe(grabbed.id);
    expect(resolved.basis).toEqual([resolvedCall.id]);

    const unresolved = transition.external_effects.find(
      (effect) => effect.target_evidence === 'E3',
    )!;
    expect(unresolved.call_kind).toBe('lowlevel');
    expect(unresolved).not.toHaveProperty('target_ref');
    expect(unresolved.basis).toEqual([markerFact.id]);

    expect(
      transition.unknowns.some(
        (entry) => entry.reason === 'unresolved_call' && entry.basis.includes(markerFact.id),
      ),
    ).toBe(true);
    expect(
      result.unknowns.some(
        (entry) =>
          entry.reason === 'unresolved_call' && entry.record_ref === transition.id,
      ),
    ).toBe(true);
  });

  it('B2 failure: CALLS target identity that does not resolve to an indexed function yields E3 + out_of_scope_target unknown', () => {
    const state = miniState();
    const caller = state.contract('Caller');
    const wanderer = state.fn(caller, 'wander', { source: 'Caller.sol:1-30' });
    const slot = state.stateVar(caller, 'slot');
    const oddCall = state.rel('CALLS', wanderer.id, slot.id, [sourceSpan('Caller.sol', 7)], {
      call_kind: 'external',
    });

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const transition = transitionOf(result, wanderer);
    expect(transition.external_effects).toHaveLength(1);
    const effect = transition.external_effects[0]!;
    expect(effect.target_evidence).toBe('E3');
    expect(effect).not.toHaveProperty('target_ref');
    expect(
      transition.unknowns.some(
        (entry) => entry.reason === 'out_of_scope_target' && entry.basis.includes(oddCall.id),
      ),
    ).toBe(true);
  });

  it('B2 failure: CALLS relationship without call_kind metadata yields no effect record and a no_evidence unknown', () => {
    const state = miniState();
    const caller = state.contract('Caller');
    const partner = state.contract('Partner');
    const callerFn = state.fn(caller, 'go', { source: 'Caller.sol:1-20' });
    const partnerFn = state.fn(partner, 'receiveCall', { source: 'Partner.sol:1-20' });
    const bareCall = state.rel('CALLS', callerFn.id, partnerFn.id, [sourceSpan('Caller.sol', 5)]);

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const transition = transitionOf(result, callerFn);
    expect(transition.external_effects).toEqual([]);
    expect(
      transition.unknowns.some(
        (entry) => entry.reason === 'no_evidence' && entry.basis.includes(bareCall.id),
      ),
    ).toBe(true);
  });

  it('B3: Function.mutability maps payable to value_handling payable and nonpayable to nonpayable', () => {
    const state = miniState();
    const store = state.contract('Store');
    const target = state.contract('Target');
    const targetFn = state.fn(target, 'act', { source: 'Target.sol:1-10' });
    const paid = state.fn(store, 'deposit', {
      mutability: 'payable',
      source: 'Store.sol:1-20',
    });
    const unpaid = state.fn(store, 'pull', {
      mutability: 'nonpayable',
      source: 'Store.sol:21-40',
    });
    state.rel('CALLS', paid.id, targetFn.id, [sourceSpan('Store.sol', 5)], {
      call_kind: 'external',
    });
    state.rel('CALLS', unpaid.id, targetFn.id, [sourceSpan('Store.sol', 30)], {
      call_kind: 'external',
    });

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    expect(transitionOf(result, paid).external_effects[0]!.value_handling).toBe('payable');
    expect(transitionOf(result, unpaid).external_effects[0]!.value_handling).toBe(
      'nonpayable',
    );
  });

  it('B4: without Layer C evidence there are never asset_movements records, regardless of verb-like names or events', () => {
    const state = miniState();
    const vault = state.contract('Vault');
    const token = state.contract('Token');
    const owner = state.fn(vault, 'transfer', { source: 'Vault.sol:1-40' });
    const tokenFn = state.fn(token, 'transfer', { source: 'Token.sol:1-40' });
    const shares = state.stateVar(vault, 'shares');
    state.rel('CALLS', owner.id, tokenFn.id, [sourceSpan('Vault.sol', 12)], {
      call_kind: 'external',
    });
    state.rel('WRITES', owner.id, shares.id, [sourceSpan('Vault.sol', 20)]);
    state.emit(owner, 'Transfer(address,address,uint256)', [
      sourceSpan('Vault.sol', 25),
    ]);

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const transition = transitionOf(result, owner);
    expect(transition.asset_movements).toEqual([]);
    expect(transition.external_effects).toHaveLength(1);
    expect(transition.post_state_observations).toHaveLength(1);
  });

  it('B5: EMITS facts become post_state_observations in declared span order; functions without EMITS facts are empty', () => {
    const state = miniState();
    const store = state.contract('Store');
    const emitter = state.fn(store, 'poke', { source: 'Emit.sol:1-60' });
    const silent = state.fn(store, 'silent', { source: 'Emit.sol:61-70' });
    const bump = state.emit(emitter, 'Bump(uint256)', [sourceSpan('b.sol', 30)]);
    const ago = state.emit(emitter, 'Ago(uint256)', [sourceSpan('a.sol', 9)]);

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const transition = transitionOf(result, emitter);
    expect(transition.post_state_observations).toEqual([ago.id, bump.id]);
    expect([ago.id, bump.id].sort()).not.toEqual([ago.id, bump.id]);
    expect(transitionOf(result, silent).post_state_observations).toEqual([]);
  });

  it('B6: unsupported_assembly issue touching the file flags assembly_skipped; dropped file suppresses the record and yields dropped_file unknown', () => {
    const state = miniState();
    const asmStore = state.contract('AsmStore');
    const dropStore = state.contract('DropStore');
    const keptStore = state.contract('KeptStore');
    const step = state.fn(asmStore, 'step', { source: 'asm.sol:1-30' });
    const lost = state.fn(dropStore, 'run', { source: 'drop.sol:1-30' });
    const kept = state.fn(keptStore, 'keep', { source: 'kept.sol:1-20' });
    state.issue({
      severity: 'UNKNOWN',
      code: 'unsupported_assembly',
      message: 'Yul/assembly bodies are not modeled',
      file: 'asm.sol',
      line_start: 5,
      line_end: 8,
    });
    state.issue({
      severity: 'RECOVERABLE',
      code: 'compilation_failed',
      message: 'dropping drop.sol: syntax errors prevent parsing',
      file: 'drop.sol',
      line_start: 1,
      line_end: 1,
    });

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const flagged = transitionOf(result, step);
    expect(flagged.fidelity_flags).toEqual(['assembly_skipped']);
    expect(
      flagged.unknowns.some((entry) => entry.reason === 'unsupported_assembly'),
    ).toBe(true);
    expect(result.flags).toEqual(new Set([step.id]));

    expect(result.transitions.some((t) => t.function_id === lost.id)).toBe(false);
    expect(result.unknowns.map((entry) => entry.reason)).toEqual([
      'dropped_file',
      'unsupported_assembly',
    ]);
    const dropped = result.unknowns.find((entry) => entry.reason === 'dropped_file')!;
    expect(dropped.record_ref).toBe(lost.id);

    expect(transitionOf(result, kept).fidelity_flags).toEqual([]);
    expect(result.flags.has(kept.id)).toBe(false);
  });

  it('B6: syntactic input fidelity flags every transition syntactic', () => {
    const state = miniState();
    const store = state.contract('Store');
    const fn = state.fn(store, 'run', { source: 'Store.sol:1-20' });

    const result = deriveTransitions(state.buildIndex({ fidelity: 'syntactic' }));
    expectParseable(result);

    expect(transitionOf(result, fn).fidelity_flags).toEqual(['syntactic']);
    expect(result.flags).toEqual(new Set([fn.id]));
  });

  it('B7: external effects are ordered by provenance span (file, line) regardless of insertion or id order', () => {
    const state = miniState();
    const store = state.contract('Store');
    const runner = state.fn(store, 'run', { source: 'main.sol:1-60' });
    const zulu = state.contract('Zulu');
    const alpha = state.contract('Alpha');
    const zuluFn = state.fn(zulu, 'zedHook', { source: 'Zulu.sol:1-10' });
    const alphaFn = state.fn(alpha, 'aaaHook', { source: 'Alpha.sol:1-10' });
    const zuluCall = state.rel('CALLS', runner.id, zuluFn.id, [sourceSpan('b.sol', 10)], {
      call_kind: 'external',
    });
    const alphaCall = state.rel('CALLS', runner.id, alphaFn.id, [sourceSpan('a.sol', 5)], {
      call_kind: 'external',
    });

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    const transition = transitionOf(result, runner);
    expect(transition.external_effects.map((effect) => effect.basis[0])).toEqual([
      alphaCall.id,
      zuluCall.id,
    ]);
    expect([alphaCall.id, zuluCall.id].sort()).not.toEqual([alphaCall.id, zuluCall.id]);
  });

  it('B7: transition records are ordered by function source span (file, line) regardless of insertion or id order', () => {
    const state = miniState();
    const store = state.contract('Store');
    const aaa = state.fn(store, 'aaa', { source: 'b.sol:1-10' });
    const zed = state.fn(store, 'zed', { source: 'a.sol:1-10' });

    const result = deriveTransitions(state.buildIndex());
    expectParseable(result);

    expect(result.transitions.map((record) => record.function_id)).toEqual([
      zed.id,
      aaa.id,
    ]);
    expect([zed.id, aaa.id].sort()).not.toEqual([zed.id, aaa.id]);
  });

  it('honesty: transition records declare no branch-, path-, order-, or value-sensitive keys', () => {
    const state = miniState();
    const store = state.contract('Store');
    const target = state.contract('Target');
    const paid = state.fn(store, 'deposit', {
      mutability: 'payable',
      source: 'Store.sol:1-40',
    });
    const targetFn = state.fn(target, 'act', { source: 'Target.sol:1-20' });
    const shares = state.stateVar(store, 'shares');
    state.rel('READS', paid.id, shares.id, [sourceSpan('Store.sol', 4)]);
    state.rel('WRITES', paid.id, shares.id, [sourceSpan('Store.sol', 6)]);
    state.rel('CALLS', paid.id, targetFn.id, [sourceSpan('Store.sol', 8)], {
      call_kind: 'external',
    });
    state.marker(paid, 'CALLS', 'unresolved-lowlevel-call', [
      sourceSpan('Store.sol', 10),
    ]);
    state.emit(paid, 'Deposit(uint256)', [sourceSpan('Store.sol', 12)]);

    const result = deriveTransitions(state.buildIndex());
    expect(result.transitions.length).toBeGreaterThan(0);

    const found = new Set<string>();
    for (const transition of result.transitions) collectKeys(transition, found);
    expect([...found].filter((key) => FORBIDDEN_KEYS.includes(key))).toEqual([]);
  });

  it('determinism: repeated derivation over the same index is byte-equal, schema-valid, and read-only', () => {
    const state = miniState();
    const asmStore = state.contract('AsmStore');
    const dropStore = state.contract('DropStore');
    const caller = state.contract('Caller');
    const token = state.contract('Token');
    const step = state.fn(asmStore, 'step', { source: 'asm.sol:1-30' });
    const lost = state.fn(dropStore, 'run', { source: 'drop.sol:1-30' });
    const puller = state.fn(caller, 'pull', { source: 'Caller.sol:1-40' });
    const grabbed = state.fn(token, 'grab', { source: 'Token.sol:1-20' });
    state.rel('CALLS', puller.id, grabbed.id, [sourceSpan('Caller.sol', 12)], {
      call_kind: 'external',
    });
    state.marker(puller, 'CALLS', 'unresolved-lowlevel-call', [
      sourceSpan('Caller.sol', 20),
    ]);
    state.emit(puller, 'Pulled(uint256)', [sourceSpan('Caller.sol', 30)]);
    state.issue({
      severity: 'UNKNOWN',
      code: 'unsupported_assembly',
      message: 'Yul/assembly bodies are not modeled',
      file: 'asm.sol',
      line_start: 5,
      line_end: 8,
    });
    state.issue({
      severity: 'RECOVERABLE',
      code: 'compilation_failed',
      message: 'dropping drop.sol: syntax errors prevent parsing',
      file: 'drop.sol',
      line_start: 1,
      line_end: 1,
    });

    const index = state.buildIndex();
    const stateBefore = JSON.stringify(index.input.state);
    const first = deriveTransitions(index);
    const second = deriveTransitions(index);

    expect(second.transitions).toEqual(first.transitions);
    expect(second.unknowns).toEqual(first.unknowns);
    expect([...second.flags]).toEqual([...first.flags]);
    expect(first.flags).toBeInstanceOf(Set);
    expect(JSON.stringify(index.input.state)).toBe(stateBefore);
    expectParseable(first);

    expect(first.transitions.map((record) => record.function_id)).toEqual([
      puller.id,
      grabbed.id,
      step.id,
    ]);
    expect(first.unknowns.map((entry) => entry.reason).sort()).toEqual([
      'dropped_file',
      'unresolved_call',
      'unsupported_assembly',
    ]);
  });
});
