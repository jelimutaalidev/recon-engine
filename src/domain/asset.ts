import { z } from 'zod';
import { assetId } from '../ids/ids.js';
import { assetTypeSchema } from './enums.js';
import {
  ENTITY_ID_PREFIXES,
  addressField,
  assertAddressChainPair,
  chainIdField,
  parseOrThrow,
} from './helpers.js';

const AssetShape = {
  name: z.string().trim().min(1),
  address: addressField.optional(),
  chain_id: chainIdField.optional(),
  asset_type: assetTypeSchema,
  decimals: z.number().int().min(0).max(255).optional(),
  custody: z.string().trim().min(1).optional(),
  underlying_asset_id: z.string().regex(ENTITY_ID_PREFIXES.asset).optional(),
} as const;

const AssetInputSchema = z.strictObject(AssetShape);

export const AssetSchema = z.strictObject({
  ...AssetShape,
  id: z.string().regex(/^asset:.+/),
});

export type AssetInput = z.input<typeof AssetInputSchema>;
export type Asset = z.infer<typeof AssetSchema>;

export function createAsset(input: AssetInput): Asset {
  const parsed = parseOrThrow(AssetInputSchema, input, 'Asset');
  assertAddressChainPair(parsed, 'Asset');
  const id = assetId({
    name: parsed.name,
    chainId: parsed.chain_id,
    address: parsed.address,
  });
  return parseOrThrow(AssetSchema, { ...parsed, id }, 'Asset');
}
