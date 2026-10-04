import { describe, expect, it } from 'vitest';
import { createContract } from '../../src/domain/contract.js';
import { createStateVariable } from '../../src/domain/state-variable.js';
import { ReconError } from '../../src/errors/errors.js';

describe('D1: Contract.is_abstract', () => {
  it('accepts is_abstract true directly from compiler evidence', () => {
    const contract = createContract({
      name: 'Base',
      contract_type: 'unknown',
      source_file: 'src/Base.sol',
      is_abstract: true,
    });
    expect(contract.is_abstract).toBe(true);
  });

  it('accepts is_abstract false', () => {
    const contract = createContract({
      name: 'Impl',
      contract_type: 'unknown',
      source_file: 'src/Impl.sol',
      is_abstract: false,
    });
    expect(contract.is_abstract).toBe(false);
  });

  it('keeps is_abstract optional for existing callers', () => {
    const contract = createContract({ name: 'Vault', contract_type: 'vault' });
    expect(contract.is_abstract).toBeUndefined();
  });

  it('rejects non-boolean is_abstract', () => {
    expect(() =>
      createContract({
        name: 'Base',
        contract_type: 'unknown',
        is_abstract: 'yes',
      } as unknown as Parameters<typeof createContract>[0]),
    ).toThrow(ReconError);
  });
});

describe('D2: StateVariable.mutability', () => {
  const base = {
    contract_id: 'contract:Vault',
    name: 'totalShares',
    type: 'uint256',
    visibility: 'internal' as const,
  };

  it('accepts mutable', () => {
    expect(createStateVariable({ ...base, mutability: 'mutable' }).mutability).toBe('mutable');
  });

  it('accepts constant', () => {
    expect(createStateVariable({ ...base, name: 'MAX', mutability: 'constant' }).mutability).toBe(
      'constant',
    );
  });

  it('accepts immutable', () => {
    expect(createStateVariable({ ...base, name: 'impl', mutability: 'immutable' }).mutability).toBe(
      'immutable',
    );
  });

  it('keeps mutability optional for existing callers', () => {
    expect(createStateVariable(base).mutability).toBeUndefined();
  });

  it('rejects values outside the compiler vocabulary', () => {
    expect(() =>
      createStateVariable({ ...base, mutability: 'const' } as unknown as typeof base),
    ).toThrow(ReconError);
  });
});
