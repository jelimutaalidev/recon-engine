import { describe, expect, it } from 'vitest';
import { createProject, type ProjectInput } from '../src/domain/project.js';
import { createContract, type ContractInput } from '../src/domain/contract.js';
import { createFunction, type FunctionInput } from '../src/domain/function.js';
import {
  createStateVariable,
  type StateVariableInput,
} from '../src/domain/state-variable.js';
import { createAsset, type AssetInput } from '../src/domain/asset.js';
import { createRole, type RoleInput } from '../src/domain/role.js';
import { createDependency, type DependencyInput } from '../src/domain/dependency.js';
import { isReconError } from '../src/errors/errors.js';

const ADDR = '0xAaBbCcDdEeFf0011223344556677889900aAbBcC';

function expectSchemaFailure(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(isReconError(error)).toBe(true);
    if (isReconError(error)) {
      expect(error.code).toBe('SchemaValidationFailed');
    }
    return;
  }
  throw new Error('expected SchemaValidationFailed, but call succeeded');
}

describe('Project', () => {
  it('accepts a valid project and derives its canonical id', () => {
    const project = createProject({
      name: 'Acme Vault',
      description: 'fictional vault',
      chains: ['Ethereum'],
    });
    expect(project.id).toBe('project:Acme Vault');
    expect(project.chains).toEqual(['ethereum']);
    expect(project.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(project.updated_at).toBe(project.created_at);
  });

  it('rejects an empty project name', () => {
    expectSchemaFailure(() => createProject({ name: '   ', chains: [] }));
  });
});

describe('Contract', () => {
  it('accepts a valid deployed contract and normalizes address and chain', () => {
    const contract = createContract({
      name: 'Vault',
      address: ADDR,
      chain_id: 'Ethereum',
      contract_type: 'vault',
      source_file: 'src/Vault.sol',
      source_verified: true,
      compiler_version: '0.8.24',
      is_proxy: false,
      deployment_status: 'deployed',
    });
    expect(contract.id).toBe(
      'contract:ethereum:0xaabbccddeeff0011223344556677889900aabbcc',
    );
    expect(contract.address).toBe('0xaabbccddeeff0011223344556677889900aabbcc');
    expect(contract.chain_id).toBe('ethereum');
    expect(contract.source_verified).toBe(true);
  });

  it('accepts a source-only contract without address', () => {
    const contract = createContract({
      name: 'Vault',
      contract_type: 'vault',
    });
    expect(contract.id).toBe('contract:Vault');
    expect(contract.address).toBeUndefined();
  });

  it('rejects an unknown contract_type', () => {
    expectSchemaFailure(() =>
      createContract({ name: 'Vault', contract_type: 'money_printer' } as unknown as ContractInput),
    );
  });

  it('rejects an address without a chain id', () => {
    expectSchemaFailure(() =>
      createContract({ name: 'Vault', address: ADDR, contract_type: 'vault' }),
    );
  });

  it('rejects unknown extra fields outside the schema', () => {
    expectSchemaFailure(() =>
      createContract({
        name: 'Vault',
        contract_type: 'vault',
        backdoor: true,
      } as unknown as ContractInput),
    );
  });

  it('leaves unknown verification state unknown instead of guessing false', () => {
    const contract = createContract({ name: 'Vault', contract_type: 'vault' });
    expect(contract.source_verified).toBeUndefined();
    expect(contract.is_proxy).toBeUndefined();
  });
});

describe('Function', () => {
  it('accepts a valid function, deriving signature and canonical id', () => {
    const fn = createFunction({
      contract_id: 'contract:Vault',
      name: 'deposit',
      parameters: [{ name: 'assets', type: 'uint256' }],
      visibility: 'external',
      mutability: 'nonpayable',
      returns: [{ type: 'uint256' }],
      modifiers: ['nonReentrant'],
      selector: '0xB460AF94',
      source: 'src/Vault.sol:40-52',
    });
    expect(fn.signature).toBe('deposit(uint256)');
    expect(fn.id).toBe('function:contract:Vault:deposit(uint256)');
    expect(fn.selector).toBe('0xb460af94');
  });

  it('prefers an explicit signature and strips trivial whitespace', () => {
    const fn = createFunction({
      contract_id: 'contract:Vault',
      name: 'deposit',
      signature: ' deposit ( uint256 ) ',
      visibility: 'external',
      mutability: 'payable',
      parameters: [],
      returns: [],
      modifiers: [],
    });
    expect(fn.signature).toBe('deposit(uint256)');
  });

  it('rejects an unknown visibility', () => {
    expectSchemaFailure(() =>
      createFunction({
        contract_id: 'contract:Vault',
        name: 'deposit',
        visibility: 'visible',
        mutability: 'nonpayable',
        parameters: [],
        returns: [],
        modifiers: [],
      } as unknown as FunctionInput),
    );
  });

  it('rejects an unknown mutability', () => {
    expectSchemaFailure(() =>
      createFunction({
        contract_id: 'contract:Vault',
        name: 'deposit',
        visibility: 'external',
        mutability: 'sometimes',
        parameters: [],
        returns: [],
        modifiers: [],
      } as unknown as FunctionInput),
    );
  });

  it('rejects a malformed selector instead of guessing', () => {
    expectSchemaFailure(() =>
      createFunction({
        contract_id: 'contract:Vault',
        name: 'deposit',
        visibility: 'external',
        mutability: 'nonpayable',
        parameters: [],
        returns: [],
        modifiers: [],
        selector: 'b460af94',
      }),
    );
  });

  it('rejects an explicit signature that contradicts the function name', () => {
    expectSchemaFailure(() =>
      createFunction({
        contract_id: 'contract:Vault',
        name: 'deposit',
        signature: 'withdraw(uint256)',
        visibility: 'external',
        mutability: 'nonpayable',
        parameters: [],
        returns: [],
        modifiers: [],
      }),
    );
  });
});

describe('StateVariable', () => {
  it('accepts a valid state variable', () => {
    const variable = createStateVariable({
      contract_id: 'contract:Vault',
      name: 'totalShares',
      type: 'uint256',
      visibility: 'internal',
      slot: '0',
      source: 'src/Vault.sol:12',
    });
    expect(variable.id).toBe('state:contract:Vault:totalShares');
    expect(variable.slot).toBe('0');
  });

  it('keeps an unknown slot unknown instead of guessing', () => {
    const variable = createStateVariable({
      contract_id: 'contract:Vault',
      name: 'totalShares',
      type: 'uint256',
      visibility: 'internal',
    });
    expect(variable.slot).toBeUndefined();
  });

  it('rejects an invalid visibility for state variables', () => {
    expectSchemaFailure(() =>
      createStateVariable({
        contract_id: 'contract:Vault',
        name: 'totalShares',
        type: 'uint256',
        visibility: 'external',
      } as unknown as StateVariableInput),
    );
  });

  it('rejects a malformed storage slot', () => {
    expectSchemaFailure(() =>
      createStateVariable({
        contract_id: 'contract:Vault',
        name: 'totalShares',
        type: 'uint256',
        visibility: 'internal',
        slot: 'slot-zero',
      }),
    );
  });
});

describe('Asset', () => {
  it('accepts a valid erc20 asset', () => {
    const asset = createAsset({
      name: 'USDC',
      address: ADDR,
      chain_id: 'ethereum',
      asset_type: 'erc20',
      decimals: 6,
      custody: 'holder',
    });
    expect(asset.id).toBe(
      'asset:ethereum:0xaabbccddeeff0011223344556677889900aabbcc',
    );
    expect(asset.decimals).toBe(6);
  });

  it('accepts a native asset without address', () => {
    const asset = createAsset({ name: 'ETH', asset_type: 'native' });
    expect(asset.id).toBe('asset:ETH');
  });

  it('rejects an unknown asset_type', () => {
    expectSchemaFailure(() =>
      createAsset({ name: 'USDC', asset_type: 'coin' } as unknown as AssetInput),
    );
  });

  it('rejects decimals outside uint8 range', () => {
    expectSchemaFailure(() =>
      createAsset({ name: 'USDC', asset_type: 'erc20', decimals: 256 }),
    );
  });

  it('leaves unknown decimals unknown instead of guessing', () => {
    const asset = createAsset({
      name: 'USDC',
      address: ADDR,
      chain_id: 'ethereum',
      asset_type: 'erc20',
    });
    expect(asset.decimals).toBeUndefined();
  });

  it('rejects an address without a chain id', () => {
    expectSchemaFailure(() =>
      createAsset({ name: 'USDC', address: ADDR, asset_type: 'erc20' }),
    );
  });
});

describe('Role', () => {
  it('accepts a valid role with contract scope and normalizes holder', () => {
    const role = createRole({
      contract_id: 'contract:Vault',
      name: 'owner',
      role_type: 'owner',
      holder: ADDR,
      source: 'src/Vault.sol:8',
    });
    expect(role.id).toBe('role:contract:Vault:owner');
    expect(role.holder).toBe('0xaabbccddeeff0011223344556677889900aabbcc');
  });

  it('rejects an unknown role_type', () => {
    expectSchemaFailure(() =>
      createRole({ name: 'wizard', role_type: 'wizard' } as unknown as RoleInput),
    );
  });
});

describe('Dependency', () => {
  it('accepts a valid dependency with address and chain', () => {
    const dependency = createDependency({
      name: 'USDC',
      dependency_type: 'erc20',
      address: ADDR,
      chain_id: 'Ethereum',
      interface: 'IERC20',
      trust_level: 'trusted',
    });
    expect(dependency.id).toBe(
      'dependency:ethereum:0xaabbccddeeff0011223344556677889900aabbcc',
    );
  });

  it('accepts a name-only dependency', () => {
    const dependency = createDependency({
      name: 'Chainlink',
      dependency_type: 'oracle',
    });
    expect(dependency.id).toBe('dependency:Chainlink');
  });

  it('rejects an unknown dependency_type', () => {
    expectSchemaFailure(() =>
      createDependency({ name: 'Thing', dependency_type: 'magic' } as unknown as DependencyInput),
    );
  });

  it('rejects an address without a chain id', () => {
    expectSchemaFailure(() =>
      createDependency({ name: 'USDC', dependency_type: 'erc20', address: ADDR }),
    );
  });
});
