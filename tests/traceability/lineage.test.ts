import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import {
  createProvenanceFactory,
  mergePatches,
  runExtractors,
  runExtractorsWithLineage,
  type ExtractorContext,
} from '../../src/recon/extract/index.js';
import { buildIr } from '../../src/recon/ir/build.js';
import { stableStringify } from '../../src/util/canonical.js';

const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));
const GIT = { repository: 'https://example.com/acme/recon.git', commit: 'cafe1234deadbeef' };
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

const PINNED_OPERATIONS = [
  'extract.contracts',
  'extract.functions',
  'extract.state_variables',
  'extract.inheritance',
  'extract.calls',
  'extract.storage_access',
  'extract.event_error_facts',
];

describe('extractor lineage runner', () => {
  let ctx: ExtractorContext;

  beforeAll(async () => {
    const config = parseReconConfig({
      root: VAULT_ROOT,
      recordGit: false,
      timestamp: TIMESTAMP,
      projectName: 'lineage',
    });
    const discovered = await discoverSources(config);
    const compiled = await compileProject(config, discovered.files);
    const { ir } = buildIr(compiled, discovered.files);
    ctx = { ir, config, provenance: createProvenanceFactory(GIT) };
  });

  it('lineage runner reports per-extractor patches', () => {
    const { perExtractor } = runExtractorsWithLineage(ctx);
    expect(perExtractor).toHaveLength(PINNED_OPERATIONS.length);
    expect(perExtractor.map((entry) => entry.operation)).toEqual(PINNED_OPERATIONS);
    const union = mergePatches(perExtractor.map((entry) => entry.patch));
    expect(union.contracts.length).toBeGreaterThan(0);
    expect(union.functions.length).toBeGreaterThan(0);
    expect(union.state_variables.length).toBeGreaterThan(0);
    expect(union.relationships.length).toBeGreaterThan(0);
    expect(stableStringify(union)).toBe(stableStringify(runExtractors(ctx)));
  });

  it('existing runner behavior unchanged', () => {
    expect(stableStringify(runExtractors(ctx))).toBe(
      stableStringify(runExtractorsWithLineage(ctx).patch),
    );
  });
});
