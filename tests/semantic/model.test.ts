import { describe, expect, it } from 'vitest';
import {
  AssetRecordSchema,
  AuthorityChainSchema,
  ClaimRecordSchema,
  ContractSemanticsSchema,
  AccountingRelationSchema,
  CandidateInvariantSchema,
  CustodyRecordSchema,
  EVIDENCE_CLASSES,
  ExternalDependencySchema,
  INVARIANT_STATUSES,
  SEM_ASM_REF,
  SEM_EPISTEMIC_REF,
  SEM_OBS_REF,
  SEMANTIC_STAGES,
  SEMANTIC_STATUSES,
  SemanticAssumptionSchema,
  SemanticDraftSchema,
  SemanticHypothesisSchema,
  SemanticModelSchema,
  SemanticObservationSchema,
  StateTransitionSchema,
  TrustCapabilitySchema,
  UnknownIndexEntrySchema,
  type SemanticDraft,
  type SemanticModel,
} from '../../src/semantic/model.js';

const HASH = 'a'.repeat(64);
const SEM = '0123456789abcdef';
const FACT = 'fact:1111111111111111';
const CONTRACT = `contract:${SEM}`;
const FUNCTION = `function:${SEM}`;
const STATE_VAR = `state:${SEM}`;

function envelopeFixture(): Record<string, unknown> {
  return {
    schema_version: 'semantic-model/v1',
    status: 'COMPLETE',
    input: { fidelity: 'semantic', state_output_hash: HASH, file_count: 0 },
    binding: { run_id: 'run-1' },
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
  };
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
    external_effects: [
      {
        call_kind: 'external',
        target_ref: CONTRACT,
        target_evidence: 'E1',
        value_handling: 'payable',
        basis: [FACT],
      },
    ],
    asset_movements: [],
    post_state_observations: [],
    state_mutation: 'storage',
    fidelity_flags: [],
    unknowns: [],
    basis: [FACT],
    ...overrides,
  };
}

function assetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sema:${SEM}`,
    name: 'Vault Share Token',
    asset_type: 'share',
    represents_asset_id: `sema:${'b'.repeat(16)}`,
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

function populatedModelFixture(): Record<string, unknown> {
  const fixture = envelopeFixture();
  fixture.contracts = [contractFixture()];
  fixture.transitions = [transitionFixture()];
  fixture.assets = [assetFixture()];
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
  return fixture;
}

describe('SemanticModelSchema envelope', () => {
  it('accepts a minimal valid envelope fixture', () => {
    expect(SemanticModelSchema.parse(envelopeFixture())).toEqual(envelopeFixture());
  });

  it('round-trips without coercions or default mutations', () => {
    expect(SemanticModelSchema.parse(envelopeFixture())).toEqual(envelopeFixture());
    expect(SemanticModelSchema.parse(populatedModelFixture())).toEqual(populatedModelFixture());
  });

  it('rejects unknown top-level keys (strictObject)', () => {
    expect(() => SemanticModelSchema.parse({ ...envelopeFixture(), unexpected: 1 })).toThrow();
  });

  it('rejects created_at anywhere in an epistemic record', () => {
    for (const [collection, record] of [
      ['observations', observationFixture({ created_at: '2026-10-07T00:00:00.000Z' })],
      ['assumptions', assumptionFixture({ created_at: '2026-10-07T00:00:00.000Z' })],
      ['hypotheses', hypothesisFixture({ created_at: '2026-10-07T00:00:00.000Z' })],
      ['invariants', invariantFixture({ created_at: '2026-10-07T00:00:00.000Z' })],
    ] as const) {
      const fixture = envelopeFixture();
      fixture.epistemic = {
        observations: collection === 'observations' ? [record] : [],
        assumptions: collection === 'assumptions' ? [record] : [],
        hypotheses: collection === 'hypotheses' ? [record] : [],
        invariants: collection === 'invariants' ? [record] : [],
      };
      expect(() => SemanticModelSchema.parse(fixture), collection).toThrow();
    }
  });

  it('rejects schema_version other than semantic-model/v1', () => {
    expect(() =>
      SemanticModelSchema.parse({ ...envelopeFixture(), schema_version: 'semantic-model/v2' }),
    ).toThrow();
  });

  it('rejects status CONFIRMED and other forbidden statuses', () => {
    for (const status of ['CONFIRMED', 'vulnerable', 'complete']) {
      expect(() => SemanticModelSchema.parse({ ...envelopeFixture(), status }), status).toThrow();
    }
  });

  it("requires failure iff status is FAILED (bidirectional refinement)", () => {
    const failure = { code: 'InvalidSemanticModel', stage: 'intake' };
    expect(() => SemanticModelSchema.parse({ ...envelopeFixture(), status: 'FAILED' })).toThrow();
    expect(() =>
      SemanticModelSchema.parse({ ...envelopeFixture(), failure }),
    ).toThrow();
    expect(() =>
      SemanticModelSchema.parse({ ...envelopeFixture(), status: 'PARTIAL', failure }),
    ).toThrow();
    expect(() =>
      SemanticModelSchema.parse({ ...envelopeFixture(), status: 'FAILED', failure }),
    ).not.toThrow();
    expect(() =>
      SemanticModelSchema.parse({ ...envelopeFixture(), status: 'FAILED', failure: { code: '', stage: 'intake' } }),
    ).toThrow();
  });

  it('rejects input.state_output_hash and semantic_hash that are not 64 lowercase hex', () => {
    expect(() =>
      SemanticModelSchema.parse({
        ...envelopeFixture(),
        input: { fidelity: 'semantic', state_output_hash: 'nope', file_count: 0 },
      }),
    ).toThrow();
    expect(() => SemanticModelSchema.parse({ ...envelopeFixture(), semantic_hash: 'ab' })).toThrow();
  });

  it('requires counts and semantic_hash on the model', () => {
    const { counts: _counts, semantic_hash: _hash, ...draft } = envelopeFixture();
    expect(() => SemanticModelSchema.parse(draft)).toThrow();
  });

  it('pins counts to the exact §5.1 field set (12 fields, no contracts)', () => {
    const model = SemanticModelSchema.parse(envelopeFixture());
    expect(Object.keys(model.counts).sort()).toEqual([
      'accounting',
      'assumptions',
      'authority',
      'claims',
      'custody',
      'hypotheses',
      'invariants',
      'observations',
      'transitions',
      'trust',
      'unknowns',
      'assets',
    ].sort());
    expect(() =>
      SemanticModelSchema.parse({
        ...envelopeFixture(),
        counts: { ...envelopeFixture().counts as object, contracts: 0 },
      }),
    ).toThrow();
  });
});

describe('SemanticDraft', () => {
  it('accepts the envelope shape minus semantic_hash and counts', () => {
    const { counts: _counts, semantic_hash: _hash, ...draft } = envelopeFixture();
    expect(SemanticDraftSchema.parse(draft)).toEqual(draft);
  });

  it('rejects counts or semantic_hash on a draft', () => {
    expect(() => SemanticDraftSchema.parse(envelopeFixture())).toThrow();
    const { semantic_hash: _hash, ...withCounts } = envelopeFixture();
    expect(() => SemanticDraftSchema.parse(withCounts)).toThrow();
  });

  it('enforces the same failure exclusivity as the model', () => {
    const { counts: _counts, semantic_hash: _hash, ...draft } = envelopeFixture();
    expect(() => SemanticDraftSchema.parse({ ...draft, status: 'FAILED' })).toThrow();
    expect(() =>
      SemanticDraftSchema.parse({
        ...draft,
        status: 'FAILED',
        failure: { code: 'InvalidSemanticModel', stage: 'finalize' },
      }),
    ).not.toThrow();
  });

  it('type-level: SemanticDraft omits semantic_hash and counts from SemanticModel', () => {
    const model = SemanticModelSchema.parse(envelopeFixture()) as SemanticModel;
    const draft: SemanticDraft = model;
    // @ts-expect-error counts is not part of SemanticDraft
    void draft.counts;
    // @ts-expect-error semantic_hash is not part of SemanticDraft
    void draft.semantic_hash;
    expect(draft).toEqual(envelopeFixture());
  });
});

describe('SemanticObservationSchema', () => {
  it("rejects id 'obs:abc' and accepts 'semobs:abc123'", () => {
    expect(SemanticObservationSchema.parse(observationFixture())).toMatchObject({
      id: `semobs:${SEM}`,
    });
    expect(() =>
      SemanticObservationSchema.parse(observationFixture({ id: 'obs:abc' })),
    ).toThrow();
    expect(SemanticObservationSchema.parse(observationFixture({ id: 'semobs:abc123' }))).toMatchObject({
      id: 'semobs:abc123',
    });
  });

  it('rejects a created_at key', () => {
    expect(() =>
      SemanticObservationSchema.parse(observationFixture({ created_at: '2026-10-07T00:00:00.000Z' })),
    ).toThrow();
  });

  it('rejects unknown keys on the record', () => {
    expect(() => SemanticObservationSchema.parse(observationFixture({ extra: 1 }))).toThrow();
  });

  it('forces confidence level DERIVED', () => {
    expect(() =>
      SemanticObservationSchema.parse(
        observationFixture({ confidence: { level: 'INFERRED' } }),
      ),
    ).toThrow();
    expect(() =>
      SemanticObservationSchema.parse(observationFixture({ confidence: { level: 'VERIFIED' } })),
    ).toThrow();
    expect(SemanticObservationSchema.parse(observationFixture({ confidence: { level: 'DERIVED', score: 0.5 } }))).toBeTruthy();
  });

  it('cites state fact refs in based_on (not semantic refs)', () => {
    expect(() =>
      SemanticObservationSchema.parse(observationFixture({ based_on: [`semobs:${SEM}`] })),
    ).toThrow();
    expect(() =>
      SemanticObservationSchema.parse(observationFixture({ based_on: ['obs:abc'] })),
    ).toThrow();
  });

  it('requires based_on >= 1 or provenance >= 1 (Phase 1 rule)', () => {
    expect(() => SemanticObservationSchema.parse(observationFixture({ based_on: [] }))).toThrow();
    expect(
      SemanticObservationSchema.parse(
        observationFixture({
          based_on: [],
          provenance: [{ source_type: 'generated', id: 'prov:abc123' }],
        }),
      ),
    ).toBeTruthy();
    expect(() =>
      SemanticObservationSchema.parse(
        observationFixture({ based_on: [], provenance: [] }),
      ),
    ).toThrow();
  });
});

describe('SemanticAssumptionSchema', () => {
  it('accepts semobs refs and rejects obs refs in based_on', () => {
    expect(SemanticAssumptionSchema.parse(assumptionFixture())).toBeTruthy();
    expect(() =>
      SemanticAssumptionSchema.parse(assumptionFixture({ based_on: ['obs:abc'] })),
    ).toThrow();
    expect(() =>
      SemanticAssumptionSchema.parse(assumptionFixture({ based_on: [FACT] })),
    ).toThrow();
    expect(() => SemanticAssumptionSchema.parse(assumptionFixture({ based_on: [] }))).toThrow();
  });

  it("forces confidence { level: 'INFERRED' }", () => {
    expect(
      SemanticAssumptionSchema.parse(assumptionFixture({ confidence: { level: 'INFERRED' } })),
    ).toBeTruthy();
    for (const level of ['DERIVED', 'SPECULATIVE', 'VERIFIED']) {
      expect(() =>
        SemanticAssumptionSchema.parse(assumptionFixture({ confidence: { level } })),
        level,
      ).toThrow();
    }
  });

  it('status is one of OPEN|SUPPORTED|WEAKENED|REJECTED and rejects CONFIRMED', () => {
    for (const status of ['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED']) {
      expect(SemanticAssumptionSchema.parse(assumptionFixture({ status }))).toMatchObject({ status });
    }
    expect(() => SemanticAssumptionSchema.parse(assumptionFixture({ status: 'CONFIRMED' }))).toThrow();
    expect(() => SemanticAssumptionSchema.parse(assumptionFixture({ created_at: '2026-10-07T00:00:00.000Z' }))).toThrow();
  });

  it("rejects id without the 'semasm:' prefix", () => {
    expect(() => SemanticAssumptionSchema.parse(assumptionFixture({ id: 'asm:abc' }))).toThrow();
  });
});

describe('SemanticHypothesisSchema', () => {
  it('accepts semobs/semasm refs and rejects semhyp/obs refs in based_on', () => {
    expect(SemanticHypothesisSchema.parse(hypothesisFixture())).toBeTruthy();
    expect(
      SemanticHypothesisSchema.parse(hypothesisFixture({ based_on: [`semobs:${SEM}`] })),
    ).toBeTruthy();
    for (const ref of [`semhyp:${SEM}`, 'obs:abc', FACT]) {
      expect(() => SemanticHypothesisSchema.parse(hypothesisFixture({ based_on: [ref] })), ref).toThrow();
    }
    expect(() => SemanticHypothesisSchema.parse(hypothesisFixture({ based_on: [] }))).toThrow();
  });

  it('forces confidence level SPECULATIVE and rejects CONFIRMED status', () => {
    expect(
      SemanticHypothesisSchema.parse(hypothesisFixture({ confidence: { level: 'SPECULATIVE' } })),
    ).toBeTruthy();
    expect(() =>
      SemanticHypothesisSchema.parse(hypothesisFixture({ confidence: { level: 'DERIVED' } })),
    ).toThrow();
    expect(() => SemanticHypothesisSchema.parse(hypothesisFixture({ status: 'CONFIRMED' }))).toThrow();
    expect(() => SemanticHypothesisSchema.parse(hypothesisFixture({ created_at: '2026-10-07T00:00:00.000Z' }))).toThrow();
  });

  it("rejects id without the 'semhyp:' prefix", () => {
    expect(() => SemanticHypothesisSchema.parse(hypothesisFixture({ id: 'hyp:abc' }))).toThrow();
  });
});

describe('CandidateInvariantSchema', () => {
  it('accepts semasm/semobs/semhyp refs and rejects asm/obs/fact refs in based_on', () => {
    for (const ref of [`semasm:${SEM}`, `semobs:${SEM}`, `semhyp:${SEM}`]) {
      expect(CandidateInvariantSchema.parse(invariantFixture({ based_on: [ref] }))).toMatchObject({
        based_on: [ref],
      });
    }
    for (const ref of ['asm:abc', 'obs:abc', FACT]) {
      expect(() => CandidateInvariantSchema.parse(invariantFixture({ based_on: [ref] })), ref).toThrow();
    }
    expect(() => CandidateInvariantSchema.parse(invariantFixture({ based_on: [] }))).toThrow();
  });

  it('status is exactly the four lifecycle values; CONFIRMED throws', () => {
    for (const status of ['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED']) {
      expect(CandidateInvariantSchema.parse(invariantFixture({ status }))).toMatchObject({ status });
    }
    for (const status of ['CONFIRMED', 'vulnerable', 'VERIFIED']) {
      expect(() => CandidateInvariantSchema.parse(invariantFixture({ status })), status).toThrow();
    }
  });

  it('validates invariant_class enum', () => {
    for (const invariant_class of ['auth', 'custody', 'accounting', 'isolation', 'external_trust', 'temporal', 'other']) {
      expect(CandidateInvariantSchema.parse(invariantFixture({ invariant_class }))).toBeTruthy();
    }
    expect(() => CandidateInvariantSchema.parse(invariantFixture({ invariant_class: 'security' }))).toThrow();
  });

  it('rejects created_at and unknown keys', () => {
    expect(() =>
      CandidateInvariantSchema.parse(invariantFixture({ created_at: '2026-10-07T00:00:00.000Z' })),
    ).toThrow();
    expect(() => CandidateInvariantSchema.parse(invariantFixture({ confirmed: true }))).toThrow();
  });
});

describe('UnknownIndexEntrySchema', () => {
  it('accepts exactly the six §5.3 reasons', () => {
    for (const reason of [
      'unresolved_call',
      'unsupported_assembly',
      'out_of_scope_target',
      'no_evidence',
      'syntactic_fidelity',
      'dropped_file',
    ]) {
      expect(UnknownIndexEntrySchema.parse(unknownEntryFixture({ reason }))).toMatchObject({ reason });
    }
  });

  it('rejects reasons outside the enum', () => {
    expect(() => UnknownIndexEntrySchema.parse(unknownEntryFixture({ reason: 'inferred' }))).toThrow();
  });

  it('requires basis >= 1 and rejects unknown keys', () => {
    expect(() => UnknownIndexEntrySchema.parse(unknownEntryFixture({ basis: [] }))).toThrow();
    expect(() => UnknownIndexEntrySchema.parse(unknownEntryFixture({ extra: 1 }))).toThrow();
  });
});

describe('StateTransitionSchema (§6)', () => {
  it('accepts a minimal valid transition', () => {
    expect(StateTransitionSchema.parse(transitionFixture())).toBeTruthy();
    expect(
      StateTransitionSchema.parse(
        transitionFixture({ pre_state_reads: [], writes: [], external_effects: [] }),
      ),
    ).toBeTruthy();
  });

  it('validates nested element enums', () => {
    expect(() =>
      StateTransitionSchema.parse(transitionFixture({ writes: [{ state_var_id: STATE_VAR, kind: 'read' }] })),
    ).toThrow();
    expect(() =>
      StateTransitionSchema.parse(
        transitionFixture({
          external_effects: [
            {
              call_kind: 'external',
              target_evidence: 'E2',
              value_handling: 'payable',
              basis: [FACT],
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      StateTransitionSchema.parse(
        transitionFixture({
          asset_movements: [
            { kind: 'stake', direction: 'out', evidence_class: 'E2', basis: [FACT] },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      StateTransitionSchema.parse(transitionFixture({ state_mutation: 'calldata' })),
    ).toThrow();
    expect(() =>
      StateTransitionSchema.parse(transitionFixture({ fidelity_flags: ['obfuscated'] })),
    ).toThrow();
  });

  it('accepts assembly_skipped fidelity flag and unlinked movement', () => {
    expect(
      StateTransitionSchema.parse(
        transitionFixture({
          fidelity_flags: ['syntactic', 'assembly_skipped', 'file_dropped'],
          asset_movements: [
            { kind: 'transfer', direction: 'out', evidence_class: 'E2', basis: [FACT] },
          ],
        }),
      ),
    ).toBeTruthy();
  });

  it('requires basis >= 1 and rejects unknown keys', () => {
    expect(() => StateTransitionSchema.parse(transitionFixture({ basis: [] }))).toThrow();
    expect(() => StateTransitionSchema.parse(transitionFixture({ path: '/abs/x.sol' }))).toThrow();
  });
});

describe('AssetRecordSchema (§5.3)', () => {
  it('accepts a record with required name', () => {
    expect(AssetRecordSchema.parse(assetFixture())).toBeTruthy();
    expect(() => AssetRecordSchema.parse(assetFixture({ name: undefined }))).toThrow();
    expect(() => AssetRecordSchema.parse(assetFixture({ name: '   ' }))).toThrow();
  });

  it('validates asset_type against ASSET_TYPES and evidence_class against E1|E2|E3', () => {
    expect(() => AssetRecordSchema.parse(assetFixture({ asset_type: 'ERC20' }))).toThrow();
    expect(AssetRecordSchema.parse(assetFixture({ asset_type: 'unknown' }))).toBeTruthy();
    expect(() => AssetRecordSchema.parse(assetFixture({ evidence_class: 'E4' }))).toThrow();
    expect(() => AssetRecordSchema.parse(assetFixture({ evidence_class: 'E9' }))).toThrow();
  });

  it('requires represents_asset_id to be an artifact sema: id', () => {
    expect(() => AssetRecordSchema.parse(assetFixture({ represents_asset_id: `asset:${SEM}` }))).toThrow();
    expect(AssetRecordSchema.parse(assetFixture({ represents_asset_id: undefined }))).toBeTruthy();
  });

  it('requires basis >= 1', () => {
    expect(() => AssetRecordSchema.parse(assetFixture({ basis: [] }))).toThrow();
  });
});

describe('CustodyRecordSchema', () => {
  it('accepts contract location and rejects EOA guessing', () => {
    expect(CustodyRecordSchema.parse(custodyFixture())).toMatchObject({ location_kind: 'contract' });
    expect(CustodyRecordSchema.parse(custodyFixture({ location_kind: 'unknown' }))).toBeTruthy();
    expect(() => CustodyRecordSchema.parse(custodyFixture({ location_kind: 'eoa' }))).toThrow();
  });

  it('requires asset_id as sema: ref and basis >= 1', () => {
    expect(() => CustodyRecordSchema.parse(custodyFixture({ asset_id: `asset:${SEM}` }))).toThrow();
    expect(() => CustodyRecordSchema.parse(custodyFixture({ basis: [] }))).toThrow();
  });
});

describe('ClaimRecordSchema', () => {
  it('is pinned to epistemic: observation and rejects fact', () => {
    expect(ClaimRecordSchema.parse(claimFixture())).toMatchObject({ epistemic: 'observation' });
    expect(() => ClaimRecordSchema.parse(claimFixture({ epistemic: 'fact' }))).toThrow();
  });

  it('requires claim_on as sema: ref; via is optional', () => {
    expect(() => ClaimRecordSchema.parse(claimFixture({ claim_on: `asset:${SEM}` }))).toThrow();
    expect(ClaimRecordSchema.parse(claimFixture({ via: undefined }))).toBeTruthy();
  });
});

describe('AccountingRelationSchema (§8)', () => {
  it('accepts a paired-storage assets_shares relation', () => {
    expect(AccountingRelationSchema.parse(accountingFixture())).toBeTruthy();
  });

  it('validates relation_kind, derivation, evidence_class, epistemic', () => {
    expect(() => AccountingRelationSchema.parse(accountingFixture({ relation_kind: 'yield' }))).toThrow();
    expect(() => AccountingRelationSchema.parse(accountingFixture({ derivation: 'co-occurrence' }))).toThrow();
    expect(() => AccountingRelationSchema.parse(accountingFixture({ evidence_class: 'E1' }))).toThrow();
    expect(() => AccountingRelationSchema.parse(accountingFixture({ epistemic: 'fact' }))).toThrow();
    expect(() => AccountingRelationSchema.parse(accountingFixture({ endpoints: [`asset:${SEM}`] }))).toThrow();
    expect(() => AccountingRelationSchema.parse(accountingFixture({ unknowns: undefined }))).toThrow();
  });

  it('accepts interface-structural derivation and the remaining relation kinds', () => {
    for (const relation_kind of [
      'debt_collateral',
      'reserves_liquidity',
      'rewards_eligible_stake',
      'fees_protocol_user',
    ]) {
      expect(AccountingRelationSchema.parse(accountingFixture({ relation_kind }))).toBeTruthy();
    }
    expect(
      AccountingRelationSchema.parse(accountingFixture({ derivation: 'interface-structural' })),
    ).toBeTruthy();
  });
});

describe('AuthorityChainSchema (§9 + ruling)', () => {
  it('accepts the §9 chain shape with additive authority_kind and gate', () => {
    expect(AuthorityChainSchema.parse(authorityFixture())).toBeTruthy();
    expect(
      AuthorityChainSchema.parse(
        authorityFixture({
          links: { actor: CONTRACT, authority: 'unknown', function_id: FUNCTION, impact: 'unknown' },
          authority_kind: 'unknown',
          gate: { modifiers: [], visibility: 'public', mutability: 'nonpayable' },
        }),
      ),
    ).toBeTruthy();
  });

  it('rejects authority_kind outside ROLE_TYPES|unknown', () => {
    expect(() => AuthorityChainSchema.parse(authorityFixture({ authority_kind: 'superadmin' }))).toThrow();
    expect(() => AuthorityChainSchema.parse(authorityFixture({ authority_kind: 'onlyOwner' }))).toThrow();
  });

  it('requires gate and validates its visibility/mutability against E3 values', () => {
    expect(() => {
      const { gate: _gate, ...withoutGate } = authorityFixture();
      return AuthorityChainSchema.parse(withoutGate);
    }).toThrow();
    expect(() =>
      AuthorityChainSchema.parse(
        authorityFixture({ gate: { modifiers: ['onlyOwner'], visibility: 'protected', mutability: 'nonpayable' } }),
      ),
    ).toThrow();
    expect(() =>
      AuthorityChainSchema.parse(
        authorityFixture({ gate: { modifiers: ['onlyOwner'], visibility: 'external', mutability: 'payable' } }),
      ),
    ).not.toThrow();
  });

  it('validates per_link entries (evidence_class, basis, unknown marker)', () => {
    expect(() =>
      AuthorityChainSchema.parse(
        authorityFixture({
          per_link: [{ link_kind: 'actor', evidence_class: 'E4', basis: [FACT] }],
        }),
      ),
    ).toThrow();
    expect(() =>
      AuthorityChainSchema.parse(
        authorityFixture({
          per_link: [{ link_kind: 'actor', evidence_class: 'E2', basis: [] }],
        }),
      ),
    ).toThrow();
    expect(() =>
      AuthorityChainSchema.parse(
        authorityFixture({
          per_link: [{ link_kind: 'actor', evidence_class: 'E2', basis: [FACT], unknown: 'no caller' }],
        }),
      ),
    ).toThrow();
  });

  it('validates status complete|partial only', () => {
    expect(AuthorityChainSchema.parse(authorityFixture({ status: 'partial' }))).toMatchObject({
      status: 'partial',
    });
    expect(() => AuthorityChainSchema.parse(authorityFixture({ status: 'verified' }))).toThrow();
  });
});

describe('ExternalDependencySchema (§10)', () => {
  it('accepts a pinned dependency and rejects out-of-vocabulary types', () => {
    expect(ExternalDependencySchema.parse(dependencyFixture())).toBeTruthy();
    expect(ExternalDependencySchema.parse(dependencyFixture({ dependency_type: 'unknown' }))).toBeTruthy();
    expect(() => ExternalDependencySchema.parse(dependencyFixture({ dependency_type: 'lending' }))).toThrow();
  });

  it('mirrors address/chain_id validation and requires basis', () => {
    expect(() => ExternalDependencySchema.parse(dependencyFixture({ address: 'not-an-address' }))).toThrow();
    expect(ExternalDependencySchema.parse(dependencyFixture({ address: undefined }))).toBeTruthy();
    expect(() => ExternalDependencySchema.parse(dependencyFixture({ basis: [] }))).toThrow();
    expect(() => ExternalDependencySchema.parse(dependencyFixture({ severity: 'high' }))).toThrow();
  });
});

describe('TrustCapabilitySchema (§10)', () => {
  it('accepts an observed capability with its assumption link', () => {
    expect(TrustCapabilitySchema.parse(capabilityFixture())).toBeTruthy();
    expect(TrustCapabilitySchema.parse(capabilityFixture({ direction: 'consumed' }))).toBeTruthy();
    expect(TrustCapabilitySchema.parse(capabilityFixture({ direction: 'unknown' }))).toBeTruthy();
  });

  it('rejects directions outside observed|consumed|unknown', () => {
    expect(() => TrustCapabilitySchema.parse(capabilityFixture({ direction: 'inferred' }))).toThrow();
  });

  it("pins failure_semantics to 'unknown' in v1", () => {
    expect(TrustCapabilitySchema.parse(capabilityFixture())).toMatchObject({
      failure_semantics: 'unknown',
    });
    expect(() => TrustCapabilitySchema.parse(capabilityFixture({ failure_semantics: 'checked' }))).toThrow();
  });

  it('requires dependency_ref (semdep:) and trust_assumption_ref (semasm:)', () => {
    const { dependency_ref: _d, ...noDep } = capabilityFixture();
    expect(() => TrustCapabilitySchema.parse(noDep)).toThrow();
    const { trust_assumption_ref: _t, ...noAssumption } = capabilityFixture();
    expect(() => TrustCapabilitySchema.parse(noAssumption)).toThrow();
    expect(() =>
      TrustCapabilitySchema.parse(capabilityFixture({ trust_assumption_ref: `asm:${SEM}` })),
    ).toThrow();
    expect(() => TrustCapabilitySchema.parse(capabilityFixture({ basis: [] }))).toThrow();
    expect(() => TrustCapabilitySchema.parse(capabilityFixture({ status: 'vulnerable' }))).toThrow();
  });
});

describe('ContractSemanticsSchema (§5.3)', () => {
  it('accepts a contract with semantic_kind and bases_evidence', () => {
    expect(ContractSemanticsSchema.parse(contractFixture())).toBeTruthy();
    expect(ContractSemanticsSchema.parse(contractFixture({ semantic_kind: 'unknown' }))).toBeTruthy();
  });

  it('validates semantic_kind vocabulary and bases_evidence elements', () => {
    expect(() => ContractSemanticsSchema.parse(contractFixture({ semantic_kind: 'router' }))).toThrow();
    expect(() =>
      ContractSemanticsSchema.parse(
        contractFixture({ bases_evidence: [{ base: 'X', evidence_class: 'E9' }] }),
      ),
    ).toThrow();
    expect(() => ContractSemanticsSchema.parse(contractFixture({ basis: [] }))).toThrow();
    expect(() =>
      ContractSemanticsSchema.parse(contractFixture({ notes: [unknownEntryFixture({ reason: 'inferred' })] })),
    ).toThrow();
  });
});

describe('exported enums and ref patterns', () => {
  it('exports the exact enum value sets', () => {
    expect([...EVIDENCE_CLASSES]).toEqual(['E1', 'E2', 'E3']);
    expect([...SEMANTIC_STATUSES]).toEqual(['COMPLETE', 'PARTIAL', 'FAILED']);
    expect([...SEMANTIC_STAGES]).toEqual([
      'intake',
      'transitions',
      'custody',
      'accounting',
      'authority',
      'trust',
      'ladder',
      'finalize',
      'validate',
    ]);
    expect([...INVARIANT_STATUSES]).toEqual(['OPEN', 'SUPPORTED', 'WEAKENED', 'REJECTED']);
    for (const set of [EVIDENCE_CLASSES, SEMANTIC_STATUSES, SEMANTIC_STAGES, INVARIANT_STATUSES]) {
      expect(set.includes('CONFIRMED' as never)).toBe(false);
    }
  });

  it('exports the §5.2-derived ref patterns', () => {
    expect(SEM_OBS_REF.test(`semobs:${SEM}`)).toBe(true);
    expect(SEM_OBS_REF.test(`semasm:${SEM}`)).toBe(false);
    expect(SEM_OBS_REF.test('obs:abc')).toBe(false);
    expect(SEM_ASM_REF.test(`semasm:${SEM}`)).toBe(true);
    expect(SEM_ASM_REF.test('asm:abc')).toBe(false);
    expect(SEM_EPISTEMIC_REF.test(`semobs:${SEM}`)).toBe(true);
    expect(SEM_EPISTEMIC_REF.test(`semasm:${SEM}`)).toBe(true);
    expect(SEM_EPISTEMIC_REF.test(`semhyp:${SEM}`)).toBe(true);
    expect(SEM_EPISTEMIC_REF.test(`seminv:${SEM}`)).toBe(false);
    expect(SEM_EPISTEMIC_REF.test('fact:abc')).toBe(false);
  });
});
