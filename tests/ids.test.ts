import { describe, expect, it } from 'vitest';
import {
  assetId,
  contractId,
  contentId,
  dependencyId,
  functionId,
  projectId,
  roleId,
  stateVariableId,
} from '../src/ids/ids.js';
import { normalizeAddress, normalizeChainId, normalizeName } from '../src/ids/normalize.js';
import { ReconError, isReconError } from '../src/errors/errors.js';

describe('normalizeAddress', () => {
  it('lowercases a checksummed address', () => {
    expect(normalizeAddress('0xAaBbCcDdEeFf0011223344556677889900aAbBcC')).toBe(
      '0xaabbccddeeff0011223344556677889900aabbcc',
    );
  });

  it('rejects an address that is not 20 bytes', () => {
    expect(() => normalizeAddress('0x1234')).toThrowError(
      expect.objectContaining({ code: 'InvalidIdentifier' }),
    );
  });

  it('rejects a non-hex address', () => {
    expect(() => normalizeAddress('0xzzbbccddeeff0011223344556677889900aabbcc')).toThrowError(
      expect.objectContaining({ code: 'InvalidIdentifier' }),
    );
  });
});

describe('normalizeChainId', () => {
  it('trims and lowercases chain identifiers', () => {
    expect(normalizeChainId(' Ethereum ')).toBe('ethereum');
  });

  it('rejects an empty chain id', () => {
    expect(() => normalizeChainId('   ')).toThrowError(
      expect.objectContaining({ code: 'InvalidIdentifier' }),
    );
  });
});

describe('normalizeName', () => {
  it('trims surrounding whitespace but preserves case', () => {
    expect(normalizeName('  Vault  ')).toBe('Vault');
  });

  it('rejects an empty name', () => {
    expect(() => normalizeName('   ')).toThrowError(
      expect.objectContaining({ code: 'InvalidIdentifier' }),
    );
  });
});

describe('entity id builders', () => {
  const address = '0xAaBbCcDdEeFf0011223344556677889900aAbBcC';

  it('builds project ids from the name', () => {
    expect(projectId('Acme Vault')).toBe('project:Acme Vault');
  });

  it('builds address-bound contract ids with normalized chain and address', () => {
    expect(contractId({ chainId: 'Ethereum', address, name: 'Vault' })).toBe(
      'contract:ethereum:0xaabbccddeeff0011223344556677889900aabbcc',
    );
  });

  it('builds source-only contract ids from the name', () => {
    expect(contractId({ name: ' Vault ' })).toBe('contract:Vault');
  });

  it('produces the same contract id for checksummed and lowercase addresses', () => {
    const a = contractId({ chainId: 'ethereum', address });
    const b = contractId({
      chainId: 'ethereum',
      address: address.toLowerCase(),
    });
    expect(a).toBe(b);
  });

  it('builds function ids scoped to the contract and signature', () => {
    const c = contractId({ chainId: 'ethereum', address });
    expect(functionId(c, 'deposit(uint256)')).toBe(
      `function:${c}:deposit(uint256)`,
    );
  });

  it('builds state variable ids scoped to the contract', () => {
    const c = contractId({ name: 'Vault' });
    expect(stateVariableId(c, 'totalShares')).toBe('state:contract:Vault:totalShares');
  });

  it('builds asset ids from chain and address when present', () => {
    expect(assetId({ chainId: 'ethereum', address, name: 'USDC' })).toBe(
      'asset:ethereum:0xaabbccddeeff0011223344556677889900aabbcc',
    );
  });

  it('builds name-based asset ids when no address exists (native assets)', () => {
    expect(assetId({ name: 'ETH' })).toBe('asset:ETH');
  });

  it('builds contract-scoped role ids when a contract is present', () => {
    const c = contractId({ name: 'Vault' });
    expect(roleId(c, 'owner')).toBe('role:contract:Vault:owner');
  });

  it('builds name-based role ids without contract scope', () => {
    expect(roleId(undefined, 'guardian')).toBe('role:guardian');
  });

  it('builds dependency ids from chain and address when present', () => {
    expect(dependencyId({ chainId: 'ethereum', address })).toBe(
      'dependency:ethereum:0xaabbccddeeff0011223344556677889900aabbcc',
    );
  });

  it('builds name-based dependency ids when no address exists', () => {
    expect(dependencyId({ name: 'Chainlink' })).toBe('dependency:Chainlink');
  });
});

describe('contentId', () => {
  it('is deterministic for the same payload', () => {
    const payload = { subject: 'function:Vault.deposit', predicate: 'WRITES' };
    expect(contentId('fact', payload)).toBe(contentId('fact', payload));
  });

  it('ignores object key ordering', () => {
    expect(contentId('fact', { a: 1, b: 2 })).toBe(contentId('fact', { b: 2, a: 1 }));
  });

  it('changes when the payload changes', () => {
    expect(contentId('fact', { a: 1 })).not.toBe(contentId('fact', { a: 2 }));
  });

  it('is namespaced by prefix', () => {
    const payload = { a: 1 };
    expect(contentId('fact', payload)).not.toBe(contentId('obs', payload));
  });

  it('produces stable-length hex digests', () => {
    expect(contentId('fact', { a: 1 })).toMatch(/^fact:[0-9a-f]{16}$/);
  });
});

describe('ReconError', () => {
  it('carries a machine-readable code and details', () => {
    const err = new ReconError('MissingProvenance', 'fact requires provenance', {
      factId: 'fact:abc',
    });
    expect(err.code).toBe('MissingProvenance');
    expect(err.details).toEqual({ factId: 'fact:abc' });
    expect(isReconError(err)).toBe(true);
  });

  it('is not confused with a plain Error', () => {
    expect(isReconError(new Error('nope'))).toBe(false);
  });
});
