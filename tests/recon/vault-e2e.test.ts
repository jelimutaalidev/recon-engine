import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { analyzeProject, type AnalysisResult } from '../../src/recon/index.js';

const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));
const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const TIMESTAMP_ISO = '2026-01-01T00:00:00.000Z';

function vaultConfig(overrides: Record<string, unknown> = {}): ReconConfig {
  return parseReconConfig({
    root: VAULT_ROOT,
    recordGit: false,
    timestamp: TIMESTAMP,
    projectName: 'vault-e2e',
    ...overrides,
  });
}

describe('Vault E2E', () => {
  let result: AnalysisResult;

  beforeAll(async () => {
    result = await analyzeProject(vaultConfig());
  });

  it('analyzes the multi-file fixture semantically', () => {
    expect(result.meta.fidelity).toBe('semantic');
    expect(result.meta.fileCount).toBe(5);
    expect(result.meta.timestamp).toBe(TIMESTAMP_ISO);
    expect(result.state.project?.name).toBe('vault-e2e');
    expect(result.state.project?.commit).toBeUndefined();
    expect(result.state.project?.repository).toBeUndefined();
  });

  it('produces ids and selectors from compiler evidence', () => {
    const contractIds = result.state.contracts.map((contract) => contract.id);
    expect(contractIds).toEqual(
      expect.arrayContaining([
        'contract:ivault_sol:ivault',
        'contract:istrategy_sol:istrategy',
        'contract:mathlib_sol:mathlib',
        'contract:erc4626base_sol:erc4626base',
        'contract:vault_sol:vault',
      ]),
    );

    const deposit = result.state.functions.find(
      (fn) => fn.id === 'function:contract:vault_sol:vault:deposit(uint256)',
    );
    expect(deposit).toBeDefined();
    expect(deposit?.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(deposit?.modifiers).toContain('nonReentrant');

    const interfaceDeposit = result.state.functions.find(
      (fn) => fn.id === 'function:contract:ivault_sol:ivault:deposit(uint256)',
    );
    expect(interfaceDeposit?.selector).toBe(deposit?.selector);
    expect(interfaceDeposit?.selector).toBe('0xb6b55f25');

    const constructor = result.state.functions.find(
      (fn) => fn.id === 'function:contract:vault_sol:vault:constructor()',
    );
    expect(constructor).toBeDefined();
    expect(constructor?.selector).toBeUndefined();

    const balances = result.state.state_variables.find(
      (variable) => variable.id === 'state:contract:vault_sol:vault:balances',
    );
    expect(balances?.slot).toBe('2');
    expect(balances?.type).toContain('mapping');
  });

  it('records IMPLEMENTS and INHERITS from linearization', () => {
    expect(
      result.state.relationships.find(
        (rel) =>
          rel.type === 'IMPLEMENTS' &&
          rel.source_id === 'contract:vault_sol:vault' &&
          rel.target_id === 'contract:ivault_sol:ivault',
      ),
    ).toBeDefined();
    expect(
      result.state.relationships.find(
        (rel) =>
          rel.type === 'INHERITS' &&
          rel.source_id === 'contract:vault_sol:vault' &&
          rel.target_id === 'contract:erc4626base_sol:erc4626base',
      ),
    ).toBeDefined();
  });

  it('preserves the call_kind matrix on CALLS edges', () => {
    const edge = (source: string, target: string) =>
      result.state.relationships.find(
        (rel) => rel.type === 'CALLS' && rel.source_id === source && rel.target_id === target,
      );
    const deposit = 'function:contract:vault_sol:vault:deposit(uint256)';
    const rebalance = 'function:contract:vault_sol:vault:rebalance()';
    const echo = 'function:contract:vault_sol:vault:echo(uint256)';
    const echoViaThis = 'function:contract:vault_sol:vault:echoViaThis(uint256)';
    const vaultTouch = 'function:contract:vault_sol:vault:_touch()';
    const baseTouch = 'function:contract:erc4626base_sol:erc4626base:_touch()';
    const mulDiv = 'function:contract:mathlib_sol:mathlib:mulDiv(uint256,uint256,uint256)';
    const preview = 'function:contract:vault_sol:vault:previewDeposit(uint256)';
    const harvest = 'function:contract:istrategy_sol:istrategy:harvest()';
    const harvestCaller =
      'function:contract:vault_sol:vault:harvestViaInterface(address)';

    expect(edge(deposit, mulDiv)?.metadata).toMatchObject({ call_kind: 'internal' });
    expect(edge(rebalance, vaultTouch)?.metadata).toMatchObject({ call_kind: 'internal' });
    expect(edge(echo, preview)?.metadata).toMatchObject({ call_kind: 'internal' });
    expect(edge(echoViaThis, preview)?.metadata).toMatchObject({ call_kind: 'self-external' });
    expect(edge(vaultTouch, baseTouch)?.metadata).toMatchObject({ call_kind: 'super' });
    expect(edge(harvestCaller, harvest)?.metadata).toMatchObject({ call_kind: 'external' });

    const rebalanceCalls = result.state.relationships.filter(
      (rel) => rel.type === 'CALLS' && rel.source_id === rebalance,
    );
    expect(rebalanceCalls).toHaveLength(1);
    expect(rebalanceCalls[0]?.target_id).toBe(vaultTouch);
    const unresolvedKinds = result.state.relationships.filter((rel) =>
      ['lowlevel', 'delegatecall', 'staticcall'].includes(String(rel.metadata?.call_kind)),
    );
    expect(unresolvedKinds).toEqual([]);
  });

  it('emits READS/WRITES edges for direct, compound, and inherited storage', () => {
    const edge = (type: 'READS' | 'WRITES', source: string, target: string) =>
      result.state.relationships.find(
        (rel) => rel.type === type && rel.source_id === source && rel.target_id === target,
      );
    const deposit = 'function:contract:vault_sol:vault:deposit(uint256)';
    const constructor = 'function:contract:vault_sol:vault:constructor()';
    const balances = 'state:contract:vault_sol:vault:balances';
    const total = 'state:contract:erc4626base_sol:erc4626base:_totalAssets';
    const strategy = 'state:contract:vault_sol:vault:strategy';

    expect(edge('READS', deposit, balances)).toBeDefined();
    expect(edge('WRITES', deposit, balances)).toBeDefined();
    expect(edge('READS', deposit, total)).toBeDefined();
    expect(edge('WRITES', deposit, total)).toBeDefined();
    expect(edge('WRITES', constructor, strategy)).toBeDefined();
    expect(edge('READS', 'function:contract:vault_sol:vault:rebalance()', strategy)).toBeDefined();
  });

  it('creates EMITS and custom-error USES facts without event/error entities', () => {
    const emits = result.state.facts.find(
      (fact) =>
        fact.subject_id === 'function:contract:vault_sol:vault:deposit(uint256)' &&
        fact.predicate === 'EMITS',
    );
    expect(emits?.value).toBe('Deposit(address,uint256,uint256)');

    const uses = result.state.facts.filter(
      (fact) => fact.predicate === 'USES' && fact.value === 'custom-error:ZeroShares()',
    );
    expect(uses.length).toBeGreaterThanOrEqual(2);

    expect(result.state.contracts.some((contract) => contract.name === 'Deposit')).toBe(false);
    expect(result.state.contracts.some((contract) => contract.name === 'ZeroShares')).toBe(false);
  });

  it('marks unresolved delegatecall and low-level call sites with UNKNOWN issues', () => {
    const rebalance = 'function:contract:vault_sol:vault:rebalance()';
    const delegate = result.state.facts.find(
      (fact) =>
        fact.subject_id === rebalance &&
        fact.predicate === 'DELEGATES_TO' &&
        fact.value === 'unresolved-delegatecall',
    );
    expect(delegate).toBeDefined();
    const lowlevel = result.state.facts.find(
      (fact) =>
        fact.subject_id === rebalance &&
        fact.predicate === 'CALLS' &&
        fact.value === 'unresolved-lowlevel-call',
    );
    expect(lowlevel).toBeDefined();

    const unknownCodes = result.issues
      .filter((issue) => issue.severity === 'UNKNOWN')
      .map((issue) => issue.code)
      .sort();
    expect(unknownCodes).toEqual(['unresolved_delegatecall', 'unresolved_lowlevel_call']);
  });

  it('gives every generated fact and relationship provenance with file and lines', () => {
    const items = [...result.state.relationships, ...result.state.facts];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.provenance.length).toBeGreaterThanOrEqual(1);
      for (const record of item.provenance) {
        expect(record.source_type).toBe('source_code');
        expect(record.file).toMatch(/\.sol$/);
        expect(record.line_start).toBeGreaterThanOrEqual(1);
        expect(record.line_end).toBeGreaterThanOrEqual(record.line_start as number);
        expect(record.commit).toBeUndefined();
        expect(record.repository).toBeUndefined();
      }
    }
  });

  it('summarizes issues with no silent severity mixing', () => {
    expect(result.issues.map((issue) => `${issue.severity}:${issue.code}`)).toEqual([
      'UNKNOWN:unresolved_delegatecall',
      'UNKNOWN:unresolved_lowlevel_call',
      'UNSUPPORTED:unsupported_builtin',
    ]);
    const builtin = result.issues.find((issue) => issue.code === 'unsupported_builtin');
    expect(builtin?.file).toBe('Vault.sol');
    expect(builtin?.count).toBeGreaterThanOrEqual(1);
    expect(builtin?.line_start).toBeGreaterThanOrEqual(1);
    expect(builtin?.line_end).toBeGreaterThanOrEqual(builtin?.line_start as number);
  });
});
