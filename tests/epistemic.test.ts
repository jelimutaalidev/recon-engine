import { describe, expect, it } from 'vitest';
import { createProvenance, type ProvenanceInput } from '../src/epistemic/provenance.js';
import { createFact, type FactInput } from '../src/epistemic/fact.js';
import {
  createObservation,
  type ObservationInput,
} from '../src/epistemic/observation.js';
import { createAssumption, type AssumptionInput } from '../src/epistemic/assumption.js';
import { createHypothesis, type HypothesisInput } from '../src/epistemic/hypothesis.js';
import { createEvidence, type EvidenceInput } from '../src/epistemic/evidence.js';
import { isReconError, type ReconErrorCode } from '../src/errors/errors.js';

function expectReconCode(fn: () => unknown, code: ReconErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(isReconError(error)).toBe(true);
    if (isReconError(error)) {
      expect(error.code).toBe(code);
    }
    return;
  }
  throw new Error(`expected ReconError ${code}, but call succeeded`);
}

const SOURCE_PROV: ProvenanceInput = {
  source_type: 'source_code',
  file: 'src/Vault.sol',
  line_start: 40,
  line_end: 52,
};

describe('Provenance', () => {
  it('accepts valid source_code provenance and derives a deterministic id', () => {
    const provenance = createProvenance(SOURCE_PROV);
    expect(provenance.id).toMatch(/^prov:[0-9a-f]{16}$/);
    expect(createProvenance({ ...SOURCE_PROV }).id).toBe(provenance.id);
  });

  it('changes id when the commit changes', () => {
    const a = createProvenance({ ...SOURCE_PROV, commit: 'abc123' });
    const b = createProvenance({ ...SOURCE_PROV, commit: 'def456' });
    expect(a.id).not.toBe(b.id);
  });

  it('rejects line_end before line_start', () => {
    expectReconCode(
      () => createProvenance({ ...SOURCE_PROV, line_start: 52, line_end: 40 }),
      'SchemaValidationFailed',
    );
  });

  it('rejects source_code provenance without file or location', () => {
    expectReconCode(() => createProvenance({ source_type: 'source_code' }), 'InvalidSourceReference');
  });

  it('rejects onchain provenance without chain id', () => {
    expectReconCode(
      () => createProvenance({ source_type: 'onchain', address: '0xaabbccddeeff0011223344556677889900aabbcc' }),
      'InvalidSourceReference',
    );
  });

  it('rejects git_history provenance without commit', () => {
    expectReconCode(
      () => createProvenance({ source_type: 'git_history', repository: 'acme/vault' }),
      'InvalidSourceReference',
    );
  });

  it('requires a description when provenance is explicitly unavailable', () => {
    expectReconCode(
      () => createProvenance({ source_type: 'source_code', unavailable: true }),
      'InvalidSourceReference',
    );
  });

  it('allows explicitly unavailable provenance with a description', () => {
    const provenance = createProvenance({
      source_type: 'generated',
      unavailable: true,
      description: 'compiler did not emit source maps',
    });
    expect(provenance.unavailable).toBe(true);
  });

  it('rejects an unknown source_type', () => {
    expectReconCode(
      () => createProvenance({ source_type: 'vibes' } as unknown as ProvenanceInput),
      'SchemaValidationFailed',
    );
  });
});

describe('Fact', () => {
  const FACT_BASE = {
    subject_id: 'function:contract:Vault:deposit(uint256)',
    predicate: 'WRITES',
    object_id: 'state:contract:Vault:totalShares',
  } as const;

  it('accepts a valid fact with provenance and defaults confidence to VERIFIED', () => {
    const fact = createFact({ ...FACT_BASE, provenance: [SOURCE_PROV] });
    expect(fact.id).toMatch(/^fact:[0-9a-f]{16}$/);
    expect(fact.type).toBe('FACT');
    expect(fact.confidence.level).toBe('VERIFIED');
    expect(fact.provenance).toHaveLength(1);
    expect(fact.provenance[0]?.id).toMatch(/^prov:/);
  });

  it('rejects a fact without provenance', () => {
    expectReconCode(() => createFact({ ...FACT_BASE, provenance: [] }), 'MissingProvenance');
  });

  it('rejects an unsupported predicate', () => {
    expectReconCode(
      () =>
        createFact({
          ...FACT_BASE,
          predicate: 'TELEPORTS',
          provenance: [SOURCE_PROV],
        } as unknown as FactInput),
      'SchemaValidationFailed',
    );
  });

  it('rejects a fact without object_id or value', () => {
    expectReconCode(
      () =>
        createFact({
          subject_id: 'contract:Vault',
          predicate: 'USES',
          provenance: [SOURCE_PROV],
        }),
      'SchemaValidationFailed',
    );
  });

  it('rejects a subject id that is not an entity reference', () => {
    expectReconCode(
      () =>
        createFact({
          ...FACT_BASE,
          subject_id: 'banana',
          provenance: [SOURCE_PROV],
        }),
      'SchemaValidationFailed',
    );
  });

  it('cannot be typed as a hypothesis (epistemic separation)', () => {
    expectReconCode(
      () =>
        createFact({
          ...FACT_BASE,
          type: 'HYPOTHESIS',
          provenance: [SOURCE_PROV],
        } as unknown as FactInput),
      'SchemaValidationFailed',
    );
  });

  it('keeps the same id for identical content regardless of creation time', () => {
    const a = createFact({ ...FACT_BASE, provenance: [SOURCE_PROV] });
    const b = createFact({
      ...FACT_BASE,
      provenance: [SOURCE_PROV],
      created_at: '2020-01-01T00:00:00.000Z',
    });
    expect(a.id).toBe(b.id);
  });
});

describe('Observation', () => {
  it('accepts an observation based on facts', () => {
    const observation = createObservation({
      statement: 'Share issuance depends on vault accounting state.',
      based_on: ['fact:aaaaaaaaaaaaaaaa', 'fact:bbbbbbbbbbbbbbbb'],
      provenance: [SOURCE_PROV],
    });
    expect(observation.id).toMatch(/^obs:[0-9a-f]{16}$/);
    expect(observation.type).toBe('OBSERVATION');
    expect(observation.confidence.level).toBe('DERIVED');
  });

  it('accepts an observation with no facts but explicit source provenance', () => {
    const observation = createObservation({
      statement: 'Deployment predates the audit report.',
      provenance: [
        { source_type: 'documentation', description: 'audit published after deploy' },
      ],
    });
    expect(observation.based_on).toEqual([]);
  });

  it('rejects an observation with neither facts nor provenance', () => {
    expectReconCode(
      () => createObservation({ statement: 'Something seems off.' }),
      'InvalidEpistemicDependency',
    );
  });

  it('rejects based_on entries that are not facts', () => {
    expectReconCode(
      () =>
        createObservation({
          statement: 'Bad reference.',
          based_on: ['asm:aaaaaaaaaaaaaaaa'],
        }),
      'SchemaValidationFailed',
    );
  });

  it('cannot be typed as a fact', () => {
    expectReconCode(
      () =>
        createObservation({
          type: 'FACT',
          statement: 'nope',
          based_on: ['fact:aaaaaaaaaaaaaaaa'],
        } as unknown as ObservationInput),
      'SchemaValidationFailed',
    );
  });

  it('rejects an incorrect confidence level', () => {
    expectReconCode(
      () =>
        createObservation({
          statement: 'x',
          based_on: ['fact:aaaaaaaaaaaaaaaa'],
          confidence: { level: 'SPECULATIVE' },
        }),
      'InvalidConfidence',
    );
  });
});

describe('Assumption', () => {
  it('accepts an assumption based on observations', () => {
    const assumption = createAssumption({
      statement:
        'The vault assumes changes in underlying token balance are compatible with its share-accounting model.',
      based_on: ['obs:aaaaaaaaaaaaaaaa'],
    });
    expect(assumption.type).toBe('ASSUMPTION');
    expect(assumption.status).toBe('OPEN');
    expect(assumption.confidence.level).toBe('INFERRED');
  });

  it('rejects an assumption with no observations', () => {
    expectReconCode(
      () => createAssumption({ statement: 'Assumed without basis.' }),
      'InvalidEpistemicDependency',
    );
  });

  it('rejects an assumption based on facts instead of observations', () => {
    expectReconCode(
      () =>
        createAssumption({
          statement: 'Wrong level.',
          based_on: ['fact:aaaaaaaaaaaaaaaa'],
        }),
      'SchemaValidationFailed',
    );
  });

  it('rejects an unknown status', () => {
    expectReconCode(
      () =>
        createAssumption({
          statement: 'x',
          based_on: ['obs:aaaaaaaaaaaaaaaa'],
          status: 'PROVEN',
        } as unknown as AssumptionInput),
      'SchemaValidationFailed',
    );
  });
});

describe('Hypothesis', () => {
  it('accepts a hypothesis based on an assumption', () => {
    const hypothesis = createHypothesis({
      statement: 'Unexpected changes to the underlying token balance may affect share pricing.',
      based_on: ['asm:aaaaaaaaaaaaaaaa'],
      affected_entities: ['contract:Vault', 'asset:ethereum:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      required_conditions: ['underlying balance changes without a corresponding share mint'],
    });
    expect(hypothesis.type).toBe('HYPOTHESIS');
    expect(hypothesis.status).toBe('OPEN');
    expect(hypothesis.confidence.level).toBe('SPECULATIVE');
  });

  it('accepts a hypothesis based directly on an observation', () => {
    const hypothesis = createHypothesis({
      statement: 'Maybe reentrancy matters here.',
      based_on: ['obs:aaaaaaaaaaaaaaaa'],
    });
    expect(hypothesis.id).toMatch(/^hyp:/);
  });

  it('rejects a hypothesis with no basis', () => {
    expectReconCode(
      () => createHypothesis({ statement: 'Gut feeling.' }),
      'InvalidEpistemicDependency',
    );
  });

  it('rejects a hypothesis based on a fact (missing intermediate reasoning)', () => {
    expectReconCode(
      () =>
        createHypothesis({
          statement: 'Short circuit.',
          based_on: ['fact:aaaaaaaaaaaaaaaa'],
        }),
      'SchemaValidationFailed',
    );
  });

  it('cannot be persisted with a confirmed-vulnerability status', () => {
    expectReconCode(
      () =>
        createHypothesis({
          statement: 'Vault is vulnerable.',
          based_on: ['asm:aaaaaaaaaaaaaaaa'],
          status: 'CONFIRMED',
        } as unknown as HypothesisInput),
      'SchemaValidationFailed',
    );
  });

  it('does not let a VERIFIED confidence level masquerade as certainty', () => {
    expectReconCode(
      () =>
        createHypothesis({
          statement: 'x',
          based_on: ['asm:aaaaaaaaaaaaaaaa'],
          confidence: { level: 'VERIFIED', score: 0.99 },
        }),
      'InvalidConfidence',
    );
  });

  it('accepts a numeric confidence score within range', () => {
    const hypothesis = createHypothesis({
      statement: 'x',
      based_on: ['asm:aaaaaaaaaaaaaaaa'],
      confidence: { level: 'SPECULATIVE', score: 0.4 },
    });
    expect(hypothesis.confidence.score).toBe(0.4);
  });

  it('rejects a confidence score outside 0..1', () => {
    expectReconCode(
      () =>
        createHypothesis({
          statement: 'x',
          based_on: ['asm:aaaaaaaaaaaaaaaa'],
          confidence: { level: 'SPECULATIVE', score: 1.5 },
        }),
      'SchemaValidationFailed',
    );
  });
});

describe('Evidence', () => {
  it('accepts evidence that supports a hypothesis', () => {
    const evidence = createEvidence({
      evidence_type: 'source',
      description: 'Vault.sol reads balanceOf before minting shares',
      supports: ['hyp:aaaaaaaaaaaaaaaa'],
      provenance: [SOURCE_PROV],
    });
    expect(evidence.id).toMatch(/^evidence:[0-9a-f]{16}$/);
    expect(evidence.supports).toEqual(['hyp:aaaaaaaaaaaaaaaa']);
    expect(evidence.contradicts).toEqual([]);
  });

  it('accepts evidence that contradicts an observation', () => {
    const evidence = createEvidence({
      evidence_type: 'historical',
      description: 'prior incident report',
      contradicts: ['obs:aaaaaaaaaaaaaaaa'],
      provenance: [{ source_type: 'audit', description: 'audit section 4' }],
    });
    expect(evidence.contradicts).toHaveLength(1);
  });

  it('rejects evidence supporting and contradicting the same target', () => {
    expectReconCode(
      () =>
        createEvidence({
          evidence_type: 'static',
          description: 'conflicted',
          supports: ['hyp:aaaaaaaaaaaaaaaa'],
          contradicts: ['hyp:aaaaaaaaaaaaaaaa'],
          provenance: [SOURCE_PROV],
        }),
      'ConflictingEvidence',
    );
  });

  it('rejects evidence with no links at all', () => {
    expectReconCode(
      () =>
        createEvidence({
          evidence_type: 'static',
          description: 'orphan',
          provenance: [SOURCE_PROV],
        }),
      'InvalidEvidenceReference',
    );
  });

  it('rejects evidence without provenance', () => {
    expectReconCode(
      () =>
        createEvidence({
          evidence_type: 'static',
          description: 'hearsay',
          supports: ['hyp:aaaaaaaaaaaaaaaa'],
          provenance: [],
        }),
      'MissingProvenance',
    );
  });

  it('rejects links to non-epistemic ids', () => {
    expectReconCode(
      () =>
        createEvidence({
          evidence_type: 'static',
          description: 'bad link',
          supports: ['contract:Vault'],
          provenance: [SOURCE_PROV],
        }),
      'InvalidEvidenceReference',
    );
  });

  it('rejects an unknown evidence_type', () => {
    expectReconCode(
      () =>
        createEvidence({
          evidence_type: 'vibes',
          description: 'x',
          supports: ['hyp:aaaaaaaaaaaaaaaa'],
          provenance: [SOURCE_PROV],
        } as unknown as EvidenceInput),
      'SchemaValidationFailed',
    );
  });
});
