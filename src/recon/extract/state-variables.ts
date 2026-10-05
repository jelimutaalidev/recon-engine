import { createStateVariable, type StateVariable } from '../../domain/state-variable.js';
import type { StateVisibility } from '../../domain/enums.js';
import { sourceContractId } from '../../ids/ids.js';
import { patchOf, sourceFileSet, spanString, type Extractor } from './types.js';

function normalizeStateVisibility(value: string): StateVisibility {
  switch (value) {
    case 'public':
    case 'internal':
    case 'private':
      return value;
    default:
      return 'unknown';
  }
}

export const stateVariablesExtractor: Extractor = (ctx) => {
  const files = sourceFileSet(ctx.ir);
  const state_variables: StateVariable[] = [];
  for (const contract of ctx.ir.contracts) {
    if (!files.has(contract.span.file)) continue;
    const contract_id = sourceContractId(contract.span.file, contract.name);
    for (const stateVar of contract.stateVars) {
      state_variables.push(
        createStateVariable({
          contract_id,
          name: stateVar.name,
          type: stateVar.type,
          visibility: normalizeStateVisibility(stateVar.visibility),
          mutability: stateVar.mutability,
          ...(stateVar.slot !== undefined ? { slot: stateVar.slot } : {}),
          source: spanString(stateVar.span),
        }),
      );
    }
  }
  return patchOf({ state_variables });
};
