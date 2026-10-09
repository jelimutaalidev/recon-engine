import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import { createFact, type Fact } from '../../../src/epistemic/fact.js';
import type { ProvenanceInput } from '../../../src/epistemic/provenance.js';
import type { ReconIssue } from '../../../src/recon/issues.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { stableStringify } from '../../../src/util/canonical.js';
import {
  deriveConditions,
  ConditionSchema,
  type Condition,
} from '../../../src/semantic/esm/conditions.js';

const CREATED_AT = '2024-01-01T00:00:00.000Z';

function span(file: string, lineStart: number, lineEnd = lineStart): ProvenanceInput {
  return { source_type: 'source_code', file, line_start: lineStart, line_end: lineEnd };
}

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
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
      options?: {
        modifiers?: string[];
        visibility?: Visibility;
        mutability?: Mutability;
        source?: string;
      },
    ): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: options?.visibility ?? ('external' as Visibility),
        mutability: options?.mutability ?? ('nonpayable' as Mutability),
        modifiers: options?.modifiers ?? [],
        ...(options?.source !== undefined ? { source: options.source } : {}),
      });
      functions.push(record);
      return record;
    },
    constructIssue(
      code: string,
      file?: string,
      lineStart?: number,
      lineEnd?: number,
    ): void {
      issues.push({
        severity: 'UNSUPPORTED',
        code,
        message: `${code} construct present`,
        ...(file !== undefined ? { file } : {}),
        ...(lineStart !== undefined ? { line_start: lineStart } : {}),
        ...(lineEnd !== undefined ? { line_end: lineEnd } : {}),
      });
    },
    otherIssue(code: string, file: string, lineStart: number, lineEnd = lineStart): void {
      issues.push({
        severity: 'RECOVERABLE',
        code,
        message: `${code} note`,
        file,
        line_start: lineStart,
        line_end: lineEnd,
      });
    },
    usesFact(subjectId: string, value: string, provenance: ProvenanceInput[]): Fact {
      const record = createFact({
        subject_id: subjectId,
        predicate: 'USES',
        value,
        provenance,
        created_at: CREATED_AT,
      });
      facts.push(record);
      return record;
    },
    emitsFact(subjectId: string, value: string, provenance: ProvenanceInput[]): Fact {
      const record = createFact({
        subject_id: subjectId,
        predicate: 'EMITS',
        value,
        provenance,
        created_at: CREATED_AT,
      });
      facts.push(record);
      return record;
    },
    buildIndex(): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: [],
        relationships: [],
        facts,
      });
      return buildEvidenceIndex({
        state,
        issues,
        meta: { fidelity: 'semantic', fileCount: 1 },
      });
    },
  };
}

function gatePairs(conditions: Condition[], functionId: string): Array<[string, string]> {
  return conditions
    .filter((entry) => entry.function === functionId && entry.kind !== 'unresolved-branch')
    .map((entry) => [entry.kind, entry.descriptor] as [string, string])
    .sort();
}

describe('deriveConditions', () => {
  it('modifier list yields one gate record per modifier with the exact verbatim name', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const withdraw = s.fn(vault, 'withdraw', {
      modifiers: ['onlyOwner', 'nonReentrant'],
      source: 'Vault.sol:10-20',
    });
    const { conditions } = deriveConditions(s.buildIndex());

    const gates = conditions.filter(
      (entry) => entry.function === withdraw.id && entry.kind === 'modifier-gate',
    );
    expect(gates).toHaveLength(2);
    expect(gates.map((entry) => entry.descriptor).sort()).toEqual([
      'nonReentrant',
      'onlyOwner',
    ]);
    for (const gate of gates) {
      expect(gate.basis).toEqual([withdraw.id]);
      expect(gate.id).toMatch(/^seme:[0-9a-f]{16}$/);
      expect(ConditionSchema.safeParse(gate).success).toBe(true);
    }
  });

  it('visibility and mutability fields yield gate records with verbatim values', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const deposit = s.fn(vault, 'deposit', {
      visibility: 'external' as Visibility,
      mutability: 'payable' as Mutability,
      source: 'Vault.sol:10-20',
    });
    const { conditions } = deriveConditions(s.buildIndex());

    const visibility = conditions.filter(
      (entry) => entry.function === deposit.id && entry.kind === 'visibility-gate',
    );
    const mutability = conditions.filter(
      (entry) => entry.function === deposit.id && entry.kind === 'mutability-gate',
    );
    expect(visibility).toHaveLength(1);
    expect(visibility[0]!.descriptor).toBe('external');
    expect(visibility[0]!.basis).toEqual([deposit.id]);
    expect(mutability).toHaveLength(1);
    expect(mutability[0]!.descriptor).toBe('payable');
    expect(mutability[0]!.basis).toEqual([deposit.id]);
  });

  it('gate-inventory holds in both directions: every present field yields a gate and no gate lacks a field', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const settle = s.fn(vault, 'settle', {
      modifiers: ['onlyOwner', 'onlyRole(0xabc)'],
      visibility: 'external' as Visibility,
      mutability: 'nonpayable' as Mutability,
      source: 'Vault.sol:10-20',
    });
    const { conditions } = deriveConditions(s.buildIndex());

    const expected: Array<[string, string]> = [
      ['modifier-gate', 'onlyOwner'],
      ['modifier-gate', 'onlyRole(0xabc)'],
      ['mutability-gate', 'nonpayable'],
      ['visibility-gate', 'external'],
    ];
    expected.sort();
    const actual = gatePairs(conditions, settle.id);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(2 + 2);
  });

  it('present-but-unknown visibility and mutability still yield their gates', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const fallback = s.fn(vault, 'fallback', {
      visibility: 'unknown' as Visibility,
      mutability: 'unknown' as Mutability,
      source: 'Vault.sol:10-20',
    });
    const { conditions, unknowns } = deriveConditions(s.buildIndex());

    expect(gatePairs(conditions, fallback.id)).toEqual([
      ['mutability-gate', 'unknown'],
      ['visibility-gate', 'unknown'],
    ]);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.reason).toBe('no_evidence');
    expect(unknowns[0]!.scope).toBe('modifier-gate');
    expect(unknowns[0]!.basis).toEqual([fallback.id]);
  });

  it('duplicate modifier entries collapse to a single gate record', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const guarded = s.fn(vault, 'guarded', {
      modifiers: ['onlyOwner', 'onlyOwner'],
      source: 'Vault.sol:10-20',
    });
    const { conditions } = deriveConditions(s.buildIndex());

    const gates = conditions.filter(
      (entry) => entry.function === guarded.id && entry.kind === 'modifier-gate',
    );
    expect(gates).toHaveLength(1);
    expect(gates[0]!.descriptor).toBe('onlyOwner');
  });

  it('modifier argsText is recorded verbatim opaque and never split for meaning', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const gated = s.fn(vault, 'gated', {
      modifiers: ['onlyRole(0x0000000000000000000000000000000000000001)'],
      source: 'Vault.sol:10-20',
    });
    const { conditions } = deriveConditions(s.buildIndex());

    const gates = conditions.filter(
      (entry) => entry.function === gated.id && entry.kind === 'modifier-gate',
    );
    expect(gates).toHaveLength(1);
    expect(gates[0]!.descriptor).toBe(
      'onlyRole(0x0000000000000000000000000000000000000001)',
    );
    expect('args' in gates[0]!).toBe(false);
    expect('argsText' in gates[0]!).toBe(false);
    expect(ConditionSchema.safeParse({ ...gates[0]!, argsText: '0x01' }).success).toBe(false);
  });

  it('flagged assembly issue with file+line yields a scoped unresolved-branch with existence-evidence basis', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', { source: 'Vault.sol:10-20' });
    s.constructIssue('unsupported_assembly', 'Vault.sol', 13, 13);
    const { conditions } = deriveConditions(s.buildIndex());

    const branches = conditions.filter((entry) => entry.kind === 'unresolved-branch');
    expect(branches).toHaveLength(1);
    const branch = branches[0]!;
    expect(branch.function).toBe(payout.id);
    expect(branch.descriptor).toBe('unsupported_assembly');
    expect(branch.basis).toContain(payout.id);
    expect(branch.basis).toContain('unsupported_assembly@Vault.sol:13-13');
    expect(branch.basis.length).toBeGreaterThanOrEqual(2);
    expect(branch.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(ConditionSchema.safeParse(branch).success).toBe(true);
  });

  it('sibling flagged-construct issue yields an unresolved-branch with the same linkage shape', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const relay = s.fn(vault, 'relay', { source: 'Vault.sol:30-45' });
    s.constructIssue('unsupported_try_catch', 'Vault.sol', 36, 40);
    const { conditions } = deriveConditions(s.buildIndex());

    const branches = conditions.filter((entry) => entry.kind === 'unresolved-branch');
    expect(branches).toHaveLength(1);
    expect(branches[0]!.function).toBe(relay.id);
    expect(branches[0]!.descriptor).toBe('unsupported_try_catch');
    expect(branches[0]!.basis).toContain(relay.id);
    expect(branches[0]!.basis).toContain('unsupported_try_catch@Vault.sol:36-40');
  });

  it('custom-error USES fact yields a scoped unresolved-branch keyed by the verbatim signature value', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const withdraw = s.fn(vault, 'withdraw', { source: 'Vault.sol:10-20' });
    const fact = s.usesFact(
      withdraw.id,
      'custom-error:InsufficientBalance(uint256)',
      [span('Vault.sol', 15)],
    );
    const { conditions } = deriveConditions(s.buildIndex());

    const branches = conditions.filter((entry) => entry.kind === 'unresolved-branch');
    expect(branches).toHaveLength(1);
    const branch = branches[0]!;
    expect(branch.function).toBe(withdraw.id);
    expect(branch.descriptor).toBe('custom-error:InsufficientBalance(uint256)');
    expect(branch.basis).toContain(withdraw.id);
    expect(branch.basis).toContain(fact.id);
    expect(branch.basis.length).toBeGreaterThanOrEqual(2);
  });

  it('non-custom USES shapes and EMITS facts never yield unresolved-branch records', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', { source: 'Vault.sol:10-20' });
    s.emitsFact(payout.id, 'Transfer(address,uint256)', [span('Vault.sol', 12)]);
    const { conditions } = deriveConditions(s.buildIndex());

    expect(conditions.filter((entry) => entry.kind === 'unresolved-branch')).toEqual([]);
    expect(gatePairs(conditions, payout.id)).toHaveLength(2);
  });

  it('onlyOwner without backing records the gate and carries no classification fields anywhere', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const drain = s.fn(vault, 'drain', {
      modifiers: ['onlyOwner'],
      source: 'Vault.sol:10-20',
    });
    const { conditions, unknowns } = deriveConditions(s.buildIndex());

    const gates = conditions.filter(
      (entry) => entry.function === drain.id && entry.kind === 'modifier-gate',
    );
    expect(gates).toHaveLength(1);
    expect(gates[0]!.descriptor).toBe('onlyOwner');
    for (const entry of [...conditions, ...unknowns]) {
      expect(Object.keys(entry).sort()).toEqual(
        'basis' in entry && 'kind' in entry
          ? ['basis', 'descriptor', 'function', 'id', 'kind']
          : ['basis', 'id', 'reason', 'scope'],
      );
    }
    const serialized = stableStringify({ conditions, unknowns });
    expect(serialized).not.toContain('"authority_kind"');
    expect(serialized).not.toContain('"authority-kind"');
    expect(serialized).not.toContain('"owner"');
    expect(serialized).not.toContain('"admin"');
    expect(serialized).not.toContain('"role"');
    expect(ConditionSchema.safeParse({ ...gates[0]!, authority_kind: 'unknown' }).success).toBe(
      false,
    );
  });

  it('plain function with no evidencing record yields no unresolved-branch', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const plain = s.fn(vault, 'plain', { source: 'Vault.sol:10-20' });
    const { conditions } = deriveConditions(s.buildIndex());

    expect(
      conditions.filter(
        (entry) => entry.kind === 'unresolved-branch' && entry.function === plain.id,
      ),
    ).toEqual([]);
    expect(gatePairs(conditions, plain.id)).toHaveLength(2);
  });

  it('non-construct and builtin-class issues co-located with the span never yield unresolved-branch', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', { source: 'Vault.sol:10-20' });
    s.otherIssue('call_target_unresolved', 'Vault.sol', 13);
    s.constructIssue('unsupported_builtin', 'Vault.sol', 14, 14);
    const { conditions } = deriveConditions(s.buildIndex());

    expect(conditions.filter((entry) => entry.kind === 'unresolved-branch')).toEqual([]);
    expect(gatePairs(conditions, payout.id)).toHaveLength(2);
  });

  it('ambiguous attribution across two functions yields no scoped record', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const deposit = s.fn(vault, 'deposit', { source: 'Vault.sol:10-18' });
    const withdraw = s.fn(vault, 'withdraw', { source: 'Vault.sol:20-28' });
    s.constructIssue('unsupported_assembly', 'Vault.sol', 12, 24);
    const { conditions } = deriveConditions(s.buildIndex());

    expect(conditions.filter((entry) => entry.kind === 'unresolved-branch')).toEqual([]);
    expect(gatePairs(conditions, deposit.id)).toHaveLength(2);
    expect(gatePairs(conditions, withdraw.id)).toHaveLength(2);
  });

  it('issues without file+line provenance yield no unresolved-branch', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', { source: 'Vault.sol:10-20' });
    s.constructIssue('unsupported_assembly');
    s.constructIssue('unsupported_try_catch', 'Vault.sol');
    const { conditions } = deriveConditions(s.buildIndex());

    expect(conditions.filter((entry) => entry.kind === 'unresolved-branch')).toEqual([]);
    expect(gatePairs(conditions, payout.id)).toHaveLength(2);
  });

  it('occurrence outside every function span yields no unresolved-branch', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', { source: 'Vault.sol:10-20' });
    s.constructIssue('unsupported_struct_definition', 'Vault.sol', 40, 44);
    const { conditions } = deriveConditions(s.buildIndex());

    expect(conditions.filter((entry) => entry.kind === 'unresolved-branch')).toEqual([]);
    expect(gatePairs(conditions, payout.id)).toHaveLength(2);
  });

  it('function without modifiers yields a no_evidence unknown while the gate-inventory still holds', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const open = s.fn(vault, 'open', { source: 'Vault.sol:10-20' });
    const { conditions, unknowns } = deriveConditions(s.buildIndex());

    expect(gatePairs(conditions, open.id)).toHaveLength(2);
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]!.reason).toBe('no_evidence');
    expect(unknowns[0]!.scope).toBe('modifier-gate');
    expect(unknowns[0]!.basis).toEqual([open.id]);
    expect(unknowns[0]!.id).toMatch(/^seme:[0-9a-f]{16}$/);
  });

  it('function with modifiers yields no missing-gate unknown', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'guarded', { modifiers: ['onlyOwner'], source: 'Vault.sol:10-20' });
    const { unknowns } = deriveConditions(s.buildIndex());

    expect(unknowns).toEqual([]);
  });

  it('is deterministic across runs and insertion order', () => {
    const build = (): { conditions: Condition[]; unknowns: unknown[] } => {
      const s = miniState();
      const vault = s.contract('Vault');
      s.fn(vault, 'payout', { modifiers: ['onlyOwner'], source: 'Vault.sol:10-20' });
      s.constructIssue('unsupported_assembly', 'Vault.sol', 13, 13);
      return deriveConditions(s.buildIndex());
    };
    const forward = build();
    const repeat = build();
    expect(stableStringify(repeat)).toBe(stableStringify(forward));

    const swapped = ((): { conditions: Condition[]; unknowns: unknown[] } => {
      const s = miniState();
      const vault = s.contract('Vault');
      s.constructIssue('unsupported_assembly', 'Vault.sol', 13, 13);
      s.fn(vault, 'payout', { modifiers: ['onlyOwner'], source: 'Vault.sol:10-20' });
      return deriveConditions(s.buildIndex());
    })();
    expect(stableStringify(swapped)).toBe(stableStringify(forward));
  });

  it('sorts conditions and unknowns by id in code-unit order', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const zeta = s.contract('Zeta');
    s.fn(vault, 'payout', { modifiers: ['onlyOwner'], source: 'Vault.sol:10-20' });
    s.fn(zeta, 'settle', { source: 'Zeta.sol:10-20' });
    const { conditions, unknowns } = deriveConditions(s.buildIndex());

    expect(conditions.length).toBeGreaterThan(1);
    const ids = conditions.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
    const unknownIds = unknowns.map((entry) => entry.id);
    expect([...unknownIds].sort()).toEqual(unknownIds);
  });

  it('ConditionSchema rejects excess keys, bad kinds, and empty fields', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', { modifiers: ['onlyOwner'], source: 'Vault.sol:10-20' });
    const { conditions } = deriveConditions(s.buildIndex());
    const gate = conditions.find((entry) => entry.kind === 'modifier-gate')!;

    expect(ConditionSchema.safeParse(gate).success).toBe(true);
    expect(ConditionSchema.safeParse({ ...gate, kind: 'execution-gate' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...gate, descriptor: '' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...gate, function: '' }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...gate, basis: [] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...gate, extra: 'field' }).success).toBe(false);
  });

  it('empty input yields empty output', () => {
    const s = miniState();
    expect(deriveConditions(s.buildIndex())).toEqual({ conditions: [], unknowns: [] });
  });
});
