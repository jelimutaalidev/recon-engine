import { describe, expect, it } from 'vitest';
import { createContract, type Contract } from '../../../src/domain/contract.js';
import type { Mutability, Visibility } from '../../../src/domain/enums.js';
import { createFunction, type SolidityFunction } from '../../../src/domain/function.js';
import type { ReconIssue } from '../../../src/recon/issues.js';
import { createReconState } from '../../../src/recon-state/state.js';
import { buildEvidenceIndex, type EvidenceIndex } from '../../../src/semantic/evidence.js';
import { stableStringify } from '../../../src/util/canonical.js';
import {
  deriveTemporals,
  TemporalSourceSchema,
  type TemporalSource,
} from '../../../src/semantic/esm/temporal.js';

const BUILTIN_MESSAGE = 'msg./block./tx. builtins are not modeled';

function miniState() {
  const contracts: Contract[] = [];
  const functions: SolidityFunction[] = [];
  const issues: ReconIssue[] = [];

  return {
    contract(name: string): Contract {
      const record = createContract({ name, contract_type: 'core' });
      contracts.push(record);
      return record;
    },
    fn(contract: Contract, name: string, source?: string): SolidityFunction {
      const record = createFunction({
        contract_id: contract.id,
        name,
        visibility: 'external' as Visibility,
        mutability: 'nonpayable' as Mutability,
        modifiers: [],
        ...(source !== undefined ? { source } : {}),
      });
      functions.push(record);
      return record;
    },
    issue(record: ReconIssue): void {
      issues.push(record);
    },
    builtinIssue(options: {
      file?: string;
      lineStart?: number;
      lineEnd?: number;
      message?: string;
    }): void {
      issues.push({
        severity: 'UNSUPPORTED',
        code: 'unsupported_builtin',
        message: options.message ?? BUILTIN_MESSAGE,
        ...(options.file !== undefined ? { file: options.file } : {}),
        ...(options.lineStart !== undefined ? { line_start: options.lineStart } : {}),
        ...(options.lineEnd !== undefined ? { line_end: options.lineEnd } : {}),
      });
    },
    buildIndex(): EvidenceIndex {
      const state = createReconState({
        contracts,
        functions,
        state_variables: [],
        relationships: [],
        facts: [],
      });
      return buildEvidenceIndex({
        state,
        issues,
        meta: { fidelity: 'semantic', fileCount: 1 },
      });
    },
  };
}

describe('deriveTemporals', () => {
  it('builtin-class issue with file+line inside one function span yields a marker with that consumer', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
    const { temporals, unknowns } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    const temporal = temporals[0]!;
    expect(temporal.kind).toBe('UNKNOWN-kind');
    expect(temporal.consumers).toEqual([payout.id]);
    expect(temporal.basis).toContain(payout.id);
    expect(temporal.id).toMatch(/^seme:[0-9a-f]{16}$/);
    expect(TemporalSourceSchema.safeParse(temporal).success).toBe(true);
    expect(unknowns).toEqual([]);
  });

  it('class-only occurrence yields UNKNOWN-kind with the label in basis text only', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    const temporal = temporals[0]!;
    expect(temporal.kind).toBe('UNKNOWN-kind');
    expect(temporal.kind).not.toContain('block');
    expect(temporal.kind).not.toContain('msg.');
    expect(temporal.consumers).toEqual([payout.id]);
    expect(temporal.basis.join('\n')).toContain('block.');
    expect(temporal.id).not.toContain('block');
  });

  it('specific-builtin message still yields UNKNOWN-kind, never a finer kind', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({
      file: 'Vault.sol',
      lineStart: 13,
      lineEnd: 13,
      message: 'block.timestamp is not modeled',
    });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    expect(temporals[0]!.kind).toBe('UNKNOWN-kind');
    expect(temporals[0]!.basis.join('\n')).toContain('block.timestamp is not modeled');
  });

  it('ambiguous attribution across two functions yields one UNKNOWN-kind record with empty consumers', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const deposit = s.fn(vault, 'deposit', 'Vault.sol:10-18');
    const withdraw = s.fn(vault, 'withdraw', 'Vault.sol:20-28');
    s.builtinIssue({ file: 'Vault.sol', lineStart: 12, lineEnd: 24 });
    const { temporals, unknowns } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    const temporal = temporals[0]!;
    expect(temporal.kind).toBe('UNKNOWN-kind');
    expect(temporal.consumers).toEqual([]);
    expect(temporal.basis.join('\n')).toContain('Vault.sol');
    expect(temporal.basis).not.toContain(deposit.id);
    expect(temporal.basis).not.toContain(withdraw.id);
    expect(unknowns).toEqual([]);
  });

  it('occurrence outside every function span yields empty consumers with the occurrence retained', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({ file: 'Vault.sol', lineStart: 40, lineEnd: 40 });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    expect(temporals[0]!.kind).toBe('UNKNOWN-kind');
    expect(temporals[0]!.consumers).toEqual([]);
    expect(temporals[0]!.basis.join('\n')).toContain('Vault.sol:40-40');
  });

  it('fileless issue yields an UNKNOWN-kind record without treating the empty key as a path', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const payout = s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({ lineStart: 13, lineEnd: 13 });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    const temporal = temporals[0]!;
    expect(temporal.kind).toBe('UNKNOWN-kind');
    expect(temporal.consumers).toEqual([]);
    expect(temporal.consumers).not.toContain(payout.id);
    expect(temporal.basis.join('\n')).not.toContain('.sol');
  });

  it('missing line provenance yields an UNKNOWN-kind record with empty consumers', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.issue({
      severity: 'UNSUPPORTED',
      code: 'unsupported_builtin',
      message: BUILTIN_MESSAGE,
      file: 'Vault.sol',
    });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    expect(temporals[0]!.kind).toBe('UNKNOWN-kind');
    expect(temporals[0]!.consumers).toEqual([]);
  });

  it('no occurrence record yields no record at all', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.issue({
      severity: 'UNSUPPORTED',
      code: 'unsupported_assembly',
      message: 'Yul/assembly bodies are not modeled',
      file: 'Vault.sol',
      line_start: 13,
      line_end: 13,
    });
    expect(deriveTemporals(s.buildIndex())).toEqual({ temporals: [], unknowns: [] });
  });

  it('non-builtin issues co-located with the span are ignored', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.issue({
      severity: 'RECOVERABLE',
      code: 'call_target_unresolved',
      message: 'call target unresolved in Vault.sol',
      file: 'Vault.sol',
      line_start: 13,
      line_end: 13,
    });
    expect(deriveTemporals(s.buildIndex())).toEqual({ temporals: [], unknowns: [] });
  });

  it('value and ordering fields are absent from the record shape', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(1);
    const temporal = temporals[0]!;
    expect('value' in temporal).toBe(false);
    expect('ordering' in temporal).toBe(false);
    expect('ordering-effect' in temporal).toBe(false);
    expect(TemporalSourceSchema.safeParse({ ...temporal, value: 'unknown' }).success).toBe(false);
    expect(TemporalSourceSchema.safeParse({ ...temporal, ordering: 'unknown' }).success).toBe(
      false,
    );
    const serialized = stableStringify(temporals);
    expect(serialized).not.toContain('time-dependent');
    expect(serialized).not.toContain('ordering-effect');
  });

  it('is deterministic across runs and insertion order', () => {
    const build = (): { temporals: TemporalSource[]; unknowns: unknown[] } => {
      const s = miniState();
      const vault = s.contract('Vault');
      s.fn(vault, 'payout', 'Vault.sol:10-20');
      s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
      return deriveTemporals(s.buildIndex());
    };
    const forward = build();
    const repeat = build();
    expect(stableStringify(repeat)).toBe(stableStringify(forward));

    const swapped = ((): { temporals: TemporalSource[]; unknowns: unknown[] } => {
      const s = miniState();
      const vault = s.contract('Vault');
      s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
      s.fn(vault, 'payout', 'Vault.sol:10-20');
      return deriveTemporals(s.buildIndex());
    })();
    expect(stableStringify(swapped)).toBe(stableStringify(forward));
  });

  it('sorts temporals by id in code-unit order', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    const zeta = s.contract('Zeta');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.fn(zeta, 'settle', 'Zeta.sol:10-20');
    s.builtinIssue({ file: 'Zeta.sol', lineStart: 12, lineEnd: 12 });
    s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
    const { temporals } = deriveTemporals(s.buildIndex());

    expect(temporals).toHaveLength(2);
    const ids = temporals.map((temporal) => temporal.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('TemporalSourceSchema rejects excess keys and finer kinds', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    s.builtinIssue({ file: 'Vault.sol', lineStart: 13, lineEnd: 13 });
    const { temporals } = deriveTemporals(s.buildIndex());
    const temporal = temporals[0]!;

    expect(TemporalSourceSchema.safeParse(temporal).success).toBe(true);
    expect(TemporalSourceSchema.safeParse({ ...temporal, kind: 'block.timestamp' }).success).toBe(
      false,
    );
    expect(TemporalSourceSchema.safeParse({ ...temporal, kind: 'unknown-kind' }).success).toBe(
      false,
    );
    expect(TemporalSourceSchema.safeParse({ ...temporal, basis: [] }).success).toBe(false);
    expect(TemporalSourceSchema.safeParse({ ...temporal, consumers: [''] }).success).toBe(false);
  });

  it('empty input yields empty output', () => {
    const s = miniState();
    const vault = s.contract('Vault');
    s.fn(vault, 'payout', 'Vault.sol:10-20');
    expect(deriveTemporals(s.buildIndex())).toEqual({ temporals: [], unknowns: [] });
  });
});
