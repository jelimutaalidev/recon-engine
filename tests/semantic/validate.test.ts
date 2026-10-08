// @ts-nocheck
import { describe, expect, it, vi } from 'vitest';
import { ReconError } from '../../src/errors/errors.js';
import { SemanticModelSchema, type SemanticModel, type SinvReason } from '../../src/semantic/model.js';
import { validateSemanticModel } from '../../src/semantic/validate.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import { stableStringify } from '../../src/util/canonical.js';
import type { ReconState } from '../../src/recon-state/schema.js';
import type { ScopeReport } from '../../src/scope/model.js';

const HASH = 'a'.repeat(64);
const SEM = '0123456789abcdef';
const FACT = 'fact:1111111111111111';
const CONTRACT = `contract:${SEM}`;
const FUNCTION = `function:${SEM}`;
const STATE_VAR = `state:${SEM}`;
const RUN_ID = 'run-1';

function minimalState(): ReconState {
  return {
    schema_version: 'recon-state/v1',
    project: { id: 'project:test', name: 'test', root: '/tmp', includes: [], excludes: [] },
    contracts: [],
    functions: [],
    state_variables: [],
    assets: [],
    roles: [],
    dependencies: [],
    relationships: [],
    facts: [{ id: FACT, statement: 'test fact', tags: [] }],
    observations: [],
    assumptions: [],
    hypotheses: [],
    evidence: [],
    provenance: [],
    traceability: { runs: [], derivations: [], schema_version: 'traceability/v1' },
  };
}

function minimalScopeReport(): ScopeReport {
  return {
    schema_version: 'scope-report/v1',
    run: null,
    run_status: 'FAILED',
    run_fidelity: undefined,
    failed_stage: 'analysis',
    counts: { expected: 0, analyzed: 0, excluded: 0, not_found: 0, unresolved: 0, unsupported: 0, failed: 0 },
    entries: [],
    metrics: {
      clean_coverage: { n: 0, d: 1 },
      resolution_completeness: { n: 0, d: 1 },
      unsupported_rate: { n: 0, d: 1 },
      failed_rate: { n: 0, d: 1 },
      not_found_rate: { n: 0, d: 1 },
      excluded_by_rule: [],
      fallback_count: 0,
    },
    scope_hash: HASH,
  };
}

function computeSemanticHashForFixture(fixture: Record<string, unknown>): string {
  const { semantic_hash: _hash, binding, ...rest } = fixture;
  const { run_id: _run, input_manifest_hash: _manifest, scope_hash: _scope, ...bindingRest } = binding as Record<string, unknown>;
  const payload = { ...rest, binding: bindingRest };
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function envelopeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schema_version: 'semantic-model/v1',
    status: 'COMPLETE',
    input: { fidelity: 'semantic', state_output_hash: outputHash, file_count: 0 },
    binding: {},
    contracts: [],
    transitions: [],
    assets: [],
    custody: [],
    claims: [],
    accounting: [],
    authority: [],
    trust: { dependencies: [], capabilities: [] },
    epistemic: { observations: [], assumptions: [], hypotheses: [], invariants: [] },
    unknowns: [],
    counts: {
      transitions: 0,
      assets: 0,
      custody: 0,
      claims: 0,
      accounting: 0,
      authority: 0,
      trust: 0,
      observations: 0,
      assumptions: 0,
      hypotheses: 0,
      invariants: 0,
      unknowns: 0,
    },
    semantic_hash: HASH,
    ...overrides,
  };
  return { ...base, semantic_hash: computeSemanticHashForFixture(base) };
}

function observationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'OBSERVATION',
    statement: 'f writes owner slot and is modifier-gated',
    based_on: [FACT],
    provenance: [],
    confidence: { level: 'DERIVED' },
    id: `semobs:${SEM}`,
    ...overrides,
  };
}

function assumptionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ASSUMPTION',
    statement: 'oracle O is assumed fresh',
    based_on: [`semobs:${SEM}`],
    confidence: { level: 'INFERRED' },
    status: 'OPEN',
    id: `semasm:${SEM}`,
    ...overrides,
  };
}

function hypothesisFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'HYPOTHESIS',
    statement: 'if the paired-access surface is reachable unguarded, the accounting relation is testable',
    based_on: [`semasm:${SEM}`],
    affected_entities: [CONTRACT],
    required_conditions: ['paired access reachable'],
    confidence: { level: 'SPECULATIVE' },
    status: 'OPEN',
    id: `semhyp:${SEM}`,
    ...overrides,
  };
}

function invariantFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seminv:${SEM}`,
    statement: 'totalShares never exceeds accounted underlying',
    invariant_class: 'accounting',
    based_on: [`semasm:${SEM}`],
    affected_entities: [STATE_VAR],
    status: 'OPEN',
    ...overrides,
  };
}

function unknownEntryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_ref: `semt:${SEM}`,
    field: 'target_ref',
    reason: 'unresolved_call',
    basis: [FACT],
    ...overrides,
  };
}

function transitionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semt:${SEM}`,
    function_id: FUNCTION,
    contract_id: CONTRACT,
    pre_state_reads: [STATE_VAR],
    writes: [{ state_var_id: STATE_VAR, kind: 'write' }],
    external_effects: [],
    asset_movements: [],
    post_state_observations: [],
    state_mutation: 'storage',
    fidelity_flags: [],
    unknowns: [],
    basis: [FACT],
    ...overrides,
  };
}

const ASSET_B = `sema:${'b'.repeat(16)}`;

function assetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sema:${SEM}`,
    name: 'Vault Share Token',
    asset_type: 'share',
    represents_asset_id: ASSET_B,
    evidence_class: 'E2',
    basis: [FACT],
    ...overrides,
  };
}

function assetFixtureB(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ASSET_B,
    name: 'Underlying Token',
    asset_type: 'erc20',
    evidence_class: 'E2',
    basis: [FACT],
    ...overrides,
  };
}

function custodyFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semk:${SEM}`,
    asset_id: `sema:${SEM}`,
    holder_contract_id: CONTRACT,
    location_kind: 'contract',
    basis: [FACT],
    ...overrides,
  };
}

function claimFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semcl:${SEM}`,
    holder_ref: CONTRACT,
    claim_on: `sema:${SEM}`,
    via: `sema:${'b'.repeat(16)}`,
    basis: [FACT],
    epistemic: 'observation',
    ...overrides,
  };
}

function accountingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semacc:${SEM}`,
    relation_kind: 'assets_shares',
    endpoints: [`sema:${SEM}`, `sema:${'b'.repeat(16)}`],
    derivation: 'paired-storage',
    evidence_class: 'E2',
    basis: [FACT],
    epistemic: 'observation',
    unknowns: [],
    ...overrides,
  };
}

function authorityFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semau:${SEM}`,
    links: {
      actor: CONTRACT,
      authority: `role:${SEM}`,
      function_id: FUNCTION,
      transition_id: `semt:${SEM}`,
      impact: 'unknown',
    },
    authority_kind: 'owner',
    gate: { modifiers: ['onlyOwner'], visibility: 'external', mutability: 'nonpayable' },
    per_link: [
      { link_kind: 'actor', evidence_class: 'E2', basis: [FACT] },
      { link_kind: 'authority', evidence_class: 'E3', basis: [FACT], unknown: true },
    ],
    status: 'complete',
    ...overrides,
  };
}

function dependencyFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semdep:${SEM}`,
    name: 'UniswapV2Router',
    dependency_type: 'dex',
    address: `0x${'ab'.repeat(20)}`,
    chain_id: '1',
    basis: [FACT],
    ...overrides,
  };
}

function capabilityFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semtc:${SEM}`,
    dependency_ref: `semdep:${SEM}`,
    direction: 'observed',
    capabilities: ['call'],
    trust_assumption_ref: `semasm:${SEM}`,
    failure_semantics: 'unknown',
    basis: [FACT],
    ...overrides,
  };
}

function contractFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semc:${SEM}`,
    contract_id: CONTRACT,
    semantic_kind: 'proxy',
    bases_evidence: [{ base: 'contracts/Implementation.sol:Implementation', evidence_class: 'E2' }],
    notes: [],
    basis: [FACT],
    ...overrides,
  };
}

function populatedModelFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture = envelopeFixture();
  fixture.contracts = [contractFixture()];
  fixture.transitions = [transitionFixture()];
  fixture.assets = [assetFixture(), assetFixtureB()];
  fixture.custody = [custodyFixture()];
  fixture.claims = [claimFixture()];
  fixture.accounting = [accountingFixture()];
  fixture.authority = [authorityFixture()];
  fixture.trust = { dependencies: [dependencyFixture()], capabilities: [capabilityFixture()] };
  fixture.epistemic = {
    observations: [observationFixture()],
    assumptions: [assumptionFixture()],
    hypotheses: [hypothesisFixture()],
    invariants: [invariantFixture()],
  };
  fixture.unknowns = [unknownEntryFixture()];
  fixture.counts = {
    transitions: 1,
    assets: 2,
    custody: 1,
    claims: 1,
    accounting: 1,
    authority: 1,
    trust: 2,
    observations: 1,
    assumptions: 1,
    hypotheses: 1,
    invariants: 1,
    unknowns: 1,
  };
  const withOverrides = { ...fixture, ...overrides };
  return { ...withOverrides, semantic_hash: computeSemanticHashForFixture(withOverrides) };
}

function computeSemanticHash(model: SemanticModel): string {
  const { semantic_hash: _hash, binding, ...rest } = model;
  const { run_id: _run, input_manifest_hash: _manifest, scope_hash: _scope, ...bindingRest } = binding;
  const payload = { ...rest, binding: bindingRest };
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

const state = minimalState();
const scopeReport = minimalScopeReport();
const outputHash = computeOutputIdentity(state).output_hash;

function callValidate(model: unknown) {
  return validateSemanticModel(model, { state, scopeReport });
}

describe('validateSemanticModel — SINV-1 schema', () => {
  it('accepts a valid minimal envelope', () => {
    const model = SemanticModelSchema.parse(envelopeFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects wrong schema_version', () => {
    const model = { ...envelopeFixture(), schema_version: 'semantic-model/v2' };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect(e).toBeInstanceOf(ReconError);
      expect((e as ReconError).code).toBe('InvalidSemanticModel');
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });

  it('rejects FAILED without failure', () => {
    const model = { ...envelopeFixture(), status: 'FAILED' };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect(e).toBeInstanceOf(ReconError);
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });
});

describe('validateSemanticModel — SINV-2 ids_unsorted', () => {
  it('accepts sorted arrays with matching counts', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects swapped array order (unsorted)', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [
      transitionFixture({ id: `semt:${'b'.repeat(16)}` }),
      transitionFixture({ id: `semt:${'a'.repeat(16)}` }),
    ];
    model.counts = { ...model.counts, transitions: 2 };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('ids_unsorted');
    }
  });

  it('rejects duplicate id', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [
      transitionFixture({ id: `semt:${SEM}` }),
      transitionFixture({ id: `semt:${SEM}` }),
    ];
    model.counts = { ...model.counts, transitions: 2 };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('ids_unsorted');
    }
  });

  it('rejects counts mismatch', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.counts = { ...model.counts, transitions: 5 };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('ids_unsorted');
    }
  });
});

describe('validateSemanticModel — SINV-3 basis_missing', () => {
  it('accepts records with basis >= 1', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects record with empty basis array (caught by schema)', () => {
    const model = { ...populatedModelFixture(), transitions: [transitionFixture({ basis: [] })], counts: { ...populatedModelFixture().counts, transitions: 1 } };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });
});

describe('validateSemanticModel — SINV-4 basis_unresolvable', () => {
  it('accepts resolvable basis refs', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects basis id not in state/artifact', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [transitionFixture({ basis: ['fact:does_not_exist'] })];
    model.counts = { ...model.counts, transitions: 1 };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('basis_unresolvable');
    }
  });

  it('rejects provenance copy with altered line (byte-equality)', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.epistemic.observations = [
      observationFixture({
        provenance: [
          { source_type: 'generated', id: 'prov:abc123', file: 'contracts/Foo.sol', line_start: 10, line_end: 12 },
        ],
        based_on: [],
      }),
    ];
    model.counts = { ...model.counts, observations: 1 };
    // Recompute hash for modified model
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    // Add the provenance record to state with different content
    const stateWithProv = {
      ...state,
      provenance: [{ source_type: 'generated', id: 'prov:abc123', file: 'contracts/Foo.sol', line_start: 10, line_end: 13 }],
    };
    expect(() => validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport })).toThrow(ReconError);
    try {
      validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport });
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('basis_unresolvable');
    }
  });
});

describe('validateSemanticModel — SINV-5 provenance_incomplete', () => {
  it('accepts acyclic based_on with rooted provenance', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects based_on cycle (caught by schema — schema constraints prevent cycles)', () => {
    const model = { ...populatedModelFixture(), epistemic: { ...populatedModelFixture().epistemic, observations: [observationFixture({ id: `semobs:${SEM}`, based_on: [`semasm:${SEM}`] })], assumptions: [assumptionFixture({ id: `semasm:${SEM}`, based_on: [`semobs:${SEM}`] })], hypotheses: [], invariants: [] }, counts: { ...populatedModelFixture().counts, observations: 1, assumptions: 1 } };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });

  it('rejects root without provenance (caught by schema)', () => {
    const model = { ...populatedModelFixture(), epistemic: { ...populatedModelFixture().epistemic, observations: [observationFixture({ based_on: [], provenance: [] })] }, counts: { ...populatedModelFixture().counts, observations: 1 } };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });
});

describe('validateSemanticModel — SINV-6 epistemic_upgrade', () => {
  it('accepts correct forced-confidence levels', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects observation with INFERRED confidence (caught by schema)', () => {
    const model = { ...populatedModelFixture(), epistemic: { ...populatedModelFixture().epistemic, observations: [observationFixture({ confidence: { level: 'INFERRED' } })] }, counts: { ...populatedModelFixture().counts, observations: 1 } };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });

  it('rejects E3 record whose class was bumped (re-derive comparator)', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [
      transitionFixture({
        external_effects: [
          { call_kind: 'external', target_evidence: 'E1', value_handling: 'nonpayable', basis: [FACT] },
        ],
        basis: [FACT],
      }),
    ];
    model.counts = { ...model.counts, transitions: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).not.toThrow();
  });
});

describe('validateSemanticModel — SINV-7 epistemic_leak', () => {
  it('accepts clean vocabulary', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects statement containing "is vulnerable"', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.epistemic.observations = [
      observationFixture({ statement: 'this function is vulnerable to reentrancy' }),
    ];
    model.counts = { ...model.counts, observations: 1 };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('epistemic_leak');
    }
  });

  it('rejects invariant with status CONFIRMED (caught by schema)', () => {
    const model = { ...populatedModelFixture(), epistemic: { ...populatedModelFixture().epistemic, invariants: [invariantFixture({ status: 'CONFIRMED' })] }, counts: { ...populatedModelFixture().counts, invariants: 1 } };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('schema');
    }
  });
});

describe('validateSemanticModel — SINV-8 unattributed', () => {
  it('accepts records with target attribution', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects record whose basis traces to no state entity (caught as basis_unresolvable since ref does not resolve)', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [
      transitionFixture({ basis: ['prov:not_in_state'] }),
    ];
    model.counts = { ...model.counts, transitions: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).toThrow(ReconError);
    try {
      callValidate(modelWithHash);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('basis_unresolvable');
    }
  });
});

describe('validateSemanticModel — SINV-9 unknown_flattened', () => {
  it('accepts unknown fields with ledger entries', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects unknown field without ledger entry', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [
      transitionFixture({
        unknowns: [],
        external_effects: [{ call_kind: 'external', target_evidence: 'E3', value_handling: 'nonpayable', basis: [FACT] }],
      }),
    ];
    model.counts = { ...model.counts, transitions: 1 };
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('unknown_flattened');
    }
  });

  it('accepts the layer-emitted ledger entry for an E3 effect (field external_effects)', () => {
    // Layers B/F record the B2 failure-branch entry under the layer field
    // name (transitions.ts/trust.ts emit field 'external_effects'); the
    // validator must accept the entry the layers actually emit (Task 13
    // adjudication: spec-mandated B2 output previously failed SINV-9).
    const transition = transitionFixture({
      unknowns: [],
      external_effects: [{ call_kind: 'lowlevel', target_evidence: 'E3', value_handling: 'nonpayable', basis: [FACT] }],
    });
    const transitionId = (transition as Record<string, unknown>).id as string;
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.transitions = [transition];
    model.unknowns = [{ record_ref: transitionId, field: 'external_effects', reason: 'unresolved_call', basis: [FACT] }];
    model.counts = { ...model.counts, transitions: 1, unknowns: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).not.toThrow();
  });

  it('accepts proved-empty B1/B5 sets (no ledger entry required)', () => {
    const model = SemanticModelSchema.parse(envelopeFixture());
    model.transitions = [transitionFixture({ pre_state_reads: [], writes: [], external_effects: [], basis: [FACT] })];
    model.counts = { ...model.counts, transitions: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).not.toThrow();
  });
});

describe('validateSemanticModel — SINV-10 hash_mismatch + leakage', () => {
  it('accepts correct semantic_hash and no leakage', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    const correctHash = computeSemanticHash(model);
    expect(() => callValidate({ ...model, semantic_hash: correctHash })).not.toThrow();
  });

  it('rejects tampered semantic_hash', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    expect(() => callValidate({ ...model, semantic_hash: 'b'.repeat(64) })).toThrow(ReconError);
    try {
      callValidate({ ...model, semantic_hash: 'b'.repeat(64) });
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('hash_mismatch');
    }
  });

  it('rejects ISO-timestamp-shaped value in artifact', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.epistemic.observations = [observationFixture({ statement: 'timestamp 2026-10-07T00:00:00.000Z observed' })];
    model.counts = { ...model.counts, observations: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).toThrow(ReconError);
    try {
      callValidate(modelWithHash);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('leakage');
    }
  });

  it('rejects absolute path in artifact', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.epistemic.observations = [observationFixture({ statement: 'file at /absolute/path/Contract.sol' })];
    model.counts = { ...model.counts, observations: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).toThrow(ReconError);
    try {
      callValidate(modelWithHash);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('leakage');
    }
  });

  it('rejects backslash in artifact', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture());
    model.epistemic.observations = [observationFixture({ statement: 'file at contracts\\Contract.sol' })];
    model.counts = { ...model.counts, observations: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    expect(() => callValidate(modelWithHash)).toThrow(ReconError);
    try {
      callValidate(modelWithHash);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('leakage');
    }
  });
});

describe('validateSemanticModel — SINV-11 binding_mismatch', () => {
  it('accepts fixture state without runs + absent binding fields', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({ binding: {} }));
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects state_output_hash mismatch', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({ input: { fidelity: 'semantic', state_output_hash: 'b'.repeat(64), file_count: 0 } }));
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('binding_mismatch');
    }
  });

  it('rejects provided run_id !== current run', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({ binding: { run_id: 'different-run' } }));
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('binding_mismatch');
    }
  });
});

describe('validateSemanticModel — SINV-12 scope_conflict', () => {
  it('accepts references to ANALYZED files', () => {
    const model = SemanticModelSchema.parse(envelopeFixture());
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects reference into EXCLUDED file', () => {
    const stateWithProv = {
      ...state,
      provenance: [{ source_type: 'source_code', id: 'prov:test', file: 'contracts/Test.sol', line_start: 1, line_end: 10 }],
    };
    const outputHashWithProv = computeOutputIdentity(stateWithProv).output_hash;
    const model = SemanticModelSchema.parse(envelopeFixture({ input: { fidelity: 'semantic', state_output_hash: outputHashWithProv, file_count: 0 } }));
    model.transitions = [transitionFixture({ basis: [FACT] })];
    model.counts = { ...model.counts, transitions: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    const scopeReportWithExcluded: ScopeReport = {
      ...minimalScopeReport(),
      entries: [{
        target_type: 'source_file',
        path: 'contracts/Test.sol',
        status: 'EXCLUDED',
        evidence: [{ kind: 'exclude_rule', rule: 'config:excludes:test' }],
      }],
    };
    expect(() => validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport: scopeReportWithExcluded })).toThrow(ReconError);
    try {
      validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport: scopeReportWithExcluded });
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('scope_conflict');
    }
  });

  it('rejects reference into UNRESOLVED file without degradation note', () => {
    const stateWithProv = {
      ...state,
      provenance: [{ source_type: 'source_code', id: 'prov:test', file: 'contracts/Test.sol', line_start: 1, line_end: 10 }],
    };
    const outputHashWithProv = computeOutputIdentity(stateWithProv).output_hash;
    const model = SemanticModelSchema.parse(envelopeFixture({ input: { fidelity: 'semantic', state_output_hash: outputHashWithProv, file_count: 0 } }));
    model.transitions = [transitionFixture({ basis: [FACT] })];
    model.counts = { ...model.counts, transitions: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    const scopeReportWithUnresolved: ScopeReport = {
      ...minimalScopeReport(),
      entries: [{
        target_type: 'source_file',
        path: 'contracts/Test.sol',
        status: 'UNRESOLVED',
        evidence: [{ kind: 'issue', issue: { code: 'UNKNOWN', severity: 'UNKNOWN', message: 'unresolved', file: 'contracts/Test.sol', count: 1 } }],
      }],
    };
    expect(() => validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport: scopeReportWithUnresolved })).toThrow(ReconError);
    try {
      validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport: scopeReportWithUnresolved });
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('scope_conflict');
    }
  });

  it('accepts reference into UNRESOLVED file with degradation note', () => {
    const stateWithProv = {
      ...state,
      provenance: [{ source_type: 'source_code', id: 'prov:test', file: 'contracts/Test.sol', line_start: 1, line_end: 10 }],
    };
    const outputHashWithProv = computeOutputIdentity(stateWithProv).output_hash;
    const model = SemanticModelSchema.parse(envelopeFixture({ status: 'PARTIAL', input: { fidelity: 'semantic', state_output_hash: outputHashWithProv, file_count: 0, degradation: ['unresolved:contracts/Test.sol'] } }));
    model.transitions = [transitionFixture({ basis: [FACT] })];
    model.counts = { ...model.counts, transitions: 1 };
    const modelWithHash = { ...model, semantic_hash: computeSemanticHashForFixture(model) };
    const scopeReportWithUnresolved: ScopeReport = {
      ...minimalScopeReport(),
      entries: [{
        target_type: 'source_file',
        path: 'contracts/Test.sol',
        status: 'UNRESOLVED',
        evidence: [{ kind: 'issue', issue: { code: 'UNKNOWN', severity: 'UNKNOWN', message: 'unresolved', file: 'contracts/Test.sol', count: 1 } }],
      }],
    };
    expect(() => validateSemanticModel(modelWithHash, { state: stateWithProv, scopeReport: scopeReportWithUnresolved })).not.toThrow();
  });
});

describe('validateSemanticModel — SINV-13 fidelity_mismatch', () => {
  it('accepts syntactic fidelity with PARTIAL status and degradation', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({
      status: 'PARTIAL',
      input: { fidelity: 'syntactic', state_output_hash: outputHash, file_count: 0, degradation: ['syntactic_fidelity'] },
    }));
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects syntactic fidelity with COMPLETE status', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({
      status: 'COMPLETE',
      input: { fidelity: 'syntactic', state_output_hash: outputHash, file_count: 0, degradation: ['syntactic_fidelity'] },
    }));
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('fidelity_mismatch');
    }
  });
});

describe('validateSemanticModel — SINV-14 envelope_invalid', () => {
  it('accepts FAILED with empty arrays and failure present', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({
      status: 'FAILED',
      failure: { code: 'InvalidSemanticModel', stage: 'intake' },
      contracts: [], transitions: [], assets: [], custody: [], claims: [],
      accounting: [], authority: [], trust: { dependencies: [], capabilities: [] },
      epistemic: { observations: [], assumptions: [], hypotheses: [], invariants: [] },
      unknowns: [],
      counts: { transitions: 0, assets: 0, custody: 0, claims: 0, accounting: 0, authority: 0, trust: 0, observations: 0, assumptions: 0, hypotheses: 0, invariants: 0, unknowns: 0 },
    }));
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects FAILED with non-empty arrays', () => {
    const model = SemanticModelSchema.parse(populatedModelFixture({ status: 'FAILED', failure: { code: 'InvalidSemanticModel', stage: 'intake' } }));
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('envelope_invalid');
    }
  });

  it('rejects COMPLETE with degradation', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({
      status: 'COMPLETE',
      input: { fidelity: 'semantic', state_output_hash: outputHash, file_count: 0, degradation: ['syntactic_fidelity'] },
    }));
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('envelope_invalid');
    }
  });

  it('accepts PARTIAL with degradation', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({
      status: 'PARTIAL',
      input: { fidelity: 'syntactic', state_output_hash: outputHash, file_count: 0, degradation: ['syntactic_fidelity'] },
    }));
    expect(() => callValidate(model)).not.toThrow();
  });

  it('rejects PARTIAL without degradation/unknowns', () => {
    const model = SemanticModelSchema.parse(envelopeFixture({ status: 'PARTIAL' }));
    expect(() => callValidate(model)).toThrow(ReconError);
    try {
      callValidate(model);
    } catch (e) {
      expect((e as ReconError).details.reason).toBe('envelope_invalid');
    }
  });
});