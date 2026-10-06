import { compareCodeUnits } from '../util/canonical.js';
import type { Ratio, ScopeCounts, ScopeEntry, ScopeMetrics } from './model.js';

const FALLBACK_CODE = 'syntactic_fallback';
const SIZE_LIMIT_RULE = 'limit:maxFileBytes';

function vacuousRatio(numerator: number, denominator: number, vacuous: number): Ratio {
  if (denominator === 0) return { n: vacuous, d: 1 };
  return { n: numerator, d: denominator };
}

export function computeCounts(entries: readonly ScopeEntry[]): ScopeCounts {
  const counts: ScopeCounts = {
    expected: 0,
    analyzed: 0,
    excluded: 0,
    not_found: 0,
    unresolved: 0,
    unsupported: 0,
    failed: 0,
  };
  for (const entry of entries) {
    switch (entry.status) {
      case 'ANALYZED':
        counts.analyzed += 1;
        break;
      case 'EXCLUDED':
        counts.excluded += 1;
        break;
      case 'NOT_FOUND':
        counts.not_found += 1;
        break;
      case 'UNRESOLVED':
        counts.unresolved += 1;
        break;
      case 'UNSUPPORTED':
        counts.unsupported += 1;
        break;
      case 'FAILED':
        counts.failed += 1;
        break;
    }
  }
  counts.expected = entries.length - counts.excluded;
  return counts;
}

export function computeMetrics(entries: readonly ScopeEntry[]): ScopeMetrics {
  const counts = computeCounts(entries);
  const eSize = counts.expected;

  const byRule = new Map<string, number>();
  for (const entry of entries) {
    if (entry.status !== 'EXCLUDED') continue;
    for (const item of entry.evidence) {
      let rule: string | undefined;
      if (item.kind === 'exclude_rule') rule = item.rule;
      else if (item.kind === 'size_limit') rule = SIZE_LIMIT_RULE;
      if (rule !== undefined) byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }
  }
  const excluded_by_rule = [...byRule.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => compareCodeUnits(a.rule, b.rule));

  let fallback_count = 0;
  for (const entry of entries) {
    for (const item of entry.evidence) {
      if (item.kind === 'issue' && item.issue.code === FALLBACK_CODE) {
        fallback_count += 1;
        break;
      }
    }
  }

  return {
    clean_coverage: vacuousRatio(counts.analyzed, eSize, 1),
    resolution_completeness: vacuousRatio(counts.analyzed, counts.analyzed + counts.unresolved, 1),
    unsupported_rate: vacuousRatio(counts.unsupported, eSize, 0),
    failed_rate: vacuousRatio(counts.failed, eSize, 0),
    not_found_rate: vacuousRatio(counts.not_found, eSize, 0),
    excluded_by_rule,
    fallback_count,
  };
}
