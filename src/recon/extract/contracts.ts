import { createContract } from '../../domain/contract.js';
import {
  patchOf,
  sourceFileSet,
  spanString,
  type Extractor,
} from './types.js';

export const contractsExtractor: Extractor = (ctx) => {
  const files = sourceFileSet(ctx.ir);
  return patchOf({
    contracts: ctx.ir.contracts
      .filter((contract) => files.has(contract.span.file))
      .map((contract) =>
        createContract({
          name: contract.name,
          contract_type:
            contract.kind === 'interface' || contract.kind === 'library'
              ? contract.kind
              : 'unknown',
          source_file: contract.span.file,
          is_abstract: contract.abstract,
          ...(ctx.ir.compiler !== undefined
            ? { compiler_version: ctx.ir.compiler.longVersion }
            : {}),
          source: spanString(contract.span),
        }),
      ),
  });
};
