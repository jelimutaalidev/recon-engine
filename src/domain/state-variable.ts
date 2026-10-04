import { z } from 'zod';
import { stateVariableId } from '../ids/ids.js';
import { stateVisibilitySchema } from './enums.js';
import {
  ENTITY_ID_PREFIXES,
  IDENTIFIER_PATTERN,
  STORAGE_SLOT_PATTERN,
  parseOrThrow,
} from './helpers.js';

const StateVariableShape = {
  contract_id: z.string().regex(ENTITY_ID_PREFIXES.contract),
  name: z.string().trim().regex(IDENTIFIER_PATTERN),
  type: z.string().trim().min(1),
  visibility: stateVisibilitySchema,
  slot: z.string().trim().toLowerCase().regex(STORAGE_SLOT_PATTERN).optional(),
  mutability: z.enum(['mutable', 'constant', 'immutable']).optional(),
  source: z.string().trim().min(1).optional(),
} as const;

const StateVariableInputSchema = z.strictObject(StateVariableShape);

export const StateVariableSchema = z.strictObject({
  ...StateVariableShape,
  id: z.string().regex(/^state:.+/),
});

export type StateVariableInput = z.input<typeof StateVariableInputSchema>;
export type StateVariable = z.infer<typeof StateVariableSchema>;

export function createStateVariable(input: StateVariableInput): StateVariable {
  const parsed = parseOrThrow(StateVariableInputSchema, input, 'StateVariable');
  return parseOrThrow(
    StateVariableSchema,
    { ...parsed, id: stateVariableId(parsed.contract_id, parsed.name) },
    'StateVariable',
  );
}
