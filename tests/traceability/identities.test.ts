import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReconState, deserializeReconState, serializeReconState } from '../../src/recon-state/state.js';
import type { ReconStateInput } from '../../src/recon-state/schema.js';
import { createContract } from '../../src/domain/contract.js';
import { createFunction } from '../../src/domain/function.js';
import type { CompileProjectResult } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { buildIr } from '../../src/recon/ir/build.js';
import { computeSourceHash } from '../../src/recon/source-hash.js';
import type { DiscoveredFile } from '../../src/recon/discover.js';
import {
  computeCompilerIdentity,
  computeConfigHash,
  computeInputManifestHash,
  computeManifestHash,
  computeOutputIdentity,
  computeSourceIdentity,
  createRunId,
  derivationId,
  entityContentHash,
  type InputManifestPayload,
} from '../../src/traceability/identities.js';
import type { ReconRun } from '../../src/traceability/types.js';
import { stableStringify } from '../../src/util/canonical.js';
import { ANALYZER_VERSION } from '../../src/version.js';

const A_CONTENT = 'pragma solidity ^0.8.0;\ncontract A {}\n';
const B_CONTENT = 'pragma solidity ^0.8.0;\ncontract B {}\n';

const SHA_A = '79e6a9113c0a154cb6f0be87e4eb3dd080aabaf72057e04717ed9a282a0a0e8b';
const SHA_B = '49b9a6e3212b05bc773d5c53d86f3d2600c10ca2f74e1971ad9aa4bd923eb552';
const PINNED_SOURCE_HASH = '0b7b484cf6be9991fa2bef13def84feaa0032e74f81bf1863728913a25ae396e';

const FIXTURE_FILES: DiscoveredFile[] = [
  { path: 'A.sol', absolute: '/fixture/A.sol', sha256: SHA_A, bytes: 38 },
  { path: 'B.sol', absolute: '/fixture/B.sol', sha256: SHA_B, bytes: 38 },
];

const SCHEMA_VERSION = 'recon-state/v1';

function irWithFixtureFiles(): string | undefined {
  const result: CompileProjectResult = {
    output: {},
    contents: new Map([
      ['A.sol', A_CONTENT],
      ['B.sol', B_CONTENT],
    ]),
    fidelity: 'syntactic',
    longVersion: '0.8.37+commit.f704f362',
    issues: [],
    dropped: [],
  };
  const { ir } = buildIr(result, FIXTURE_FILES);
  return ir.compiler?.sourceHash;
}

interface BaseState {
  input: ReconStateInput;
  contractId: string;
  functionId: string;
}

function buildBase(): BaseState {
  const contract = createContract({
    name: 'Vault',
    chain_id: 'ethereum',
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    contract_type: 'vault',
  });
  const deposit = createFunction({
    contract_id: contract.id,
    name: 'deposit',
    visibility: 'external',
    mutability: 'nonpayable',
    parameters: [{ type: 'uint256' }],
  });
  return {
    input: {
      schema_version: SCHEMA_VERSION,
      contracts: [contract],
      functions: [deposit],
    },
    contractId: contract.id,
    functionId: deposit.id,
  };
}

function runWithOutput(outputHash: string): ReconRun {
  return {
    id: 'run:0123456789abcdef',
    project_id: 'project:0123456789abcdef',
    schema_version: SCHEMA_VERSION,
    analyzer_version: ANALYZER_VERSION,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:05.000Z',
    status: 'COMPLETED',
    source_identity: { source_hash: '1'.repeat(64), manifest_hash: '2'.repeat(64) },
    compiler_identity: {
      compiler: 'solc',
      version: '0.8.37+commit.f704f362',
      backend: 'solc-js',
    },
    configuration_identity: { config_hash: '4'.repeat(64) },
    input_manifest_hash: '5'.repeat(64),
    output_identity: { output_hash: outputHash, serialization: 'recon-state-json/v1' },
  };
}

function manifestOf(run: ReconRun): InputManifestPayload {
  return {
    sourceIdentity: run.source_identity,
    configHash: run.configuration_identity.config_hash,
    compilerIdentity: run.compiler_identity,
    analyzerVersion: run.analyzer_version,
    schemaVersion: run.schema_version,
  };
}

describe('identity builders', () => {
  it('source hash formula matches pinned value', () => {
    expect(computeSourceHash(FIXTURE_FILES)).toBe(PINNED_SOURCE_HASH);
    expect(irWithFixtureFiles()).toBe(PINNED_SOURCE_HASH);
  });

  it('output identity excludes traceability', () => {
    const base = buildBase();
    const plain = createReconState(base.input);
    const expected = computeOutputIdentity(plain);
    expect(expected.serialization).toBe('recon-state-json/v1');
    expect(expected.output_hash).toBe(
      createHash('sha256')
        .update(serializeReconState(plain, { omitTraceability: true }), 'utf8')
        .digest('hex'),
    );

    const run = runWithOutput(expected.output_hash);
    const withTrace = createReconState({
      ...base.input,
      traceability: {
        runs: [run],
        derivations: [
          {
            id: 'derivation:0123456789abcdef',
            run_id: run.id,
            operation: 'extract.contracts',
            operation_version: ANALYZER_VERSION,
            inputs: [{ entity_type: 'contract', entity_id: base.contractId }],
            outputs: [
              { entity_type: 'contract', entity_id: base.contractId },
              { entity_type: 'function', entity_id: base.functionId },
            ],
            provenance: [],
            status: 'COMPLETED',
          },
        ],
        outputs: [
          {
            run_id: run.id,
            entity_type: 'contract',
            entity_id: base.contractId,
            content_hash: 'f'.repeat(64),
          },
          {
            run_id: run.id,
            entity_type: 'function',
            entity_id: base.functionId,
            content_hash: 'f'.repeat(64),
          },
        ],
      },
    });

    expect(computeOutputIdentity(withTrace).output_hash).toBe(expected.output_hash);

    const loaded = deserializeReconState(serializeReconState(withTrace));
    expect(computeOutputIdentity(loaded).output_hash).toBe(expected.output_hash);
    expect(loaded.traceability?.runs[0]?.output_identity?.output_hash).toBe(expected.output_hash);
  });

  it('config hash excludes root', () => {
    const configA = parseReconConfig({
      root: '/tmp/recon-aaaa-1111/contracts',
      includes: ['src/**/*.sol'],
      excludes: ['lib/**'],
      recordGit: false,
    });
    const configB = parseReconConfig({
      root: '/var/tmp/recon-bbbb-2222/contracts',
      includes: ['src/**/*.sol'],
      excludes: ['lib/**'],
      recordGit: false,
    });
    expect(computeConfigHash(configA)).toBe(computeConfigHash(configB));

    const files = [{ path: 'src/A.sol', sha256: SHA_A, bytes: 38 }];
    const sourceIdentity = computeSourceIdentity(
      files,
      { repository: 'https://example.com/acme.git', commit: 'abc123' },
      'contracts',
    );
    const compilerIdentity = computeCompilerIdentity('0.8.37+commit.f704f362');
    const payloadOf = (config: ReconConfig): InputManifestPayload => ({
      sourceIdentity,
      configHash: computeConfigHash(config),
      compilerIdentity,
      analyzerVersion: ANALYZER_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });

    expect(computeInputManifestHash(payloadOf(configA))).toBe(
      computeInputManifestHash(payloadOf(configB)),
    );
    expect(createRunId(payloadOf(configA))).toBe(createRunId(payloadOf(configB)));

    const configC = parseReconConfig({
      root: '/tmp/recon-aaaa-1111/contracts',
      includes: ['src/**/*.sol', 'lib/**/*.sol'],
      excludes: ['lib/**'],
      recordGit: false,
    });
    expect(computeConfigHash(configC)).not.toBe(computeConfigHash(configA));

    const configWithTimestamp: ReconConfig = {
      ...configA,
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    expect(computeConfigHash(configWithTimestamp)).not.toBe(computeConfigHash(configA));

    const reordered: ReconConfig = {
      ...configA,
      includes: ['lib/**/*.sol', 'src/**/*.sol'],
      excludes: ['lib/**', 'vendor/**'],
    };
    const sameSets: ReconConfig = {
      ...configA,
      includes: ['src/**/*.sol', 'lib/**/*.sol'],
      excludes: ['vendor/**', 'lib/**'],
    };
    expect(computeConfigHash(reordered)).toBe(computeConfigHash(sameSets));
    expect(computeConfigHash({ ...configA, excludes: [] })).not.toBe(computeConfigHash(configA));
  });

  it('manifest hash is order independent', () => {
    const files = [
      { path: 'src/A.sol', sha256: 'a'.repeat(64), bytes: 10 },
      { path: 'src/B.sol', sha256: 'b'.repeat(64), bytes: 20 },
      { path: 'lib/C.sol', sha256: 'c'.repeat(64), bytes: 30 },
    ];
    const shuffled = [files[2]!, files[0]!, files[1]!];
    expect(computeManifestHash(files)).toBe(computeManifestHash(shuffled));
    expect(computeManifestHash(files)).toBe(computeManifestHash([...files].reverse()));

    const resized = [{ ...files[0]!, bytes: 11 }, files[1]!, files[2]!];
    expect(computeManifestHash(resized)).not.toBe(computeManifestHash(files));
  });

  it('derivation id deterministic and sensitive', () => {
    const runId = 'run:0123456789abcdef';
    const operation = 'extract.contracts';
    const inputs = [
      { entity_type: 'source_file', entity_id: 'src/B.sol' },
      { entity_type: 'contract', entity_id: 'contract:x' },
    ];
    const provenance = ['src/B.sol:10-20', 'src/B.sol:1-9'];

    const id = derivationId(runId, operation, inputs, provenance);
    expect(id).toBe(derivationId(runId, operation, [...inputs].reverse(), [...provenance].reverse()));
    expect(id).toMatch(/^derivation:run:[0-9a-f]{16}:extract\.[a-z_]+:[0-9a-f]{16}$/);
    expect(derivationId(runId, 'extract.functions', inputs, provenance)).not.toBe(id);
    expect(
      derivationId(
        runId,
        operation,
        [inputs[0]!, { entity_type: 'contract', entity_id: 'contract:y' }],
        provenance,
      ),
    ).not.toBe(id);
    expect(derivationId(runId, operation, inputs, ['src/B.sol:10-20'])).not.toBe(id);
  });

  it('run id excludes timestamps', () => {
    const runA: ReconRun = {
      ...runWithOutput('0'.repeat(64)),
      started_at: '2024-01-01T00:00:00.000Z',
      completed_at: '2024-01-01T00:00:05.000Z',
    };
    const runB: ReconRun = {
      ...runWithOutput('0'.repeat(64)),
      started_at: '2030-06-15T12:34:56.789Z',
      completed_at: '2030-06-15T12:35:01.000Z',
    };
    expect(runA.started_at).not.toBe(runB.started_at);

    const payloadA = manifestOf(runA);
    const payloadB = manifestOf(runB);
    expect(computeInputManifestHash(payloadA)).toBe(computeInputManifestHash(payloadB));

    const runIdA = createRunId(payloadA);
    const runIdB = createRunId(payloadB);
    expect(runIdA).toBe(runIdB);
    expect(runIdA).toMatch(/^run:[0-9a-f]{16}$/);
  });

  it('analyzer version matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(ANALYZER_VERSION).toBe(pkg.version);
  });

  it('compiler identity binary hash formatting', () => {
    const longVersion = '0.8.37+commit.f704f362';
    const withoutBinary = computeCompilerIdentity(longVersion);
    expect(withoutBinary).toEqual({
      compiler: 'solc',
      version: longVersion,
      backend: 'solc-js',
    });
    expect(withoutBinary.binary_hash).toBeUndefined();

    const hex = 'a'.repeat(64);
    const withBinary = computeCompilerIdentity(longVersion, hex);
    expect(withBinary.binary_hash).toBe(`sha256:${hex}`);
    expect(withBinary).toEqual({
      compiler: 'solc',
      version: longVersion,
      backend: 'solc-js',
      binary_hash: `sha256:${hex}`,
    });
  });

  it('source identity combines hashes and git metadata', () => {
    const identity = computeSourceIdentity(
      FIXTURE_FILES,
      { repository: 'https://example.com/acme.git', commit: 'abc123' },
      'contracts',
    );
    expect(identity.source_hash).toBe(PINNED_SOURCE_HASH);
    expect(identity.manifest_hash).toBe(computeManifestHash(FIXTURE_FILES));
    expect(identity.repository).toBe('https://example.com/acme.git');
    expect(identity.commit).toBe('abc123');
    expect(identity.source_root).toBe('contracts');

    const bare = computeSourceIdentity(FIXTURE_FILES, {}, 'contracts');
    expect(bare.repository).toBeUndefined();
    expect(bare.commit).toBeUndefined();
    expect(bare.source_hash).toBe(PINNED_SOURCE_HASH);
  });

  it('entity content hash is canonical', () => {
    const entity = { id: 'fact:x', tags: ['b', 'a'], nested: { z: 1, a: 2 } };
    expect(entityContentHash(entity)).toBe(
      createHash('sha256').update(stableStringify(entity)).digest('hex'),
    );
    expect(entityContentHash(entity)).toBe(
      entityContentHash({ nested: { a: 2, z: 1 }, tags: ['b', 'a'], id: 'fact:x' }),
    );
  });
});
