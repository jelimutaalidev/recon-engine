import { describe, expect, it } from 'vitest';
import {
  createReconState,
  deserializeReconState,
  serializeReconState,
} from '../src/recon-state/state.js';
import { isReconError, type ReconErrorCode } from '../src/errors/errors.js';
import { buildVaultState } from '../fixtures/vault.js';
import type { ReconStateInput } from '../src/recon-state/schema.js';

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

function payload(): ReconStateInput {
  return structuredClone(buildVaultState());
}

describe('agent output gate', () => {
  it('accepts a well-formed agent payload and round-trips through serialization', () => {
    const state = createReconState(payload());
    const restored = deserializeReconState(serializeReconState(state));
    expect(restored).toEqual(state);
  });

  it('rejects unknown top-level fields in agent output', () => {
    const input = { ...payload(), hallucinated_field: true } as ReconStateInput;
    expectReconCode(() => createReconState(input), 'SchemaValidationFailed');
  });

  it('rejects an unsupported schema version', () => {
    const input = payload();
    input.schema_version = 'recon-state/v2';
    expectReconCode(() => createReconState(input), 'UnsupportedSchemaVersion');
  });

  it('rejects a hypothesis the agent marked as confirmed', () => {
    const input = payload();
    const hypothesis = input.hypotheses?.[0];
    expect(hypothesis).toBeDefined();
    if (hypothesis !== undefined) {
      (hypothesis as { status: string }).status = 'CONFIRMED';
    }
    expectReconCode(() => createReconState(input), 'SchemaValidationFailed');
  });

  it('rejects an unsupported relationship type', () => {
    const input = payload();
    const relationship = input.relationships?.[0];
    expect(relationship).toBeDefined();
    if (relationship !== undefined) {
      (relationship as { type: string }).type = 'EXPLOITS';
    }
    expectReconCode(() => createReconState(input), 'UnsupportedRelationshipType');
  });

  it('rejects an entity id that does not match its identity fields', () => {
    const input = payload();
    const contract = input.contracts?.[0];
    expect(contract).toBeDefined();
    if (contract !== undefined) {
      contract.id = 'contract:ethereum:0xdddddddddddddddddddddddddddddddddddddddd';
    }
    expectReconCode(() => createReconState(input), 'InvalidReconState');
  });

  it('rejects a raw fact with empty provenance', () => {
    const input = payload();
    const fact = input.facts?.[0];
    expect(fact).toBeDefined();
    if (fact !== undefined) {
      fact.provenance = [];
    }
    expectReconCode(() => createReconState(input), 'MissingProvenance');
  });

  it('rejects a raw observation with neither facts nor provenance', () => {
    const input = payload();
    const observation = input.observations?.[0];
    expect(observation).toBeDefined();
    if (observation !== undefined) {
      observation.based_on = [];
      observation.provenance = [];
    }
    expectReconCode(() => createReconState(input), 'InvalidEpistemicDependency');
  });

  it('rejects a raw assumption with no observation basis', () => {
    const input = payload();
    const assumption = input.assumptions?.[0];
    expect(assumption).toBeDefined();
    if (assumption !== undefined) {
      assumption.based_on = [];
    }
    expectReconCode(() => createReconState(input), 'InvalidEpistemicDependency');
  });

  it('rejects a raw hypothesis with no basis', () => {
    const input = payload();
    const hypothesis = input.hypotheses?.[0];
    expect(hypothesis).toBeDefined();
    if (hypothesis !== undefined) {
      hypothesis.based_on = [];
    }
    expectReconCode(() => createReconState(input), 'InvalidEpistemicDependency');
  });

  it('rejects raw evidence with no supports or contradicts', () => {
    const input = payload();
    const evidence = input.evidence?.[0];
    expect(evidence).toBeDefined();
    if (evidence !== undefined) {
      evidence.supports = [];
      evidence.contradicts = [];
    }
    expectReconCode(() => createReconState(input), 'InvalidEvidenceReference');
  });

  it('rejects raw evidence with empty provenance', () => {
    const input = payload();
    const evidence = input.evidence?.[0];
    expect(evidence).toBeDefined();
    if (evidence !== undefined) {
      evidence.provenance = [];
    }
    expectReconCode(() => createReconState(input), 'MissingProvenance');
  });
});
