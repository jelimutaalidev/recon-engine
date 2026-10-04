import { z } from 'zod';
import { dependencyId } from '../ids/ids.js';
import { dependencyTypeSchema } from './enums.js';
import {
  addressField,
  assertAddressChainPair,
  chainIdField,
  parseOrThrow,
} from './helpers.js';

const DependencyShape = {
  name: z.string().trim().min(1),
  dependency_type: dependencyTypeSchema,
  address: addressField.optional(),
  chain_id: chainIdField.optional(),
  interface: z.string().trim().min(1).optional(),
  trust_level: z.string().trim().min(1).optional(),
} as const;

const DependencyInputSchema = z.strictObject(DependencyShape);

export const DependencySchema = z.strictObject({
  ...DependencyShape,
  id: z.string().regex(/^dependency:.+/),
});

export type DependencyInput = z.input<typeof DependencyInputSchema>;
export type Dependency = z.infer<typeof DependencySchema>;

export function createDependency(input: DependencyInput): Dependency {
  const parsed = parseOrThrow(DependencyInputSchema, input, 'Dependency');
  assertAddressChainPair(parsed, 'Dependency');
  const id = dependencyId({
    name: parsed.name,
    chainId: parsed.chain_id,
    address: parsed.address,
  });
  return parseOrThrow(DependencySchema, { ...parsed, id }, 'Dependency');
}
