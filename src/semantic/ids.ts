import { createHash } from 'node:crypto';
import { stableStringify } from '../util/canonical.js';

export const SEMANTIC_ID_PREFIXES = [
  'semc',
  'semt',
  'sema',
  'semk',
  'semcl',
  'semacc',
  'semau',
  'semdep',
  'semtc',
  'semobs',
  'semasm',
  'semhyp',
  'seminv',
] as const;

export type SemanticIdPrefix = (typeof SEMANTIC_ID_PREFIXES)[number];

export function semanticContentId(prefix: SemanticIdPrefix, payload: unknown): string {
  const digest = createHash('sha256').update(stableStringify(payload)).digest('hex');
  return `${prefix}:${digest.slice(0, 16)}`;
}
