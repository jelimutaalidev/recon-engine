import { z } from 'zod';
import { roleId } from '../ids/ids.js';
import { roleTypeSchema } from './enums.js';
import {
  ENTITY_ID_PREFIXES,
  IDENTIFIER_PATTERN,
  addressField,
  parseOrThrow,
} from './helpers.js';

const RoleShape = {
  contract_id: z.string().regex(ENTITY_ID_PREFIXES.contract).optional(),
  name: z.string().trim().regex(IDENTIFIER_PATTERN),
  role_type: roleTypeSchema,
  holder: addressField.optional(),
  source: z.string().trim().min(1).optional(),
} as const;

const RoleInputSchema = z.strictObject(RoleShape);

export const RoleSchema = z.strictObject({
  ...RoleShape,
  id: z.string().regex(/^role:.+/),
});

export type RoleInput = z.input<typeof RoleInputSchema>;
export type Role = z.infer<typeof RoleSchema>;

export function createRole(input: RoleInput): Role {
  const parsed = parseOrThrow(RoleInputSchema, input, 'Role');
  return parseOrThrow(
    RoleSchema,
    { ...parsed, id: roleId(parsed.contract_id, parsed.name) },
    'Role',
  );
}
