import { z } from 'zod';
import { contractId } from '../ids/ids.js';
import { contractTypeSchema } from './enums.js';
import {
  ENTITY_ID_PREFIXES,
  IDENTIFIER_PATTERN,
  addressField,
  assertAddressChainPair,
  chainIdField,
  parseOrThrow,
} from './helpers.js';

const ContractShape = {
  name: z.string().trim().regex(IDENTIFIER_PATTERN),
  address: addressField.optional(),
  chain_id: chainIdField.optional(),
  contract_type: contractTypeSchema,
  source_file: z.string().trim().min(1).optional(),
  source_verified: z.boolean().optional(),
  compiler_version: z.string().trim().min(1).optional(),
  is_proxy: z.boolean().optional(),
  implementation_id: z.string().regex(ENTITY_ID_PREFIXES.contract).optional(),
  deployment_status: z.string().trim().min(1).optional(),
} as const;

const ContractInputSchema = z.strictObject(ContractShape);

export const ContractSchema = z.strictObject({
  ...ContractShape,
  id: z.string().regex(/^contract:.+/),
});

export type ContractInput = z.input<typeof ContractInputSchema>;
export type Contract = z.infer<typeof ContractSchema>;

export function createContract(input: ContractInput): Contract {
  const parsed = parseOrThrow(ContractInputSchema, input, 'Contract');
  assertAddressChainPair(parsed, 'Contract');
  const id = contractId({
    name: parsed.name,
    chainId: parsed.chain_id,
    address: parsed.address,
  });
  return parseOrThrow(ContractSchema, { ...parsed, id }, 'Contract');
}
