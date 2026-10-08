import { createHash } from 'node:crypto';
import { stableStringify } from '../../util/canonical.js';

export type EsmIdPrefix = 'seme:';

export function esmContentId(prefix: EsmIdPrefix, payload: unknown): string {
  const digest = createHash('sha256').update(stableStringify(payload)).digest('hex');
  return `${prefix}${digest.slice(0, 16)}`;
}
