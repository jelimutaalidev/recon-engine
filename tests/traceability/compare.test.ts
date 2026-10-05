import { describe, expect, it } from 'vitest';
import { createReconState } from '../../src/recon-state/state.js';
import { createContract } from '../../src/domain/contract.js';
import { createFunction } from '../../src/domain/function.js';
import { isReconError } from '../../src/errors/errors.js';
import {
  createTraceabilityService,
  type ReconRun,
  type RunOutputRecord,
} from '../../src/traceability/index.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';

const ALPHA = createContract({ name: 'Alpha', contract_type: 'core' });
const BETA = createContract({ name: 'Beta', contract_type: 'core' });
const PING = createFunction({
  contract_id: ALPHA.id,
  name: 'ping',
  visibility: 'external',
  mutability: 'view',
  parameters: [],
});

const ALPHA_REF = { entity_type: 'contract', entity_id: ALPHA.id };
const BETA_REF = { entity_type: 'contract', entity_id: BETA.id };
const PING_REF = { entity_type: 'function', entity_id: PING.id };

const HASH_ALPHA = 'a'.repeat(64);
const HASH_BETA = 'b'.repeat(64);
const HASH_PING = 'c'.repeat(64);
const HASH_PING_V2 = 'd'.repeat(64);

function runFixture(id: string, overrides: Partial<ReconRun> = {}): ReconRun {
  return {
    id,
    project_id: 'project:0123456789abcdef',
    schema_version: 'recon-state/v1',
    analyzer_version: '0.1.0',
    started_at: FIXED_TS,
    completed_at: FIXED_TS,
    status: 'COMPLETED',
    source_identity: {
      source_hash: '1'.repeat(64),
      manifest_hash: '2'.repeat(64),
      repository: 'https://example.com/acme.git',
      commit: 'abc123def456',
      source_root: 'contracts',
    },
    compiler_identity: {
      compiler: 'solc',
      version: '0.8.37+commit.f704f362',
      backend: 'solc-js',
    },
    configuration_identity: { config_hash: '4'.repeat(64) },
    input_manifest_hash: '5'.repeat(64),
    ...overrides,
  };
}

function output(
  runId: string,
  entityType: string,
  entityId: string,
  contentHash: string,
): RunOutputRecord {
  return { run_id: runId, entity_type: entityType, entity_id: entityId, content_hash: contentHash };
}

function serviceFor(runs: ReconRun[], outputs: RunOutputRecord[]) {
  return createTraceabilityService(
    createReconState({
      contracts: [ALPHA, BETA],
      functions: [PING],
      traceability: { runs, derivations: [], outputs },
    }),
  );
}

function catchCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isReconError(error)) return error.code;
    throw error;
  }
  throw new Error('expected ReconError, but call succeeded');
}

describe('TraceabilityService.compareRuns', () => {
  it('identical runs classify same_source_same_analyzer with all entities unchanged', () => {
    const service = serviceFor(
      [runFixture('run:a'), runFixture('run:b')],
      [
        output('run:b', 'function', PING.id, HASH_PING),
        output('run:b', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:a', 'function', PING.id, HASH_PING),
      ],
    );

    const result = service.compareRuns('run:a', 'run:b');
    expect(result.classification).toBe('same_source_same_analyzer');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([ALPHA_REF, PING_REF]);
  });

  it('entities present only in B are reported added, sorted by entity type then id', () => {
    const service = serviceFor(
      [runFixture('run:a'), runFixture('run:b')],
      [
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:b', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:b', 'function', PING.id, HASH_PING),
        output('run:b', 'contract', BETA.id, HASH_BETA),
      ],
    );

    const result = service.compareRuns('run:a', 'run:b');
    expect(result.classification).toBe('same_source_same_analyzer');
    expect(result.added).toEqual([BETA_REF, PING_REF]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([ALPHA_REF]);
  });

  it('entities present only in A are reported removed, sorted by entity type then id', () => {
    const service = serviceFor(
      [runFixture('run:a'), runFixture('run:b')],
      [
        output('run:a', 'contract', BETA.id, HASH_BETA),
        output('run:a', 'function', PING.id, HASH_PING),
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:b', 'contract', ALPHA.id, HASH_ALPHA),
      ],
    );

    const result = service.compareRuns('run:a', 'run:b');
    expect(result.classification).toBe('same_source_same_analyzer');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([BETA_REF, PING_REF]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([ALPHA_REF]);
  });

  it('shared entities with different content hashes are reported changed', () => {
    const service = serviceFor(
      [runFixture('run:a'), runFixture('run:b')],
      [
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:a', 'function', PING.id, HASH_PING),
        output('run:b', 'contract', ALPHA.id, HASH_BETA),
        output('run:b', 'function', PING.id, HASH_PING),
      ],
    );

    expect(service.compareRuns('run:a', 'run:b')).toEqual({
      classification: 'same_source_same_analyzer',
      added: [],
      removed: [],
      changed: [ALPHA_REF],
      unchanged: [PING_REF],
    });
  });

  it('same source with a different analyzer version classifies same_source_diff_analyzer', () => {
    const service = serviceFor(
      [runFixture('run:a'), runFixture('run:b', { analyzer_version: '0.2.0' })],
      [
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:b', 'contract', ALPHA.id, HASH_ALPHA),
      ],
    );

    const result = service.compareRuns('run:a', 'run:b');
    expect(result.classification).toBe('same_source_diff_analyzer');
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([ALPHA_REF]);
  });

  it('different source hash classifies diff_source', () => {
    const service = serviceFor(
      [
        runFixture('run:a'),
        runFixture('run:b', {
          source_identity: { source_hash: '9'.repeat(64), manifest_hash: '2'.repeat(64) },
        }),
      ],
      [
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
        output('run:b', 'contract', ALPHA.id, HASH_ALPHA),
      ],
    );

    expect(service.compareRuns('run:a', 'run:b').classification).toBe('diff_source');
  });

  it('unknown run ids throw EntityNotFound', () => {
    const service = serviceFor(
      [runFixture('run:a')],
      [output('run:a', 'contract', ALPHA.id, HASH_ALPHA)],
    );

    expect(catchCode(() => service.compareRuns('run:missing', 'run:a'))).toBe('EntityNotFound');
    expect(catchCode(() => service.compareRuns('run:a', 'run:missing'))).toBe('EntityNotFound');
  });

  it('compareRuns(a, a) reports every entity unchanged', () => {
    const service = serviceFor(
      [runFixture('run:a')],
      [
        output('run:a', 'function', PING.id, HASH_PING_V2),
        output('run:a', 'contract', ALPHA.id, HASH_ALPHA),
      ],
    );

    expect(service.compareRuns('run:a', 'run:a')).toEqual({
      classification: 'same_source_same_analyzer',
      added: [],
      removed: [],
      changed: [],
      unchanged: [ALPHA_REF, PING_REF],
    });
  });
});
