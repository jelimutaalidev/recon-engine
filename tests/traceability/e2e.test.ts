import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createContract } from '../../src/domain/contract.js';
import { isReconError } from '../../src/errors/errors.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { analyzeProject } from '../../src/recon/index.js';
import type { ReconState } from '../../src/recon-state/schema.js';
import { createReconState, serializeReconState } from '../../src/recon-state/state.js';
import { openDatabase, runMigrations } from '../../src/repository/migrate.js';
import { SqliteReconRepository } from '../../src/repository/sqlite.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import {
  createTraceabilityService,
  DEFAULT_TRACE_DEPTH,
  type Derivation,
  type ReconRun,
  type TraceReference,
  type TraceabilityService,
  type TraceabilityState,
} from '../../src/traceability/index.js';

const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));
const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const PROJECT_NAME = 'e2e-vault';

function vaultConfig(root: string): ReconConfig {
  return parseReconConfig({
    root,
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: PROJECT_NAME,
  });
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRefs(left: TraceReference, right: TraceReference): number {
  return (
    compareIds(left.entity_type, right.entity_type) || compareIds(left.entity_id, right.entity_id)
  );
}

function materialRefs(state: ReconState): TraceReference[] {
  return [
    ...state.contracts.map((entity) => ({ entity_type: 'contract', entity_id: entity.id })),
    ...state.functions.map((entity) => ({ entity_type: 'function', entity_id: entity.id })),
    ...state.state_variables.map((entity) => ({
      entity_type: 'state_variable',
      entity_id: entity.id,
    })),
    ...state.relationships.map((entity) => ({
      entity_type: 'relationship',
      entity_id: entity.id,
    })),
    ...state.facts.map((entity) => ({ entity_type: 'fact', entity_id: entity.id })),
  ];
}

function sourceInputFiles(traceability: TraceabilityState): string[] {
  const files = new Set<string>();
  for (const derivation of traceability.derivations) {
    for (const ref of derivation.inputs) {
      if (ref.entity_type === 'source_file') files.add(ref.entity_id);
    }
  }
  return [...files].sort(compareIds);
}

function chainDerivations(
  runId: string,
  operationVersion: string,
  chain: readonly TraceReference[],
): Derivation[] {
  const derivations: Derivation[] = [];
  for (let link = 1; link < chain.length; link += 1) {
    derivations.push({
      id: `derivation:e2e-chain-${link}`,
      run_id: runId,
      operation: 'e2e.chain_probe',
      operation_version: operationVersion,
      inputs: [chain[link]!],
      outputs: [chain[link - 1]!],
      provenance: [],
      status: 'COMPLETED',
    });
  }
  return derivations;
}

function cycleDerivations(
  runId: string,
  operationVersion: string,
  first: string,
  second: string,
): Derivation[] {
  const ref = (entityId: string): TraceReference => ({
    entity_type: 'contract',
    entity_id: entityId,
  });
  return [
    {
      id: 'derivation:e2e-cycle-ab',
      run_id: runId,
      operation: 'e2e.cycle_probe',
      operation_version: operationVersion,
      inputs: [ref(second)],
      outputs: [ref(first)],
      provenance: [],
      status: 'COMPLETED',
    },
    {
      id: 'derivation:e2e-cycle-ba',
      run_id: runId,
      operation: 'e2e.cycle_probe',
      operation_version: operationVersion,
      inputs: [ref(first)],
      outputs: [ref(second)],
      provenance: [],
      status: 'COMPLETED',
    },
  ];
}

function openRepo(): SqliteReconRepository {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return new SqliteReconRepository(db);
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

describe('e2e vault trace (spec §26 traversal DoD)', () => {
  let state: ReconState;
  let traceability: TraceabilityState;
  let run: ReconRun;
  let service: TraceabilityService;

  beforeAll(async () => {
    const result = await analyzeProject(vaultConfig(VAULT_ROOT));
    state = result.state;
    traceability = state.traceability!;
    run = traceability.runs[0]!;
    service = createTraceabilityService(state);
  });

  it('analyze → service → backward from relationship to source and run', () => {
    const relationship = state.relationships[0]!;

    const backward = service.traceBackward(relationship.id);

    expect(backward.root).toBe(relationship.id);
    expect(backward.direction).toBe('backward');
    expect(backward.status).toBe('COMPLETE');
    expect(backward.truncated).toBe(false);
    expect(new Set(backward.nodes.map((node) => node.kind))).toEqual(
      new Set([
        'entity',
        'derivation',
        'source_file',
        'provenance_span',
        'source_identity',
        'run',
      ]),
    );

    const expectedDepth: Record<string, number> = {
      entity: 0,
      derivation: 1,
      source_file: 2,
      provenance_span: 2,
      source_identity: 3,
      run: 4,
    };
    for (const node of backward.nodes) {
      expect(node.depth).toBe(expectedDepth[node.kind]);
    }

    expect(backward.nodes.find((node) => node.kind === 'run')?.id).toBe(run.id);
    expect(backward.nodes.find((node) => node.kind === 'source_identity')?.id).toBe(
      run.source_identity.source_hash,
    );

    const fixtureFiles = sourceInputFiles(traceability);
    expect(fixtureFiles).toContain('Vault.sol');
    const derivationNodes = backward.nodes.filter((node) => node.kind === 'derivation');
    expect(derivationNodes.length).toBeGreaterThan(0);
    for (const node of derivationNodes) {
      expect(node.id.startsWith(`derivation:${run.id}:`)).toBe(true);
    }
    const sourceFileNodes = backward.nodes.filter((node) => node.kind === 'source_file');
    expect(sourceFileNodes.length).toBeGreaterThan(0);
    for (const node of sourceFileNodes) {
      expect(fixtureFiles).toContain(node.id);
    }

    expect(service.getRun(relationship.id)).toEqual(run);
    expect(service.getProvenance(relationship.id).length).toBeGreaterThan(0);
    expect(service.getDerivations(relationship.id).length).toBeGreaterThan(0);
  });

  it('forward from source file to facts and relationships', () => {
    const inputFiles = sourceInputFiles(traceability);
    expect(inputFiles).toContain('Vault.sol');

    const forward = service.traceForward({ entity_type: 'source_file', entity_id: 'Vault.sol' });

    expect(forward.root).toBe('Vault.sol');
    expect(forward.direction).toBe('forward');
    expect(forward.status).toBe('NOT_APPLICABLE');
    expect(forward.truncated).toBe(false);

    const reached = new Set(
      forward.nodes.filter((node) => node.kind === 'entity').map((node) => node.id),
    );
    expect(state.facts.length).toBeGreaterThan(0);
    expect(state.relationships.length).toBeGreaterThan(0);
    for (const fact of state.facts) expect(reached).toContain(fact.id);
    for (const relationship of state.relationships) expect(reached).toContain(relationship.id);

    const expectedDepth: Record<string, number> = {
      source_file: 0,
      derivation: 1,
      entity: 2,
    };
    for (const node of forward.nodes) {
      expect(node.depth).toBe(expectedDepth[node.kind]);
    }
  });

  it('run → output traversal via getOutputs, and output → run via getRun', () => {
    const refs = materialRefs(state);
    expect(refs.length).toBeGreaterThan(0);

    expect(service.getOutputs(run.id)).toEqual([...refs].sort(compareRefs));
    expect(service.getOutputs('run:absent')).toEqual([]);

    for (const ref of refs) {
      expect(service.getRun(ref.entity_id)).toEqual(run);
    }
    expect(service.getRunById(run.id)).toEqual(run);
    expect(service.getRunById('run:absent')).toBeUndefined();
  });

  it('traceBackward + traceForward both-directions via trace', () => {
    const relationship = state.relationships[0]!;
    const ref: TraceReference = { entity_type: 'relationship', entity_id: relationship.id };

    expect(service.trace(relationship.id, { direction: 'backward' })).toEqual(
      service.traceBackward(relationship.id),
    );
    expect(service.trace(relationship.id, { direction: 'forward' })).toEqual(
      service.traceForward(ref),
    );

    const both = service.trace(relationship.id, { direction: 'both' });
    const backward = service.traceBackward(relationship.id);
    expect(both.root).toBe(relationship.id);
    expect(both.direction).toBe('both');
    expect(both.status).toBe('COMPLETE');
    expect(both.truncated).toBe(false);
    expect(both.nodes).toEqual(backward.nodes);
    for (const node of both.nodes) {
      expect(node.depth).toBeLessThanOrEqual(DEFAULT_TRACE_DEPTH);
    }
    expect(service.traceForward(ref).nodes).toEqual([
      { kind: 'entity', id: relationship.id, depth: 0 },
    ]);
  });

  it('e2e save/load preserves queries (§19 round trip with pipeline output)', () => {
    const repo = openRepo();
    const relationship = state.relationships[0]!;
    const material = materialRefs(state);
    const beforeRun = service.getRun(relationship.id);
    const beforeBackward = service.traceBackward(relationship.id);
    const beforeStatuses = material.map((ref) => service.getTraceStatus(ref.entity_id));
    expect(beforeStatuses.every((status) => status === 'COMPLETE')).toBe(true);

    repo.saveState(state);
    const loaded = repo.loadState();

    expect(loaded).not.toBeNull();
    expect(loaded!.traceability?.runs).toEqual(traceability.runs);
    expect([...loaded!.traceability!.derivations].sort((a, b) => compareIds(a.id, b.id))).toEqual(
      [...traceability.derivations].sort((a, b) => compareIds(a.id, b.id)),
    );
    expect(loaded!.traceability?.outputs).toEqual(traceability.outputs);
    expect(serializeReconState(loaded!)).toBe(serializeReconState(state));

    const reloaded = createTraceabilityService(loaded!);
    expect(reloaded.getRun(relationship.id)).toEqual(beforeRun!);
    expect(reloaded.traceBackward(relationship.id)).toEqual(beforeBackward);
    expect(reloaded.getOutputs(run.id)).toEqual(service.getOutputs(run.id));
    expect(material.map((ref) => reloaded.getTraceStatus(ref.entity_id))).toEqual(beforeStatuses);
    expect(reloaded.findIncompleteTraces()).toEqual([]);
    expect(reloaded.findOrphanedTraceReferences()).toEqual([]);
  });

  it('facts retain provenance (T5/§12)', () => {
    expect(state.facts.length).toBeGreaterThan(0);
    for (const fact of state.facts) {
      expect(fact.provenance.length).toBeGreaterThan(0);
      for (const record of fact.provenance) {
        expect(record.file).toMatch(/\.sol$/);
        expect(record.line_start).toBeGreaterThanOrEqual(1);
        expect(record.line_end!).toBeGreaterThanOrEqual(record.line_start!);
      }
      expect(service.getProvenance(fact.id).length).toBeGreaterThan(0);
      const backward = service.traceBackward(fact.id);
      expect(backward.status).toBe('COMPLETE');
      expect(backward.nodes.some((node) => node.kind === 'provenance_span')).toBe(true);
      expect(backward.nodes.some((node) => node.kind === 'source_file')).toBe(true);
    }
  });

  it('getTraceStatus over analyzed vault — all material entities COMPLETE', () => {
    const material = materialRefs(state);
    expect(material.length).toBeGreaterThan(0);
    for (const ref of material) {
      expect(service.getTraceStatus(ref.entity_id)).toBe('COMPLETE');
    }
    expect(service.findIncompleteTraces()).toEqual([]);
    expect(service.findOrphanedTraceReferences()).toEqual([]);
  });

  it('every material entity reaches its source files within the default depth', () => {
    const fixtureFiles = sourceInputFiles(traceability);
    const material = materialRefs(state);
    expect(material.length).toBeGreaterThan(0);
    for (const ref of material) {
      const backward = service.traceBackward(ref.entity_id);
      expect(backward.status).toBe('COMPLETE');
      expect(backward.truncated).toBe(false);
      const sourceFiles = backward.nodes.filter((node) => node.kind === 'source_file');
      expect(sourceFiles.length).toBeGreaterThan(0);
      for (const node of sourceFiles) expect(fixtureFiles).toContain(node.id);
      expect(Math.max(...backward.nodes.map((node) => node.depth))).toBeLessThanOrEqual(
        DEFAULT_TRACE_DEPTH,
      );
    }
  });

  it('depth is bounded at the default and longer chains report truncated', () => {
    expect(DEFAULT_TRACE_DEPTH).toBe(5);
    const relationship = state.relationships[0]!;

    const shallow = service.traceBackward(relationship.id, { depth: 1 });
    expect(shallow.truncated).toBe(true);
    expect(shallow.nodes.every((node) => node.depth <= 1)).toBe(true);

    const chain: TraceReference[] = materialRefs(state).slice(0, 9);
    expect(chain).toHaveLength(9);
    const operationVersion = traceability.derivations[0]!.operation_version;
    const chainState = createReconState({
      ...state,
      traceability: {
        ...traceability,
        derivations: [
          ...traceability.derivations,
          ...chainDerivations(run.id, operationVersion, chain),
        ],
      },
    });
    const chainService = createTraceabilityService(chainState);

    const bounded = chainService.traceBackward(chain[0]!.entity_id);
    expect(bounded.truncated).toBe(true);
    expect(Math.max(...bounded.nodes.map((node) => node.depth))).toBe(DEFAULT_TRACE_DEPTH);
    expect(bounded.nodes.some((node) => node.id === 'derivation:e2e-chain-3')).toBe(true);
    expect(bounded.nodes.some((node) => node.id === 'derivation:e2e-chain-4')).toBe(false);

    const deep = chainService.traceBackward(chain[0]!.entity_id, { depth: 20 });
    expect(deep.truncated).toBe(false);
    expect(deep.nodes.some((node) => node.id === 'derivation:e2e-chain-8')).toBe(true);
    expect(deep.nodes.some((node) => node.id === chain[8]!.entity_id)).toBe(true);
    expect(deep.nodes.some((node) => node.kind === 'run')).toBe(true);
    expect(Math.max(...deep.nodes.map((node) => node.depth))).toBeLessThanOrEqual(20);
  });

  it('circular derivations terminate cycle-safe', () => {
    const first = state.contracts[0]!;
    const second = state.contracts[1]!;
    const operationVersion = traceability.derivations[0]!.operation_version;
    const cycleState = createReconState({
      ...state,
      traceability: {
        ...traceability,
        derivations: [
          ...traceability.derivations,
          ...cycleDerivations(run.id, operationVersion, first.id, second.id),
        ],
      },
    });
    const cycleService = createTraceabilityService(cycleState);
    const ref: TraceReference = { entity_type: 'contract', entity_id: first.id };

    const backward = cycleService.traceBackward(first.id);
    expect(backward.status).toBe('COMPLETE');
    expect(backward.truncated).toBe(false);
    const backwardIds = new Set(backward.nodes.map((node) => node.id));
    expect(backwardIds).toContain('derivation:e2e-cycle-ab');
    expect(backwardIds).toContain('derivation:e2e-cycle-ba');
    expect(backwardIds).toContain(second.id);

    const forward = cycleService.traceForward(ref);
    expect(forward.truncated).toBe(false);
    const forwardIds = new Set(forward.nodes.map((node) => node.id));
    expect(forwardIds).toContain('derivation:e2e-cycle-ba');
    expect(forwardIds).toContain('derivation:e2e-cycle-ab');
    expect(forwardIds).toContain(second.id);
  });

  it('lineage-free entities report MISSING beside COMPLETE siblings', () => {
    const untraced = createContract({ name: 'UntracedVault', contract_type: 'core' });
    const withUntraced: ReconState = { ...state, contracts: [...state.contracts, untraced] };
    expect(withUntraced.contracts.length).toBe(state.contracts.length + 1);

    const recomputedHash = computeOutputIdentity(createReconState(withUntraced)).output_hash;
    expect(recomputedHash).not.toBe(run.output_identity?.output_hash);
    expect(
      catchCode(() =>
        createReconState({
          ...withUntraced,
          traceability: {
            ...traceability,
            runs: traceability.runs.map((item) => ({
              ...item,
              output_identity: {
                output_hash: recomputedHash,
                serialization: item.output_identity!.serialization,
              },
            })),
          },
        }),
      ),
    ).toBe('InvalidReconState');

    const demoted = createReconState({
      ...withUntraced,
      traceability: {
        ...traceability,
        runs: traceability.runs.map(({ output_identity: _current, ...rest }) => rest),
      },
    });
    const demotedService = createTraceabilityService(demoted);
    const relationship = demoted.relationships[0]!;

    expect(demotedService.getTraceStatus(untraced.id)).toBe('MISSING');
    expect(demotedService.getTraceStatus(relationship.id)).toBe('COMPLETE');
    expect(demotedService.getTraceStatus(state.facts[0]!.id)).toBe('COMPLETE');
    expect(demotedService.findIncompleteTraces()).toEqual([
      { entity_type: 'contract', entity_id: untraced.id, status: 'MISSING' },
    ]);
    expect(demotedService.traceBackward(untraced.id)).toEqual({
      root: untraced.id,
      direction: 'backward',
      status: 'MISSING',
      nodes: [{ kind: 'entity', id: untraced.id, depth: 0 }],
      truncated: false,
    });
    expect(demotedService.getRun(untraced.id)).toBeUndefined();
  });

  it('historical runs remain queryable after a second run', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'recon-e2e-'));
    try {
      const tmpRoot = join(tmp, 'vault');
      cpSync(VAULT_ROOT, tmpRoot, { recursive: true });
      appendFileSync(join(tmpRoot, 'Vault.sol'), '\n// e2e second-run edit\n');

      const second = (await analyzeProject(vaultConfig(tmpRoot))).state;
      const runA = run;
      const runB = second.traceability!.runs[0]!;

      expect(runB.id).not.toBe(runA.id);
      expect(runB.source_identity.source_hash).not.toBe(runA.source_identity.source_hash);
      expect(runB.configuration_identity.config_hash).toBe(
        runA.configuration_identity.config_hash,
      );
      expect(serializeReconState(second, { omitTraceability: true })).toBe(
        serializeReconState(state, { omitTraceability: true }),
      );

      const repo = openRepo();
      repo.saveState(state);
      repo.saveState(second);
      const loaded = repo.loadState();

      expect(loaded).not.toBeNull();
      const loadedTraceability = loaded!.traceability!;
      expect(loadedTraceability.runs.map((item) => item.id).sort(compareIds)).toEqual(
        [runA.id, runB.id].sort(compareIds),
      );
      expect(loadedTraceability.derivations.filter((item) => item.run_id === runA.id).length).toBe(
        traceability.derivations.length,
      );
      expect(loadedTraceability.derivations.filter((item) => item.run_id === runB.id).length).toBe(
        second.traceability!.derivations.length,
      );
      for (const item of loadedTraceability.derivations) {
        expect(item.id.startsWith(`derivation:${item.run_id}:`)).toBe(true);
      }

      const reloaded = createTraceabilityService(loaded!);
      const relationship = loaded!.relationships[0]!;
      expect(reloaded.getRunById(runA.id)).toEqual(runA);
      expect(reloaded.getRunById(runB.id)).toEqual(runB);
      expect(
        reloaded.findRunsBySourceIdentity(runA.source_identity.source_hash).map((item) => item.id),
      ).toEqual([runA.id]);
      expect(
        reloaded.findRunsBySourceIdentity(runB.source_identity.source_hash).map((item) => item.id),
      ).toEqual([runB.id]);
      expect(reloaded.getOutputs(runA.id)).toEqual(reloaded.getOutputs(runB.id));
      expect(reloaded.getOutputs(runA.id)).toHaveLength(materialRefs(state).length);

      const backward = reloaded.traceBackward(relationship.id);
      expect(backward.status).toBe('COMPLETE');
      const derivationsById = new Map(
        loadedTraceability.derivations.map((item) => [item.id, item]),
      );
      const attributionRuns = new Set<string>();
      for (const node of backward.nodes.filter((entry) => entry.kind === 'derivation')) {
        const derivation = derivationsById.get(node.id);
        expect(derivation).toBeDefined();
        expect(node.id.startsWith(`derivation:${derivation!.run_id}:`)).toBe(true);
        attributionRuns.add(derivation!.run_id);
      }
      expect(attributionRuns).toEqual(new Set([runA.id, runB.id]));
      expect(
        backward.nodes
          .filter((node) => node.kind === 'run')
          .map((node) => node.id)
          .sort(compareIds),
      ).toEqual([runA.id, runB.id].sort(compareIds));
      expect([runA.id, runB.id]).toContain(reloaded.getRun(relationship.id)?.id);
      expect(reloaded.findOrphanedTraceReferences()).toEqual([]);
      expect(reloaded.findIncompleteTraces()).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('line-shifting source edit is rejected by canonical persistence', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'recon-e2e-'));
    try {
      const tmpRoot = join(tmp, 'vault');
      cpSync(VAULT_ROOT, tmpRoot, { recursive: true });
      // prepend a comment: stable entity ids, shifted `source` spans
      const target = join(tmpRoot, 'Vault.sol');
      writeFileSync(target, `// e2e line-shift probe\n${readFileSync(target, 'utf8')}`);

      const shifted = (await analyzeProject(vaultConfig(tmpRoot))).state;
      expect(shifted.traceability!.runs[0]!.id).not.toBe(run.id);

      const repo = openRepo();
      repo.saveState(state);

      let thrown: unknown = undefined;
      try {
        repo.saveState(shifted);
      } catch (error) {
        thrown = error;
      }
      expect(isReconError(thrown)).toBe(true);
      if (!isReconError(thrown)) throw new Error('expected ReconError from the second save');
      expect(thrown.code).toBe('DuplicateCanonicalEntity');
      expect(thrown.message).toContain(
        'Contract contract:vault_sol:vault already exists with different content',
      );

      const loaded = repo.loadState();
      expect(loaded).not.toBeNull();
      expect(loaded!.traceability!.runs.map((item) => item.id)).toEqual([run.id]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
