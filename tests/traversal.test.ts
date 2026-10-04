import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/repository/migrate.js';
import { SqliteReconRepository } from '../src/repository/sqlite.js';
import { createContract } from '../src/domain/contract.js';
import { createFunction } from '../src/domain/function.js';
import { createStateVariable } from '../src/domain/state-variable.js';
import { createFact } from '../src/epistemic/fact.js';
import { createObservation } from '../src/epistemic/observation.js';
import { createAssumption } from '../src/epistemic/assumption.js';
import { createHypothesis } from '../src/epistemic/hypothesis.js';
import { createEvidence } from '../src/epistemic/evidence.js';
import { createReconState } from '../src/recon-state/state.js';
import type { ProvenanceInput } from '../src/epistemic/provenance.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';

const SRC: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Vault.sol',
  line_start: 40,
  line_end: 52,
};

const CHAIN_SRC: ProvenanceInput = {
  source_type: 'onchain',
  chain_id: 'ethereum',
  address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  block_number: 19_000_000,
};

function openRepo(): SqliteReconRepository {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return new SqliteReconRepository(db);
}

function seededRepo(): {
  repo: SqliteReconRepository;
  contract: ReturnType<typeof createContract>;
  factA: ReturnType<typeof createFact>;
  factB: ReturnType<typeof createFact>;
  observation: ReturnType<typeof createObservation>;
  assumption: ReturnType<typeof createAssumption>;
  hypothesis: ReturnType<typeof createHypothesis>;
  evidenceForHypothesis: ReturnType<typeof createEvidence>;
  evidenceForFact: ReturnType<typeof createEvidence>;
  evidenceAgainstAssumption: ReturnType<typeof createEvidence>;
} {
  const repo = openRepo();
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
  });
  const stateVar = createStateVariable({
    contract_id: contract.id,
    name: 'totalShares',
    type: 'uint256',
    visibility: 'public',
  });
  const factA = createFact({
    subject_id: deposit.id,
    predicate: 'WRITES',
    object_id: stateVar.id,
    provenance: [SRC],
    created_at: FIXED_TS,
  });
  const factB = createFact({
    subject_id: deposit.id,
    predicate: 'READS',
    object_id: stateVar.id,
    provenance: [SRC],
    created_at: FIXED_TS,
  });
  const observation = createObservation({
    statement: 'deposit reads and writes totalShares',
    based_on: [factA.id, factB.id],
    provenance: [CHAIN_SRC],
    created_at: FIXED_TS,
  });
  const assumption = createAssumption({
    statement: 'share accounting stays consistent',
    based_on: [observation.id],
    created_at: FIXED_TS,
  });
  const hypothesis = createHypothesis({
    statement: 'inflation attack is possible',
    based_on: [assumption.id],
    affected_entities: [stateVar.id],
    created_at: FIXED_TS,
  });
  const evidenceForHypothesis = createEvidence({
    evidence_type: 'static',
    description: 'donation attack path exists in source',
    supports: [hypothesis.id],
    provenance: [CHAIN_SRC],
    created_at: FIXED_TS,
  });
  const evidenceForFact = createEvidence({
    evidence_type: 'source',
    description: 'write to totalShares confirmed in deposit',
    supports: [factA.id],
    provenance: [CHAIN_SRC],
    created_at: FIXED_TS,
  });
  const evidenceAgainstAssumption = createEvidence({
    evidence_type: 'onchain',
    description: 'share accounting held in historical runs',
    contradicts: [assumption.id],
    provenance: [CHAIN_SRC],
    created_at: FIXED_TS,
  });
  repo.saveState(
    createReconState({
      contracts: [contract],
      functions: [deposit],
      state_variables: [stateVar],
      facts: [factA, factB],
      observations: [observation],
      assumptions: [assumption],
      hypotheses: [hypothesis],
      evidence: [evidenceForHypothesis, evidenceForFact, evidenceAgainstAssumption],
    }),
  );
  return {
    repo,
    contract,
    factA,
    factB,
    observation,
    assumption,
    hypothesis,
    evidenceForHypothesis,
    evidenceForFact,
    evidenceAgainstAssumption,
  };
}

describe('reasoning traversal', () => {
  it('walks the full upstream basis chain from a hypothesis down to its facts', () => {
    const { repo, hypothesis, assumption, observation, factA, factB } = seededRepo();
    expect(repo.getUpstreamReasoning(hypothesis.id)).toEqual([
      hypothesis.id,
      assumption.id,
      observation.id,
      ...[factA.id, factB.id].sort(),
    ]);
  });

  it('bounds upstream traversal by depth and includes only the root at depth zero', () => {
    const { repo, hypothesis, assumption, observation } = seededRepo();
    expect(repo.getUpstreamReasoning(hypothesis.id, 0)).toEqual([hypothesis.id]);
    expect(repo.getUpstreamReasoning(hypothesis.id, -1)).toEqual([hypothesis.id]);
    expect(repo.getUpstreamReasoning(hypothesis.id, 1)).toEqual([
      hypothesis.id,
      assumption.id,
    ]);
    expect(repo.getUpstreamReasoning(hypothesis.id, 2)).toEqual([
      hypothesis.id,
      assumption.id,
      observation.id,
    ]);
  });

  it('walks downstream from a fact through observation and assumption to hypothesis', () => {
    const { repo, factA, observation, assumption, hypothesis } = seededRepo();
    expect(repo.getDownstreamReasoning(factA.id)).toEqual([
      factA.id,
      observation.id,
      assumption.id,
      hypothesis.id,
    ]);
    expect(repo.getDownstreamReasoning(assumption.id)).toEqual([
      assumption.id,
      hypothesis.id,
    ]);
  });

  it('returns only the root when nothing references it downstream', () => {
    const { repo, hypothesis, contract } = seededRepo();
    expect(repo.getDownstreamReasoning(hypothesis.id)).toEqual([hypothesis.id]);
    expect(repo.getUpstreamReasoning(contract.id)).toEqual([contract.id]);
  });

  it('collects the evidence chain as reasoning nodes followed by attached evidence ids', () => {
    const {
      repo,
      hypothesis,
      assumption,
      observation,
      factA,
      factB,
      evidenceForHypothesis,
      evidenceForFact,
      evidenceAgainstAssumption,
    } = seededRepo();
    expect(repo.getEvidenceChain(hypothesis.id)).toEqual([
      hypothesis.id,
      assumption.id,
      observation.id,
      ...[factA.id, factB.id].sort(),
      ...[evidenceForHypothesis.id, evidenceForFact.id, evidenceAgainstAssumption.id].sort(),
    ]);
  });

  it('attaches only evidence linked to nodes actually reached', () => {
    const { repo, factA, observation, evidenceForFact } = seededRepo();
    expect(repo.getEvidenceChain(observation.id, 0)).toEqual([observation.id]);
    expect(repo.getEvidenceChain(factA.id, 0)).toEqual([factA.id, evidenceForFact.id]);
  });
});
