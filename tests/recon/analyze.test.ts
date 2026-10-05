import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { analyzeProject } from '../../src/recon/index.js';
import { sortIssues } from '../../src/recon/issues.js';
import { createReconState, deserializeReconState, serializeReconState } from '../../src/recon-state/state.js';

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IVault {
  function deposit(uint256 amount) external;
}

library MathLib {
  function add(uint256 a, uint256 b) internal pure returns (uint256) {
    return a + b;
  }
}

contract Vault is IVault {
  uint256 public counter;

  event Deposited(address indexed who, uint256 amount);
  error TooMuch(uint256 have);

  modifier limited() {
    require(counter < 100, "cap");
    _;
  }

  constructor() {
    counter = 0;
  }

  function deposit(uint256 amount) external limited {
    if (amount > 1000) revert TooMuch(amount);
    counter = counter + amount;
    emit Deposited(msg.sender, amount);
  }
}
`;

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'recon-analyze-'));
  writeFileSync(join(root, 'Vault.sol'), SRC);
  return root;
}

const TIMESTAMP = '2026-01-01T00:00:00Z';
const TIMESTAMP_ISO = '2026-01-01T00:00:00.000Z';

function fixtureConfig(root: string, overrides: Record<string, unknown> = {}): ReconConfig {
  return parseReconConfig({
    root,
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: 'analyze-fixture',
    ...overrides,
  });
}

describe('analyzeProject', () => {
  it('returns a validate-clean state for an end-to-end fixture', async () => {
    const config = fixtureConfig(makeFixture());
    const result = await analyzeProject(config);

    expect(result.meta.fidelity).toBe('semantic');
    expect(result.meta.fileCount).toBe(1);
    expect(result.meta.timestamp).toBe(TIMESTAMP_ISO);
    expect(result.meta.solcLongVersion).toMatch(/^\d+\.\d+\.\d+\+commit\./);

    expect(result.state.project?.name).toBe('analyze-fixture');
    expect(result.state.contracts.map((contract) => contract.id)).toContain('contract:vault_sol:vault');
    expect(
      result.state.relationships.some(
        (rel) =>
          rel.type === 'IMPLEMENTS' &&
          rel.source_id === 'contract:vault_sol:vault' &&
          rel.target_id === 'contract:vault_sol:ivault',
      ),
    ).toBe(true);
    expect(result.state.relationships.some((rel) => rel.type === 'READS')).toBe(true);
    expect(result.state.relationships.some((rel) => rel.type === 'WRITES')).toBe(true);
    expect(
      result.state.facts.some((fact) => fact.predicate === 'EMITS' && fact.value === 'Deposited(address,uint256)'),
    ).toBe(true);

    expect(() => deserializeReconState(serializeReconState(result.state))).not.toThrow();
    expect(result.issues).toEqual(sortIssues(result.issues));
  });

  it('pins project created_at/updated_at and fact created_at to the resolved timestamp', async () => {
    const root = makeFixture();
    const first = await analyzeProject(fixtureConfig(root));
    const second = await analyzeProject(fixtureConfig(root));

    expect(first.state.project?.created_at).toBe(TIMESTAMP_ISO);
    expect(first.state.project?.updated_at).toBe(TIMESTAMP_ISO);
    expect(first.state.project).toEqual(second.state.project);
    expect(first.state.facts.length).toBeGreaterThan(0);
    for (const fact of first.state.facts) {
      expect(fact.created_at).toBe(TIMESTAMP_ISO);
    }
    for (const rel of first.state.relationships) {
      expect(rel.created_at).toBe(TIMESTAMP_ISO);
    }
  });

  it('produces byte-identical serialization across two runs', async () => {
    const root = makeFixture();
    const config = fixtureConfig(root);
    const first = await analyzeProject(config);
    const second = await analyzeProject(config);

    expect(serializeReconState(first.state)).toBe(serializeReconState(second.state));
    expect(first.issues).toEqual(second.issues);
  });

  it('yields an identical state when discovery include order is reversed', async () => {
    const root = makeFixture();
    const forward = await analyzeProject(fixtureConfig(root, { includes: ['**/*.sol', '*.sol'] }));
    const reversed = await analyzeProject(fixtureConfig(root, { includes: ['*.sol', '**/*.sol'] }));

    expect(serializeReconState(reversed.state)).toBe(serializeReconState(forward.state));
    expect(reversed.issues).toEqual(forward.issues);
  });

  it('re-validates with the derived provenance registry as the provided registry', async () => {
    const config = fixtureConfig(makeFixture());
    const result = await analyzeProject(config);

    expect(result.state.provenance.length).toBeGreaterThan(0);
    expect(() => createReconState(result.state)).not.toThrow();
  });
});
