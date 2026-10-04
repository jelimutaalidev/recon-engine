import { createProject } from '../src/domain/project.js';
import { createContract } from '../src/domain/contract.js';
import { createFunction } from '../src/domain/function.js';
import { createStateVariable } from '../src/domain/state-variable.js';
import { createRelationship } from '../src/relationships/relationship.js';
import { createFact } from '../src/epistemic/fact.js';
import { createObservation } from '../src/epistemic/observation.js';
import { createAssumption } from '../src/epistemic/assumption.js';
import { createHypothesis } from '../src/epistemic/hypothesis.js';
import { createEvidence } from '../src/epistemic/evidence.js';
import type { ProvenanceInput } from '../src/epistemic/provenance.js';
import type { ReconStateInput } from '../src/recon-state/schema.js';

const FIXED_TS = '2024-01-01T00:00:00.000Z';

const SOURCE: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Vault.sol',
  line_start: 40,
  line_end: 52,
};

const ONCHAIN: ProvenanceInput = {
  source_type: 'onchain',
  chain_id: 'ethereum',
  address: '0xcccccccccccccccccccccccccccccccccccccccc',
  block_number: 19_000_000,
};

export function buildVaultState(): ReconStateInput {
  const project = createProject({
    name: 'AcmeVault',
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  });
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
  const stateVariable = createStateVariable({
    contract_id: contract.id,
    name: 'totalShares',
    type: 'uint256',
    visibility: 'public',
  });
  const writesShares = createRelationship({
    type: 'WRITES',
    source_id: deposit.id,
    target_id: stateVariable.id,
    provenance: [SOURCE],
    created_at: FIXED_TS,
  });
  const fact = createFact({
    subject_id: deposit.id,
    predicate: 'WRITES',
    object_id: stateVariable.id,
    provenance: [SOURCE],
    created_at: FIXED_TS,
  });
  const observation = createObservation({
    statement: 'deposit writes totalShares without a caps check',
    based_on: [fact.id],
    provenance: [ONCHAIN],
    created_at: FIXED_TS,
  });
  const assumption = createAssumption({
    statement: 'share accounting stays consistent under donation',
    based_on: [observation.id],
    created_at: FIXED_TS,
  });
  const hypothesis = createHypothesis({
    statement: 'inflation attack is possible against the vault',
    based_on: [assumption.id],
    affected_entities: [stateVariable.id],
    created_at: FIXED_TS,
  });
  const evidence = createEvidence({
    evidence_type: 'static',
    description: 'donation attack path exists in deposit flow',
    supports: [hypothesis.id],
    provenance: [SOURCE],
    created_at: FIXED_TS,
  });
  return {
    project,
    contracts: [contract],
    functions: [deposit],
    state_variables: [stateVariable],
    relationships: [writesShares],
    facts: [fact],
    observations: [observation],
    assumptions: [assumption],
    hypotheses: [hypothesis],
    evidence: [evidence],
  };
}
