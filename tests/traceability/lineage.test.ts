import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import {
  createProvenanceFactory,
  mergePatches,
  runExtractors,
  runExtractorsWithLineage,
  type ExtractorContext,
} from '../../src/recon/extract/index.js';
import { analyzeProject } from '../../src/recon/index.js';
import { buildIr } from '../../src/recon/ir/build.js';
import { deserializeReconState, serializeReconState } from '../../src/recon-state/state.js';
import { computeOutputIdentity, entityContentHash } from '../../src/traceability/identities.js';
import { stableStringify } from '../../src/util/canonical.js';
import { ANALYZER_VERSION } from '../../src/version.js';

const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));
const GIT = { repository: 'https://example.com/acme/recon.git', commit: 'cafe1234deadbeef' };
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

function vaultConfig(overrides: Record<string, unknown> = {}): ReconConfig {
  return parseReconConfig({
    root: VAULT_ROOT,
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: 'lineage',
    ...overrides,
  });
}

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

describe('pipeline traceability wiring', () => {
  it('analyze produces a completed run', async () => {
    const result = await analyzeProject(vaultConfig());
    const traceability = result.state.traceability;
    expect(traceability).toBeDefined();
    expect(traceability!.runs).toHaveLength(1);

    const run = traceability!.runs[0]!;
    expect(run.status).toBe('COMPLETED');
    expect(run.started_at).toBe(TIMESTAMP);
    expect(run.completed_at).toBe(TIMESTAMP);
    expect(run.project_id).toBe(result.state.project!.id);
    expect(run.schema_version).toBe(result.state.schema_version);
    expect(run.analyzer_version).toBe(ANALYZER_VERSION);
    expect(run.source_identity.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.source_identity.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.source_identity.source_root).toBe('vault');
    expect(run.compiler_identity).toEqual({
      compiler: 'solc',
      version: result.meta.solcLongVersion,
      backend: 'solc-js',
    });
    expect(run.configuration_identity.config_hash.length).toBeGreaterThan(0);
    expect(run.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.output_identity?.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.output_identity?.serialization).toBe('recon-state-json/v1');

    expect(traceability!.derivations.length).toBeGreaterThan(0);
    for (const derivation of traceability!.derivations) {
      expect(derivation.run_id).toBe(run.id);
      expect(derivation.operation_version).toBe(ANALYZER_VERSION);
      expect(derivation.status).toBe('COMPLETED');
      expect(derivation.metadata).toEqual({ fidelity: result.meta.fidelity });
    }
    expect(traceability!.outputs.length).toBeGreaterThan(0);
    const stateEntities = [
      ...result.state.contracts,
      ...result.state.functions,
      ...result.state.state_variables,
      ...result.state.relationships,
      ...result.state.facts,
    ];
    expect(traceability!.outputs).toHaveLength(stateEntities.length);
    for (const output of traceability!.outputs) {
      expect(output.run_id).toBe(run.id);
      expect(output.content_hash).toMatch(/^[0-9a-f]{64}$/);
      const entity = stateEntities.find(
        (candidate) => candidate.id === output.entity_id,
      ) as { id: string } | undefined;
      expect(entity).toBeDefined();
      expect(entityContentHash(entity)).toBe(output.content_hash);
    }
  });

  it('derivations cover every material entity', async () => {
    const config = vaultConfig();
    const result = await analyzeProject(config);
    const discovered = await discoverSources(config);
    const files = new Set(discovered.files.map((file) => file.path));
    const traceability = result.state.traceability!;
    expect(traceability.derivations.length).toBeGreaterThan(0);

    const covered = new Set(
      traceability.derivations.flatMap((derivation) =>
        derivation.outputs.map((ref) => `${ref.entity_type}|${ref.entity_id}`),
      ),
    );
    const collections = [
      ['contract', result.state.contracts],
      ['function', result.state.functions],
      ['state_variable', result.state.state_variables],
      ['relationship', result.state.relationships],
      ['fact', result.state.facts],
    ] as const;
    for (const [entityType, entities] of collections) {
      expect(entities.length).toBeGreaterThan(0);
      for (const entity of entities) {
        expect(covered.has(`${entityType}|${entity.id}`)).toBe(true);
      }
    }

    for (const derivation of traceability.derivations) {
      expect(derivation.provenance.length).toBeGreaterThan(0);
      for (const span of derivation.provenance) {
        const match = /^(.+):(\d+)-(\d+)$/.exec(span);
        expect(match).not.toBeNull();
        expect(files.has(match![1]!)).toBe(true);
      }
      for (const ref of derivation.inputs) {
        expect(ref.entity_type).toBe('source_file');
        expect(files.has(ref.entity_id)).toBe(true);
      }
    }
  });

  it('traceability is deterministic', async () => {
    const first = await analyzeProject(vaultConfig());
    const second = await analyzeProject(vaultConfig());

    expect(serializeReconState(first.state)).toBe(serializeReconState(second.state));
    expect(first.state.traceability!.runs[0]!.id).toBe(second.state.traceability!.runs[0]!.id);
    expect(first.state.traceability!.derivations.map((derivation) => derivation.id)).toEqual(
      second.state.traceability!.derivations.map((derivation) => derivation.id),
    );
  });

  it('stored output hash recomputes', async () => {
    const result = await analyzeProject(vaultConfig());
    const stored = result.state.traceability!.runs[0]!.output_identity!;

    expect(computeOutputIdentity(result.state).output_hash).toBe(stored.output_hash);
    const loaded = deserializeReconState(serializeReconState(result.state));
    expect(computeOutputIdentity(loaded).output_hash).toBe(stored.output_hash);
    expect(loaded.traceability?.runs[0]?.output_identity?.output_hash).toBe(stored.output_hash);
  });

  it('run id stable across timestamp injection', async () => {
    const first = await analyzeProject(vaultConfig({ timestamp: '2026-01-01T00:00:00.000Z' }));
    const second = await analyzeProject(vaultConfig({ timestamp: '2026-03-15T12:00:00.000Z' }));
    const a = first.state.traceability!;
    const b = second.state.traceability!;

    expect(a.runs[0]!.started_at).not.toBe(b.runs[0]!.started_at);
    expect(a.runs[0]!.id).toBe(b.runs[0]!.id);
    expect(a.derivations.map((derivation) => derivation.id)).toEqual(
      b.derivations.map((derivation) => derivation.id),
    );
  });
});
