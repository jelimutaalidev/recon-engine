import { sourceContractId } from '../../ids/ids.js';
import { createRelationship, type Relationship } from '../../relationships/relationship.js';
import { createReconIssue, type ReconIssue } from '../issues.js';
import { contractScope, patchOf, type Extractor } from './types.js';

export const inheritanceExtractor: Extractor = (ctx) => {
  const scope = contractScope(ctx.ir);
  const relationships: Relationship[] = [];
  const issues: ReconIssue[] = [];
  for (const contract of scope.values()) {
    const source_id = sourceContractId(contract.span.file, contract.name);
    for (const base of contract.bases) {
      if (base.fqn === contract.fqn) continue;
      const target = scope.get(base.fqn);
      if (target === undefined) {
        issues.push(
          createReconIssue({
            severity: 'UNKNOWN',
            code: 'base_outside_sources',
            message: `base ${base.fqn} is outside the analyzed source set`,
            file: contract.span.file,
            line_start: contract.span.lineStart,
            line_end: contract.span.lineEnd,
          }),
        );
        continue;
      }
      relationships.push(
        createRelationship({
          type: base.kind === 'interface' ? 'IMPLEMENTS' : 'INHERITS',
          source_id,
          target_id: sourceContractId(target.span.file, target.name),
          provenance: [ctx.provenance(contract.span)],
          ...(ctx.config.timestamp !== undefined ? { created_at: ctx.config.timestamp } : {}),
        }),
      );
    }
  }
  return patchOf({ relationships, issues });
};
