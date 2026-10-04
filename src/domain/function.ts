import { z } from 'zod';
import { ReconError } from '../errors/errors.js';
import { functionId } from '../ids/ids.js';
import { mutabilitySchema, visibilitySchema } from './enums.js';
import {
  ENTITY_ID_PREFIXES,
  IDENTIFIER_PATTERN,
  SELECTOR_PATTERN,
  SIGNATURE_PATTERN,
  parseOrThrow,
} from './helpers.js';

const ParameterSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1),
});

const FunctionShape = {
  contract_id: z.string().regex(ENTITY_ID_PREFIXES.contract),
  name: z.string().trim().regex(IDENTIFIER_PATTERN),
  signature: z.string().optional(),
  selector: z.string().trim().toLowerCase().regex(SELECTOR_PATTERN).optional(),
  visibility: visibilitySchema,
  mutability: mutabilitySchema,
  parameters: z.array(ParameterSchema).default([]),
  returns: z.array(ParameterSchema).default([]),
  modifiers: z.array(z.string().trim().min(1)).default([]),
  source: z.string().trim().min(1).optional(),
} as const;

const FunctionInputSchema = z.strictObject(FunctionShape);

export const FunctionSchema = z.strictObject({
  ...FunctionShape,
  id: z.string().regex(/^function:.+/),
  signature: z.string().regex(SIGNATURE_PATTERN),
});

export type FunctionInput = z.input<typeof FunctionInputSchema>;
export type SolidityFunction = z.infer<typeof FunctionSchema>;

export function canonicalSignature(
  name: string,
  parameters: readonly { type: string }[],
): string {
  return `${name}(${parameters.map((parameter) => parameter.type).join(',')})`;
}

export function createFunction(input: FunctionInput): SolidityFunction {
  const parsed = parseOrThrow(FunctionInputSchema, input, 'Function');
  const signature =
    parsed.signature !== undefined
      ? parsed.signature.replace(/\s+/g, '')
      : canonicalSignature(parsed.name, parsed.parameters);
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new ReconError('SchemaValidationFailed', 'Function signature must be name(types)', {
      entity: 'Function',
      field: 'signature',
      signature,
    });
  }
  if (!signature.startsWith(`${parsed.name}(`)) {
    throw new ReconError(
      'SchemaValidationFailed',
      'Function signature must start with the function name',
      { entity: 'Function', field: 'signature', name: parsed.name, signature },
    );
  }
  return parseOrThrow(
    FunctionSchema,
    { ...parsed, signature, id: functionId(parsed.contract_id, signature) },
    'Function',
  );
}
