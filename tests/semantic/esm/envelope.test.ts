import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../../src/util/canonical.js';
import { makeEsmUnknown } from '../../../src/semantic/esm/unknown.js';
import { INFLUENCE_DECLARATION } from '../../../src/semantic/esm/influence.js';
import { PATH_HEADER } from '../../../src/semantic/esm/path.js';
import {
  EsmArtifactSchema,
  EsmDraftSchema,
  computeEsmHash,
  finalizeEsm,
  serializeEsm,
  type EsmArtifact,
  type EsmDraft,
} from '../../../src/semantic/esm/envelope.js';

const HASH_A = 'a'.repeat(64);
const HASH_C = 'c'.repeat(64);

function influenceFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:influence-${suffix}`,
    kind: 'data-supported',
    from: `state-version:state:Vault:var@${'function:Vault:writer'}`,
    to: `state-version:state:Vault:var@${'function:Vault:reader'}`,
    evidence: ['rel:aaa'],
    eclass: 'E2',
    declaration: INFLUENCE_DECLARATION,
    basis: ['rel:aaa'],
    ...overrides,
  };
}

function conditionFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:condition-${suffix}`,
    kind: 'modifier-gate',
    function: 'function:Vault:fn',
    descriptor: `gate-${suffix}`,
    basis: ['function:Vault:fn'],
    ...overrides,
  };
}

function pathFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:path-${suffix}`,
    steps: [
      { node: 'function:Vault:a', via: 'rel:aaa', condition: `seme:condition-${suffix}` },
      { node: 'function:Vault:b', via: 'rel:aaa', condition: 'unknown' },
    ],
    basis: ['rel:aaa'],
    header: PATH_HEADER,
    ...overrides,
  };
}

function contextFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:context-${suffix}`,
    entry: 'function:Vault:a',
    chain: ['function:Vault:a'],
    callKinds: [],
    basis: ['function:Vault:a'],
    gates: [],
    unknown: {
      actor: 'unknown',
      origin: 'unknown',
      value: 'unknown',
      block: 'unknown',
      order: 'unknown',
    },
    ...overrides,
  };
}

function accessFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:access-${suffix}`,
    location: 'state:Vault:var',
    op: 'read',
    span: { file: 'src/Vault.sol', line_start: 10, line_end: 10 },
    subPath: 'unknown',
    scope: 'contract:Vault:1',
    basis: ['rel:aaa', 'state:Vault:var'],
    ...overrides,
  };
}

function boundaryFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:boundary-${suffix}`,
    site: `rel:site-${suffix}`,
    kind: 'external',
    target: 'function:Vault:b',
    returnLink: 'unknown',
    result: 'unknown',
    basis: [`rel:site-${suffix}`],
    ...overrides,
  };
}

function temporalFixture(suffix: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `seme:temporal-${suffix}`,
    kind: 'UNKNOWN-kind',
    consumers: [],
    basis: [`unsupported_builtin@Vault.sol:10-10:builtins are not modeled (${suffix})`],
    ...overrides,
  };
}

function draftFixture(overrides: Record<string, unknown> = {}): EsmDraft {
  const base: Record<string, unknown> = {
    schema_version: 'esem-model/v1',
    inputs: { state_output_hash: HASH_A, fidelity: 'semantic', file_count: 1 },
    influences: [],
    conditions: [],
    paths: [],
    contexts: [],
    accesses: [],
    boundaries: [],
    temporals: [],
    unknowns: [],
    ...overrides,
  };
  return EsmDraftSchema.parse(base);
}

function populatedDraft(): EsmDraft {
  const unknownB = makeEsmUnknown('scope-bbb', 'no_evidence', ['rel:bbb']);
  const unknownA = makeEsmUnknown('scope-aaa', 'no_evidence', ['rel:aaa']);
  return draftFixture({
    influences: [influenceFixture('bbb'), influenceFixture('aaa')],
    conditions: [conditionFixture('bbb'), conditionFixture('aaa')],
    paths: [pathFixture('bbb'), pathFixture('aaa')],
    contexts: [contextFixture('bbb'), contextFixture('aaa')],
    accesses: [accessFixture('bbb'), accessFixture('aaa')],
    boundaries: [boundaryFixture('bbb'), boundaryFixture('aaa')],
    temporals: [temporalFixture('bbb'), temporalFixture('aaa')],
    unknowns: [unknownB, unknownA],
  });
}

describe('finalizeEsm — sorting and counts', () => {
  it('sorts reversed-insertion input into code-unit id order', () => {
    const model = finalizeEsm(populatedDraft());
    expect(model.influences.map((r) => r.id)).toEqual([
      'seme:influence-aaa',
      'seme:influence-bbb',
    ]);
    expect(model.conditions.map((r) => r.id)).toEqual([
      'seme:condition-aaa',
      'seme:condition-bbb',
    ]);
    expect(model.paths.map((r) => r.id)).toEqual(['seme:path-aaa', 'seme:path-bbb']);
    expect(model.contexts.map((r) => r.id)).toEqual([
      'seme:context-aaa',
      'seme:context-bbb',
    ]);
    expect(model.accesses.map((r) => r.id)).toEqual(['seme:access-aaa', 'seme:access-bbb']);
    expect(model.boundaries.map((r) => r.id)).toEqual([
      'seme:boundary-aaa',
      'seme:boundary-bbb',
    ]);
    expect(model.temporals.map((r) => r.id)).toEqual([
      'seme:temporal-aaa',
      'seme:temporal-bbb',
    ]);
    const unknownIds = model.unknowns.map((r) => r.id);
    expect([...unknownIds].sort()).toEqual(unknownIds);
  });

  it('computes counts equal to array lengths', () => {
    const model = finalizeEsm(populatedDraft());
    expect(model.counts).toEqual({
      influences: 2,
      conditions: 2,
      paths: 2,
      contexts: 2,
      accesses: 2,
      boundaries: 2,
      temporals: 2,
      unknowns: 2,
    });
  });

  it('accepts empty collections with zero counts', () => {
    const model = finalizeEsm(draftFixture());
    expect(model.counts).toEqual({
      influences: 0,
      conditions: 0,
      paths: 0,
      contexts: 0,
      accesses: 0,
      boundaries: 0,
      temporals: 0,
      unknowns: 0,
    });
    expect(model.influences).toEqual([]);
    expect(model.unknowns).toEqual([]);
  });

  it('rejects duplicate ids globally instead of finalizing', () => {
    const draft = draftFixture({
      influences: [influenceFixture('dup'), influenceFixture('dup')],
    });
    expect(() => finalizeEsm(draft)).toThrow();
  });
});

describe('computeEsmHash — OD-3 mirror', () => {
  it('scope_hash-only difference yields an EQUAL hash', () => {
    const base = finalizeEsm(populatedDraft());
    const variant: EsmArtifact = {
      ...base,
      inputs: { ...base.inputs, scope_hash: 'scope-other' },
    };
    expect(computeEsmHash(variant)).toBe(base.esem_hash);
  });

  it('state_output_hash difference yields a different hash', () => {
    const base = finalizeEsm(populatedDraft());
    const variant: EsmArtifact = {
      ...base,
      inputs: { ...base.inputs, state_output_hash: HASH_C },
    };
    expect(computeEsmHash(variant)).not.toBe(base.esem_hash);
  });

  it('fidelity and file_count are content: variance yields a different hash', () => {
    const base = finalizeEsm(populatedDraft());
    const fidelityVariant: EsmArtifact = {
      ...base,
      inputs: { ...base.inputs, fidelity: 'syntactic' },
    };
    expect(computeEsmHash(fidelityVariant)).not.toBe(base.esem_hash);
    const countVariant: EsmArtifact = {
      ...base,
      inputs: { ...base.inputs, file_count: 2 },
    };
    expect(computeEsmHash(countVariant)).not.toBe(base.esem_hash);
  });

  it('matches the esem_hash attached by finalize and is 64 lowercase hex', () => {
    const model = finalizeEsm(populatedDraft());
    expect(computeEsmHash(model)).toBe(model.esem_hash);
    expect(model.esem_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('serializeEsm — determinism', () => {
  it('is byte-identical across insertion orders and repeated finalize', () => {
    const first = finalizeEsm(populatedDraft());
    const unknownB = makeEsmUnknown('scope-bbb', 'no_evidence', ['rel:bbb']);
    const unknownA = makeEsmUnknown('scope-aaa', 'no_evidence', ['rel:aaa']);
    const reversed = draftFixture({
      influences: [influenceFixture('aaa'), influenceFixture('bbb')],
      conditions: [conditionFixture('aaa'), conditionFixture('bbb')],
      paths: [pathFixture('aaa'), pathFixture('bbb')],
      contexts: [contextFixture('aaa'), contextFixture('bbb')],
      accesses: [accessFixture('aaa'), accessFixture('bbb')],
      boundaries: [boundaryFixture('aaa'), boundaryFixture('bbb')],
      temporals: [temporalFixture('aaa'), temporalFixture('bbb')],
      unknowns: [unknownA, unknownB],
    });
    const second = finalizeEsm(reversed);
    expect(serializeEsm(second)).toBe(serializeEsm(first));
    const reparsed = EsmArtifactSchema.parse(JSON.parse(serializeEsm(first)) as unknown);
    expect(serializeEsm(reparsed)).toBe(serializeEsm(first));
  });

  it('strip-and-refinalize is byte-identical', () => {
    const first = finalizeEsm(populatedDraft());
    const raw = JSON.parse(serializeEsm(first)) as Record<string, unknown>;
    const { counts: _counts, esem_hash: _hash, ...asDraft } = raw;
    void _counts;
    void _hash;
    const refinalized = finalizeEsm(EsmDraftSchema.parse(asDraft));
    expect(serializeEsm(refinalized)).toBe(serializeEsm(first));
  });

  it('emits no timestamp, absolute-path, or backslash leakage', () => {
    const bytes = serializeEsm(finalizeEsm(populatedDraft()));
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(bytes).not.toMatch(/\/(home|root|Users|tmp)\//);
    expect(bytes).not.toContain('\\');
  });
});

describe('envelope — integrity and read-only input', () => {
  it('leaves the draft input byte-identical (no silent mutation)', () => {
    const draft = populatedDraft();
    const before = stableStringify(draft);
    finalizeEsm(draft);
    expect(stableStringify(draft)).toBe(before);
    expect(draft.influences.map((r) => r.id)).toEqual([
      'seme:influence-bbb',
      'seme:influence-aaa',
    ]);
  });

  it('makes post-hash tampering detectable on recompute', () => {
    const model = finalizeEsm(populatedDraft());
    const tampered: EsmArtifact = {
      ...model,
      conditions: model.conditions.map((record, index) =>
        index === 0 ? { ...record, descriptor: 'edited-descriptor' } : record,
      ),
    };
    expect(computeEsmHash(tampered)).not.toBe(tampered.esem_hash);
  });

  it('preserves nested ref-list order while sorting id-bearing arrays', () => {
    const draft = draftFixture({
      influences: [
        influenceFixture('nested', {
          id: 'seme:influence-nested',
          evidence: ['rel:zzz', 'rel:aaa'],
          basis: ['rel:zzz', 'rel:aaa'],
        }),
      ],
      paths: [
        pathFixture('nested', {
          id: 'seme:path-nested',
          steps: [
            { node: 'function:Vault:zzz', via: 'rel:zzz', condition: 'unknown' },
            { node: 'function:Vault:aaa', via: 'rel:aaa', condition: 'unknown' },
          ],
          basis: ['rel:zzz', 'rel:aaa'],
        }),
      ],
    });
    const model = finalizeEsm(draft);
    expect(model.influences[0]?.evidence).toEqual(['rel:zzz', 'rel:aaa']);
    expect(model.influences[0]?.basis).toEqual(['rel:zzz', 'rel:aaa']);
    expect(model.paths[0]?.steps.map((s) => s.node)).toEqual([
      'function:Vault:zzz',
      'function:Vault:aaa',
    ]);
    expect(model.paths[0]?.basis).toEqual(['rel:zzz', 'rel:aaa']);
  });

  it('carries no status field and rejects status-bearing input', () => {
    const model = finalizeEsm(populatedDraft());
    expect('status' in model).toBe(false);
    expect('status' in populatedDraft()).toBe(false);
    expect(EsmDraftSchema.safeParse({ ...populatedDraft(), status: 'COMPLETE' }).success).toBe(
      false,
    );
    expect(
      EsmArtifactSchema.safeParse({ ...model, status: 'COMPLETE' } as unknown).success,
    ).toBe(false);
  });
});

describe('finalizeEsm — invalid input rejected, never filled', () => {
  it('throws on schema-invalid input without returning an artifact', () => {
    const draft = draftFixture();
    const invalid = { ...draft, schema_version: 'esem-model/v2' } as unknown as EsmDraft;
    let result: EsmArtifact | undefined;
    try {
      result = finalizeEsm(invalid);
    } catch {
      result = undefined;
    }
    expect(result).toBeUndefined();
  });

  it('throws when a record misses its required basis and when envelope keys leak in', () => {
    const valid = draftFixture({ accesses: [accessFixture('aaa')] });
    const raw = JSON.parse(JSON.stringify(valid)) as {
      accesses: Array<{ basis: string[] }>;
    } & Record<string, unknown>;
    (raw.accesses[0] as { basis: string[] }).basis = [];
    expect(() => finalizeEsm(raw as unknown as EsmDraft)).toThrow();
    expect(() =>
      finalizeEsm({ ...valid, counts: {}, esem_hash: HASH_A } as unknown as EsmDraft),
    ).toThrow();
    expect(() => finalizeEsm({ ...valid, extra: 'field' } as unknown as EsmDraft)).toThrow();
  });

  it('keeps optional fields absent without injecting defaults', () => {
    const model = finalizeEsm(draftFixture());
    expect(model.inputs.scope_hash).toBeUndefined();
    expect('esem_hash' in model).toBe(true);
    expect('counts' in model).toBe(true);
  });
});
