import { z } from 'zod';
import { ReconError } from '../errors/errors.js';

export const IDENTIFIER_PATTERN = /^[$a-zA-Z_][$a-zA-Z0-9_]*$/;
export const SIGNATURE_PATTERN = /^[$a-zA-Z_][$a-zA-Z0-9_]*\(.*\)$/;
export const SELECTOR_PATTERN = /^0x[0-9a-f]{8}$/;
export const STORAGE_SLOT_PATTERN = /^(0x[0-9a-f]{1,64}|[0-9]+)$/;
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const ENTITY_ID_PREFIXES = {
  project: /^project:.+$/,
  contract: /^contract:.+/,
  function: /^function:.+$/,
  state: /^state:.+/,
  asset: /^asset:.+/,
  role: /^role:.+/,
  dependency: /^dependency:.+/,
} as const;

export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  entity: string,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ReconError('SchemaValidationFailed', `${entity} failed schema validation`, {
      entity,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function assertAddressChainPair(
  value: { address?: string | undefined; chain_id?: string | undefined },
  entity: string,
): void {
  if (value.address !== undefined && (value.chain_id === undefined || value.chain_id.length === 0)) {
    throw new ReconError(
      'SchemaValidationFailed',
      `${entity}: chain_id is required when address is present`,
      { entity, field: 'chain_id' },
    );
  }
}

export const addressField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

export const chainIdField = z.string().trim().toLowerCase().min(1);

export const timestampField = z.string().regex(ISO_TIMESTAMP_PATTERN);
