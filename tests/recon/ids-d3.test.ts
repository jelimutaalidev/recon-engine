import { describe, expect, it } from 'vitest';
import { createContract } from '../../src/domain/contract.js';
import { normalizeSourceFile } from '../../src/ids/normalize.js';
import { sourceContractId } from '../../src/ids/ids.js';
import { createReconState } from '../../src/recon-state/state.js';
import { ReconError } from '../../src/errors/errors.js';

describe('D3: normalizeSourceFile', () => {
  it('converts posix paths with directory separators', () => {
    expect(normalizeSourceFile('src/Vault.sol')).toBe('src__vault_sol');
  });

  it('converts windows path separators', () => {
    expect(normalizeSourceFile('src\\Vault.sol')).toBe('src__vault_sol');
  });

  it('maps dots and other non-alphanumerics to underscore', () => {
    expect(normalizeSourceFile('lib/oz@4.8/Core.sol')).toBe('lib__oz_4_8__core_sol');
  });

  it('strips leading ./ segments', () => {
    expect(normalizeSourceFile('./src/Vault.sol')).toBe('src__vault_sol');
  });

  it('rejects empty paths', () => {
    expect(() => normalizeSourceFile('   ')).toThrow(ReconError);
  });
});

describe('D3: sourceContractId', () => {
  it('matches the approved example format', () => {
    expect(sourceContractId('src/Vault.sol', 'Vault')).toBe('contract:src__vault_sol:vault');
  });

  it('keeps contract name segment case-normalized (lowercase)', () => {
    expect(sourceContractId('contracts/MyToken.sol', 'MyToken')).toBe(
      'contract:contracts__mytoken_sol:mytoken',
    );
  });
});

describe('D3: createContract identity rule', () => {
  it('uses sourceContractId when source_file present without address', () => {
    const contract = createContract({
      name: 'Vault',
      contract_type: 'unknown',
      source_file: 'src/Vault.sol',
    });
    expect(contract.id).toBe('contract:src__vault_sol:vault');
  });

  it('prefers address-bound identity when address and chain are present', () => {
    const contract = createContract({
      name: 'Vault',
      contract_type: 'unknown',
      source_file: 'src/Vault.sol',
      address: '0xaabbccddeeff001122334455667788990011aabb',
      chain_id: 'ethereum',
    });
    expect(contract.id).toBe('contract:ethereum:0xaabbccddeeff001122334455667788990011aabb');
  });

  it('falls back to name-based identity without address and source_file', () => {
    const contract = createContract({ name: 'Vault', contract_type: 'vault' });
    expect(contract.id).toBe('contract:Vault');
  });
});

describe('D3: ReconState validation', () => {
  it('accepts source-scoped contract ids', () => {
    const state = createReconState({
      schema_version: 'recon-state/v1',
      contracts: [
        createContract({
          name: 'Vault',
          contract_type: 'unknown',
          source_file: 'src/Vault.sol',
        }),
      ],
    });
    expect(state.contracts[0]?.id).toBe('contract:src__vault_sol:vault');
  });

  it('rejects duplicate ids after path normalization (case-colliding files)', () => {
    expect(() =>
      createReconState({
        schema_version: 'recon-state/v1',
        contracts: [
          createContract({ name: 'Vault', contract_type: 'unknown', source_file: 'src/A.sol' }),
          createContract({ name: 'Vault', contract_type: 'unknown', source_file: 'src/a.sol' }),
        ],
      }),
    ).toThrow(/DuplicateCanonicalEntity|more than once/);
  });
});
