import { createHash } from 'node:crypto';
import { stableStringify } from '../util/canonical.js';
import type { ScopeReport } from './model.js';

export function computeScopeHash(report: Omit<ScopeReport, 'scope_hash'>): string {
  const payload: Omit<ScopeReport, 'scope_hash'> & { scope_hash?: undefined } = {
    ...report,
    scope_hash: undefined,
  };
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

export function finalizeScopeReport(report: Omit<ScopeReport, 'scope_hash'>): ScopeReport {
  return { ...report, scope_hash: computeScopeHash(report) };
}

export function serializeScopeReport(report: ScopeReport): string {
  return stableStringify(report);
}
