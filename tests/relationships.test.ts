import { describe, expect, it } from 'vitest';
import {
  createRelationship,
  type Relationship,
  type RelationshipInput,
} from '../src/relationships/relationship.js';
import { buildGraphIndex } from '../src/relationships/graph.js';
import { createProvenance, type ProvenanceInput } from '../src/epistemic/provenance.js';
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

describe('Relationship', () => {
  const REL_BASE = {
    type: 'CALLS',
    source_id: 'function:contract:Vault:deposit(uint256)',
    target_id: 'function:contract:ERC20:transfer(address,uint256)',
  } as const;

  it('accepts a valid relationship with provenance', () => {
    const relationship = createRelationship({ ...REL_BASE, provenance: [SOURCE_PROV] });
    expect(relationship.id).toMatch(/^rel:[0-9a-f]{16}$/);
    expect(relationship.type).toBe('CALLS');
    expect(relationship.source_id).toBe(REL_BASE.source_id);
    expect(relationship.target_id).toBe(REL_BASE.target_id);
    expect(relationship.provenance).toHaveLength(1);
    expect(relationship.provenance[0]?.id).toMatch(/^prov:/);
  });

  it('rejects an unsupported relationship type', () => {
    expectReconCode(
      () =>
        createRelationship({
          ...REL_BASE,
          type: 'TELEPORTS',
          provenance: [SOURCE_PROV],
        } as unknown as RelationshipInput),
      'UnsupportedRelationshipType',
    );
  });

  it('rejects a source that is not an entity reference', () => {
    expectReconCode(
      () =>
        createRelationship({
          ...REL_BASE,
          source_id: 'banana',
          provenance: [SOURCE_PROV],
        }),
      'InvalidRelationshipSource',
    );
  });

  it('rejects a target that is not an entity reference', () => {
    expectReconCode(
      () =>
        createRelationship({
          ...REL_BASE,
          target_id: 'fact:something',
          provenance: [SOURCE_PROV],
        }),
      'InvalidRelationshipTarget',
    );
  });

  it('rejects a relationship without provenance', () => {
    expectReconCode(() => createRelationship({ ...REL_BASE, provenance: [] }), 'MissingProvenance');
  });

  it('rejects embedded provenance that fails source rules', () => {
    expectReconCode(
      () =>
        createRelationship({
          ...REL_BASE,
          provenance: [{ source_type: 'source_code' }],
        }),
      'InvalidSourceReference',
    );
  });

  it('rejects non-primitive metadata values', () => {
    expectReconCode(
      () =>
        createRelationship({
          ...REL_BASE,
          metadata: { note: { nested: true } },
          provenance: [SOURCE_PROV],
        } as unknown as RelationshipInput),
      'SchemaValidationFailed',
    );
  });

  it('keeps the same id for identical content regardless of creation time', () => {
    const a = createRelationship({ ...REL_BASE, provenance: [SOURCE_PROV] });
    const b = createRelationship({
      ...REL_BASE,
      provenance: [SOURCE_PROV],
      created_at: '2020-01-01T00:00:00.000Z',
    });
    expect(a.id).toBe(b.id);
  });
});

describe('GraphIndex', () => {
  const DEPOSIT = 'function:contract:Vault:deposit(uint256)';
  const WITHDRAW = 'function:contract:Vault:withdraw(uint256)';
  const TRANSFER = 'function:contract:ERC20:transfer(address,uint256)';
  const TOTAL_SHARES = 'state:contract:Vault:totalShares';
  const VAULT = 'contract:chain:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const OZ = 'dependency:openzeppelin';

  const relationships: Relationship[] = [
    createRelationship({
      type: 'CALLS',
      source_id: DEPOSIT,
      target_id: TRANSFER,
      provenance: [SOURCE_PROV],
    }),
    createRelationship({
      type: 'WRITES',
      source_id: DEPOSIT,
      target_id: TOTAL_SHARES,
      provenance: [SOURCE_PROV],
    }),
    createRelationship({
      type: 'CALLS',
      source_id: WITHDRAW,
      target_id: DEPOSIT,
      provenance: [SOURCE_PROV],
    }),
    createRelationship({
      type: 'DEPENDS_ON',
      source_id: VAULT,
      target_id: OZ,
      provenance: [SOURCE_PROV],
    }),
  ];

  const index = buildGraphIndex(relationships);

  it('returns outgoing relationships sorted by id', () => {
    const outgoing = index.getRelationshipsFrom(DEPOSIT);
    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((rel) => rel.type).sort()).toEqual(['CALLS', 'WRITES']);
    const ids = outgoing.map((rel) => rel.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('returns incoming relationships', () => {
    const incoming = index.getRelationshipsTo(DEPOSIT);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.source_id).toBe(WITHDRAW);
  });

  it('filters relationships by type', () => {
    const calls = index.findRelationshipsByType('CALLS');
    expect(calls).toHaveLength(2);
    expect(calls.every((rel) => rel.type === 'CALLS')).toBe(true);
  });

  it('returns direct neighbours at depth 1', () => {
    expect(index.getRelatedEntities(DEPOSIT, 1)).toEqual([TOTAL_SHARES, TRANSFER, WITHDRAW].sort());
  });

  it('expands to second-degree neighbours at depth 2', () => {
    expect(index.getRelatedEntities(WITHDRAW, 2)).toEqual(
      [DEPOSIT, TOTAL_SHARES, TRANSFER].sort(),
    );
  });

  it('terminates on cyclic graphs', () => {
    const cyclic = buildGraphIndex([
      createRelationship({
        type: 'CALLS',
        source_id: DEPOSIT,
        target_id: WITHDRAW,
        provenance: [SOURCE_PROV],
      }),
      createRelationship({
        type: 'CALLS',
        source_id: WITHDRAW,
        target_id: DEPOSIT,
        provenance: [SOURCE_PROV],
      }),
    ]);
    expect(cyclic.getRelatedEntities(DEPOSIT, 5)).toEqual([WITHDRAW]);
  });

  it('returns an empty list at depth 0, unknown entities, and disconnected nodes', () => {
    expect(index.getRelatedEntities(DEPOSIT, 0)).toEqual([]);
    expect(index.getRelatedEntities('contract:missing', 3)).toEqual([]);
    expect(index.getRelationshipsFrom('contract:missing')).toEqual([]);
    expect(index.getRelationshipsTo('contract:missing')).toEqual([]);
  });
});
