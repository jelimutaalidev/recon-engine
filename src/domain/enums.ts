import { z } from 'zod';

export const CONTRACT_TYPES = [
  'core',
  'token',
  'vault',
  'lending',
  'staking',
  'amm',
  'router',
  'oracle',
  'bridge',
  'proxy',
  'implementation',
  'adapter',
  'library',
  'interface',
  'governance',
  'periphery',
  'unknown',
] as const;
export const contractTypeSchema = z.enum(CONTRACT_TYPES);
export type ContractType = z.infer<typeof contractTypeSchema>;

export const VISIBILITIES = ['public', 'external', 'internal', 'private', 'unknown'] as const;
export const visibilitySchema = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof visibilitySchema>;

export const STATE_VISIBILITIES = ['public', 'internal', 'private', 'unknown'] as const;
export const stateVisibilitySchema = z.enum(STATE_VISIBILITIES);
export type StateVisibility = z.infer<typeof stateVisibilitySchema>;

export const MUTABILITIES = ['pure', 'view', 'nonpayable', 'payable', 'unknown'] as const;
export const mutabilitySchema = z.enum(MUTABILITIES);
export type Mutability = z.infer<typeof mutabilitySchema>;

export const ASSET_TYPES = [
  'native',
  'erc20',
  'erc721',
  'erc1155',
  'share',
  'debt',
  'collateral',
  'reward',
  'lp',
  'receipt',
  'unknown',
] as const;
export const assetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof assetTypeSchema>;

export const ROLE_TYPES = [
  'owner',
  'admin',
  'default_admin',
  'guardian',
  'pauser',
  'keeper',
  'relayer',
  'upgrader',
  'governance',
  'multisig',
  'timelock',
] as const;
export const roleTypeSchema = z.enum(ROLE_TYPES);
export type RoleType = z.infer<typeof roleTypeSchema>;

export const DEPENDENCY_TYPES = [
  'oracle',
  'erc20',
  'dex',
  'router',
  'bridge',
  'messenger',
  'permit',
  'external_protocol',
  'keeper',
  'relayer',
  'unknown',
] as const;
export const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);
export type DependencyType = z.infer<typeof dependencyTypeSchema>;
