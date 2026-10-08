import { describe, expect, it } from 'vitest';
import { ReconError } from '../../src/errors/errors.js';
import {
  SemanticDraftSchema,
  type SemanticDraft,
  type SemanticModel,
} from '../../src/semantic/model.js';
import {
  computeSemanticHash,
  finalizeSemanticModel,
  serializeSemanticModel,
} from '../../src/semantic/report.js';
import { validateSemanticModel } from '../../src/semantic/validate.js';
import { computeOutputIdentity } from '../../src/traceability/identities.js';
import { stableStringify } from '../../src/util/canonical.js';
import type { ReconState } from '../../src/recon-state/schema.js';

const HEX_A = 'a'.repeat(16);
const HEX_B = 'b'.repeat(16);
const FACT = 'fact:1111111111111111';
const CONTRACT = 'contract:1111111111111111';
const FUNCTION = 'function:1111111111111111';
const STATE_VAR = 'state:1111111111111111';

function minimalState(): ReconState {
  const state = {
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
  return state as unknown as ReconState;
}

function assetFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sema:${suffix}`,
    name: `Token ${suffix}`,
    asset_type: 'erc20',
    evidence_class: 'E2',
    basis: [FACT],
    ...overrides,
  };
}

function transitionFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `semt:${suffix}`,
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

function observationFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'OBSERVATION',
    statement: 'f writes owner slot and is modifier-gated',
    based_on: [FACT],
    provenance: [],
    confidence: { level: 'DERIVED' },
    id: `semobs:${suffix}`,
    ...overrides,
  };
}

function assumptionFixture(suffix: string, basedOn: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ASSUMPTION',
    statement: 'entrypoint f is assumed permissionless',
    based_on: [basedOn],
    confidence: { level: 'INFERRED' },
    status: 'OPEN',
    id: `semasm:${suffix}`,
    ...overrides,
  };
}

function invariantFixture(suffix: string, basedOn: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seminv:${suffix}`,
    statement: 'totalShares never exceeds accounted underlying',
    invariant_class: 'accounting',
    based_on: [basedOn],
    affected_entities: [STATE_VAR],
    status: 'OPEN',
    ...overrides,
  };
}

function draftFixture(overrides: Record<string, unknown> = {}): SemanticDraft {
  const state = minimalState();
  const outputHash = computeOutputIdentity(state).output_hash;
  const base: Record<string, unknown> = {
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
    ...overrides,
  };
  return SemanticDraftSchema.parse(base);
}

function populatedDraft(): SemanticDraft {
  return draftFixture({
    assets: [assetFixture(HEX_B), assetFixture(HEX_A)],
    transitions: [transitionFixture(HEX_B), transitionFixture(HEX_A)],
    epistemic: {
      observations: [observationFixture(HEX_B), observationFixture(HEX_A)],
      assumptions: [assumptionFixture(HEX_A, `semobs:${HEX_A}`)],
      hypotheses: [],
      invariants: [invariantFixture(HEX_A, `semasm:${HEX_A}`)],
    },
    unknowns: [
      { record_ref: `semt:${HEX_B}`, field: 'target_ref', reason: 'unresolved_call', basis: [FACT] },
      { record_ref: `semt:${HEX_A}`, field: 'target_ref', reason: 'unresolved_call', basis: [FACT] },
    ],
  });
}

describe('finalizeSemanticModel — sorting and counts', () => {
  it('sorts unsorted record arrays into code-unit id order', () => {
    const model = finalizeSemanticModel(populatedDraft());
    expect(model.assets.map((a) => a.id)).toEqual([`sema:${HEX_A}`, `sema:${HEX_B}`]);
    expect(model.transitions.map((t) => t.id)).toEqual([`semt:${HEX_A}`, `semt:${HEX_B}`]);
    expect(model.epistemic.observations.map((o) => o.id)).toEqual([
      `semobs:${HEX_A}`,
      `semobs:${HEX_B}`,
    ]);
  });

  it('computes counts equal to array lengths', () => {
    const model = finalizeSemanticModel(populatedDraft());
    expect(model.counts).toEqual({
      transitions: 2,
      assets: 2,
      custody: 0,
      claims: 0,
      accounting: 0,
      authority: 0,
      trust: 0,
      observations: 2,
      assumptions: 1,
      hypotheses: 0,
      invariants: 1,
      unknowns: 2,
    });
  });

  it('accepts empty collections with zero counts', () => {
    const model = finalizeSemanticModel(draftFixture());
    expect(model.counts).toEqual({
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
    });
    expect(model.contracts).toEqual([]);
    expect(model.unknowns).toEqual([]);
  });

  it('rejects duplicate ids instead of finalizing a clean artifact', () => {
    const draft = draftFixture({
      assets: [assetFixture(HEX_A), assetFixture(HEX_A)],
    });
    expect(() => finalizeSemanticModel(draft)).toThrow(ReconError);
    try {
      finalizeSemanticModel(draft);
    } catch (error) {
      expect(error).toBeInstanceOf(ReconError);
      expect((error as ReconError).code).toBe('InvalidSemanticModel');
    }
  });
});

describe('finalizeSemanticModel — required validation first', () => {
  it('throws on schema-invalid input, never returning a clean artifact', () => {
    const draft = draftFixture();
    const invalid = { ...draft, schema_version: 'semantic-model/v2' } as unknown as SemanticDraft;
    let result: SemanticModel | undefined;
    try {
      result = finalizeSemanticModel(invalid);
    } catch (error) {
      expect(error).toBeInstanceOf(ReconError);
      expect((error as ReconError).code).toBe('InvalidSemanticModel');
    }
    expect(result).toBeUndefined();
  });

  it('throws when a record misses its required basis', () => {
    const valid = draftFixture({ assets: [assetFixture(HEX_A)] });
    const raw = JSON.parse(JSON.stringify(valid)) as unknown as {
      assets: Array<{ basis: string[] }>;
    } & SemanticDraft;
    raw.assets[0]!.basis = [];
    expect(() => finalizeSemanticModel(raw as SemanticDraft)).toThrow(ReconError);
  });
});

describe('computeSemanticHash — §13.3 identity (OD-3)', () => {
  it('ignores binding run_id, input_manifest_hash, and scope_hash', () => {
    const base = finalizeSemanticModel(populatedDraft());
    const variant: SemanticModel = {
      ...base,
      binding: { run_id: 'run-other', input_manifest_hash: 'manifest-other', scope_hash: 'scope-other' },
    };
    expect(computeSemanticHash(variant)).toBe(base.semantic_hash);
  });

  it('changes when input.state_output_hash changes', () => {
    const base = finalizeSemanticModel(populatedDraft());
    const variant: SemanticModel = {
      ...base,
      input: { ...base.input, state_output_hash: 'c'.repeat(64) },
    };
    expect(computeSemanticHash(variant)).not.toBe(base.semantic_hash);
  });

  it('changes on semantically relevant content edits', () => {
    const base = finalizeSemanticModel(populatedDraft());
    const variant: SemanticModel = {
      ...base,
      epistemic: {
        ...base.epistemic,
        observations: base.epistemic.observations.map((obs, index) =>
          index === 0 ? { ...obs, statement: 'f reads holder balance with paired access' } : obs,
        ),
      },
    };
    expect(computeSemanticHash(variant)).not.toBe(base.semantic_hash);
  });

  it('matches the semantic_hash attached by finalize', () => {
    const model = finalizeSemanticModel(populatedDraft());
    expect(computeSemanticHash(model)).toBe(model.semantic_hash);
    expect(model.semantic_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('serializeSemanticModel — determinism (§13.4)', () => {
  it('is byte-identical across insertion orders and repeated finalize', () => {
    const first = finalizeSemanticModel(populatedDraft());
    const reversed = draftFixture({
      assets: [assetFixture(HEX_A), assetFixture(HEX_B)],
      transitions: [transitionFixture(HEX_A), transitionFixture(HEX_B)],
      epistemic: {
        observations: [observationFixture(HEX_A), observationFixture(HEX_B)],
        assumptions: [assumptionFixture(HEX_A, `semobs:${HEX_A}`)],
        hypotheses: [],
        invariants: [invariantFixture(HEX_A, `semasm:${HEX_A}`)],
      },
      unknowns: [
        { record_ref: `semt:${HEX_A}`, field: 'target_ref', reason: 'unresolved_call', basis: [FACT] },
        { record_ref: `semt:${HEX_B}`, field: 'target_ref', reason: 'unresolved_call', basis: [FACT] },
      ],
    });
    const second = finalizeSemanticModel(reversed);
    expect(serializeSemanticModel(second)).toBe(serializeSemanticModel(first));
    const { counts: _counts, semantic_hash: _hash, ...asDraft } = JSON.parse(
      serializeSemanticModel(first),
    ) as Record<string, unknown>;
    void _counts;
    void _hash;
    const refinalized = finalizeSemanticModel(SemanticDraftSchema.parse(asDraft));
    expect(serializeSemanticModel(refinalized)).toBe(serializeSemanticModel(first));
  });

  it('emits no timestamp, absolute-path, or backslash leakage', () => {
    const bytes = serializeSemanticModel(finalizeSemanticModel(populatedDraft()));
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(bytes).not.toMatch(/\/(home|root|Users|tmp)\//);
    expect(bytes).not.toContain('\\');
  });

  it('carries no forbidden verdict vocabulary', () => {
    const bytes = serializeSemanticModel(finalizeSemanticModel(populatedDraft())).toLowerCase();
    for (const word of ['vulnerable', 'exploit', 'severity', 'critical', 'finding', 'attack', 'confirmed']) {
      expect(bytes).not.toContain(word);
    }
  });
});

describe('report — integrity and read-only input', () => {
  it('leaves the draft input byte-identical (no silent mutation)', () => {
    const draft = populatedDraft();
    const before = stableStringify(draft);
    finalizeSemanticModel(draft);
    expect(stableStringify(draft)).toBe(before);
    expect(draft.assets.map((a) => a.id)).toEqual([`sema:${HEX_B}`, `sema:${HEX_A}`]);
  });

  it('makes post-hash tampering detectable', () => {
    const model = finalizeSemanticModel(populatedDraft());
    const tampered: SemanticModel = {
      ...model,
      epistemic: {
        ...model.epistemic,
        observations: model.epistemic.observations.map((obs, index) =>
          index === 0 ? { ...obs, statement: 'edited statement' } : obs,
        ),
      },
    };
    expect(computeSemanticHash(tampered)).not.toBe(tampered.semantic_hash);
  });
});

describe('report — provenance preserved exactly', () => {
  it('keeps provenance, based_on order, and unknown entries without stripping', () => {
    const provenanceRecord = {
      id: 'prov:1111111111111111',
      source_type: 'source_code',
      file: 'contracts/Token.sol',
      line_start: 10,
      line_end: 20,
    };
    const draft = draftFixture({
      epistemic: {
        observations: [
          {
            type: 'OBSERVATION',
            statement: 'f writes owner slot and is modifier-gated',
            based_on: [FACT, 'fact:2222222222222222'],
            provenance: [provenanceRecord],
            confidence: { level: 'DERIVED' },
            id: `semobs:${HEX_A}`,
          },
        ],
        assumptions: [],
        hypotheses: [],
        invariants: [],
      },
      unknowns: [
        { record_ref: `semt:${HEX_A}`, field: 'target_ref', reason: 'unresolved_call', basis: [FACT] },
      ],
    });
    const model = finalizeSemanticModel(draft);
    expect(model.epistemic.observations[0]?.based_on).toEqual([FACT, 'fact:2222222222222222']);
    expect(model.epistemic.observations[0]?.provenance).toEqual([provenanceRecord]);
    expect(model.unknowns).toHaveLength(1);
    expect(model.unknowns[0]).toEqual({
      record_ref: `semt:${HEX_A}`,
      field: 'target_ref',
      reason: 'unresolved_call',
      basis: [FACT],
    });
  });

  it('keeps optional fields absent without injecting defaults', () => {
    const model = finalizeSemanticModel(draftFixture());
    expect(model.input.degradation).toBeUndefined();
    expect(model.binding.run_id).toBeUndefined();
    expect(model.binding.input_manifest_hash).toBeUndefined();
    expect(model.binding.scope_hash).toBeUndefined();
    expect('semantic_hash' in model).toBe(true);
  });
});

describe('report — epistemic rules (no upgrades)', () => {
  it('never upgrades confidence levels or invariant status', () => {
    const model = finalizeSemanticModel(populatedDraft());
    for (const obs of model.epistemic.observations) {
      expect(obs.confidence.level).toBe('DERIVED');
    }
    for (const asm of model.epistemic.assumptions) {
      expect(asm.confidence.level).toBe('INFERRED');
      expect(asm.status).toBe('OPEN');
    }
    for (const hyp of model.epistemic.hypotheses) {
      expect(hyp.confidence.level).toBe('SPECULATIVE');
    }
    for (const inv of model.epistemic.invariants) {
      expect(inv.status).toBe('OPEN');
    }
  });

  it('keeps unknown classifications as unknown (no defaulting)', () => {
    const draft = draftFixture({
      assets: [assetFixture(HEX_A, { asset_type: 'unknown' })],
    });
    const model = finalizeSemanticModel(draft);
    expect(model.assets[0]?.asset_type).toBe('unknown');
  });
});

describe('report — SINV regression on finalized artifacts', () => {
  it('a finalized empty artifact passes validateSemanticModel', () => {
    const state = minimalState();
    const draft = draftFixture();
    const model = finalizeSemanticModel(draft);
    expect(() => validateSemanticModel(model, { state })).not.toThrow();
  });

  it('a finalized populated artifact passes validateSemanticModel', () => {
    const state = minimalState();
    const model = finalizeSemanticModel(populatedDraft());
    expect(() => validateSemanticModel(model, { state })).not.toThrow();
  });
});
