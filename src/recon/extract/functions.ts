import { createFunction, type SolidityFunction } from '../../domain/function.js';
import type { Mutability, Visibility } from '../../domain/enums.js';
import { modifierText } from './modifiers.js';
import {
  contractEntityId,
  functionSignatureOf,
  patchOf,
  sourceFileSet,
  spanString,
  type Extractor,
} from './types.js';

function normalizeVisibility(value: string): Visibility {
  switch (value) {
    case 'public':
    case 'external':
    case 'internal':
    case 'private':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeMutability(value: string): Mutability {
  switch (value) {
    case 'pure':
    case 'view':
    case 'nonpayable':
    case 'payable':
      return value;
    default:
      return 'unknown';
  }
}

export const functionsExtractor: Extractor = (ctx) => {
  const files = sourceFileSet(ctx.ir);
  const functions: SolidityFunction[] = [];
  for (const contract of ctx.ir.contracts) {
    if (!files.has(contract.span.file)) continue;
    const contract_id = contractEntityId(contract);
    for (const fn of contract.functions) {
      const signature = functionSignatureOf(fn);
      const selector =
        fn.kind === 'function' && fn.selector !== undefined
          ? fn.selector.startsWith('0x')
            ? fn.selector
            : `0x${fn.selector}`
          : undefined;
      functions.push(
        createFunction({
          contract_id,
          name: fn.name.length > 0 ? fn.name : fn.kind,
          signature,
          ...(selector !== undefined ? { selector } : {}),
          visibility: normalizeVisibility(fn.visibility),
          mutability: normalizeMutability(fn.stateMutability),
          parameters: fn.params,
          returns: fn.returns,
          modifiers: fn.modifiers.map(modifierText),
          source: spanString(fn.span),
        }),
      );
    }
  }
  return patchOf({ functions });
};
