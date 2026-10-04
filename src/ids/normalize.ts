import { ReconError } from '../errors/errors.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) {
    throw new ReconError('InvalidIdentifier', 'address must be 0x-prefixed 20-byte hex', {
      address,
    });
  }
  return trimmed.toLowerCase();
}

export function normalizeChainId(chainId: string): string {
  const trimmed = chainId.trim();
  if (trimmed.length === 0) {
    throw new ReconError('InvalidIdentifier', 'chain id must not be empty', { chainId });
  }
  return trimmed.toLowerCase();
}

export function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ReconError('InvalidIdentifier', 'name must not be empty', { name });
  }
  return trimmed;
}
