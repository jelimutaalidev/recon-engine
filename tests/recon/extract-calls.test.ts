import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { buildIr } from '../../src/recon/ir/build.js';
import { createProvenanceFactory, runExtractors } from '../../src/recon/extract/index.js';
import { functionId, sourceContractId, stateVariableId } from '../../src/ids/ids.js';

const GIT = { repository: 'https://example.com/acme/recon.git', commit: 'cafe1234deadbeef' };
const TIMESTAMP = '2026-01-02T03:04:05Z';

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IVault { function deposit() external; }

contract Base {
  uint256 baseCounter;
  function shared(uint256 n) public virtual returns (uint256) { return n; }
  function helper() internal view returns (uint256) { return baseCounter; }
}

contract Vault is Base, IVault {
  uint256 counter;
  mapping(address => uint256) balances;

  event Sent(address indexed to, uint256 amount);
  error Insufficient(uint256 want);

  constructor() {}

  function shared(uint256 n) public override returns (uint256) { return n + 1; }

  function deposit() external {
    counter += 1;
    balances[msg.sender] = counter;
    if (counter > 100) revert Insufficient(counter);
    emit Sent(msg.sender, counter);
  }

  function internalFlow(uint256 n) public returns (uint256) {
    helper();
    return shared(n);
  }

  function selfFlow() external returns (uint256) {
    this.shared(1);
    return super.shared(2);
  }

  function externalFlow(Vault other, IVault target, address addr) external returns (bool, bytes memory) {
    other.shared(3);
    target.deposit();
    (bool ok, ) = addr.call{value: 1}("");
    (ok, ) = addr.delegatecall("");
    (ok, ) = addr.staticcall("");
    function (uint256) internal pure returns (uint256) fp = twice;
    fp(2);
    return (ok, "");
  }

  function viaAbi(address addr) external returns (bytes memory) {
    (, bytes memory data) = addr.call(abi.encodeWithSignature("shared(uint256)", 1));
    return data;
  }

  function twice(uint256 a) internal pure returns (uint256) { return a * 2; }
}

contract Other {
  function factory() external returns (Vault) { return new Vault(); }
}`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function extractOf(files: Record<string, string>, options?: { excludes?: string[] }) {
  const root = mkdtempSync(join(tmpdir(), 'recon-call-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  const config = parseReconConfig({
    root,
    recordGit: false,
    timestamp: TIMESTAMP,
    ...(options?.excludes !== undefined ? { excludes: options.excludes } : {}),
  });
  const discovered = await discoverSources(config);
  const result = await compileProject(config, discovered.files);
  const { ir } = buildIr(result, discovered.files);
  const provenance = createProvenanceFactory(GIT);
  const patch = runExtractors({ ir, config, provenance });
  return { patch, ir, config };
}

function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`fixture is missing ${JSON.stringify(needle)}`);
  return text.slice(0, index).split('\n').length;
}

const baseId = sourceContractId('Repo.sol', 'Base');
const vaultId = sourceContractId('Repo.sol', 'Vault');
const ifaceId = sourceContractId('Repo.sol', 'IVault');
const otherId = sourceContractId('Repo.sol', 'Other');
const fn = (contract: string, signature: string) => functionId(contract, signature);
const state = (contract: string, name: string) => stateVariableId(contract, name);

describe('extract: call relationships', () => {
  it('builds the resolved call-kind matrix with call_kind metadata', async () => {
    const { patch } = await extractOf({ 'Repo.sol': SRC });
    const edges: [string, string, string, string][] = [
      ['internalFlow(uint256)', fn(vaultId, 'internalFlow(uint256)'), fn(baseId, 'helper()'), 'internal'],
      ['shared internal', fn(vaultId, 'internalFlow(uint256)'), fn(vaultId, 'shared(uint256)'), 'internal'],
      ['self-external', fn(vaultId, 'selfFlow()'), fn(vaultId, 'shared(uint256)'), 'self-external'],
      ['super', fn(vaultId, 'selfFlow()'), fn(baseId, 'shared(uint256)'), 'super'],
      ['external', fn(vaultId, 'externalFlow(address,address,address)'), fn(vaultId, 'shared(uint256)'), 'external'],
      ['interface', fn(vaultId, 'externalFlow(address,address,address)'), fn(ifaceId, 'deposit()'), 'external'],
      ['new', fn(otherId, 'factory()'), fn(vaultId, 'constructor()'), 'new'],
    ];
    for (const [label, source, target, callKind] of edges) {
      const edge = patch.relationships.find(
        (rel) => rel.type === 'CALLS' && rel.source_id === source && rel.target_id === target,
      );
      expect(edge, `missing CALLS edge: ${label}`).toBeDefined();
      expect(edge?.metadata).toMatchObject({ call_kind: callKind });
      expect(edge?.provenance[0]?.source_type).toBe('source_code');
      expect(edge?.provenance[0]?.file).toBe('Repo.sol');
      expect(edge?.created_at).toBe(TIMESTAMP);
    }
    expect(patch.relationships.filter((rel) => rel.type === 'CALLS')).toHaveLength(edges.length);
  });

  it('marks delegatecall, staticcall, lowlevel, and indirect sites with UNKNOWN issues', async () => {
    const { patch } = await extractOf({ 'Repo.sol': SRC });
    const externalFlow = fn(vaultId, 'externalFlow(address,address,address)');
    const viaAbi = fn(vaultId, 'viaAbi(address)');

    const delegate = patch.facts.find((fact) => fact.value === 'unresolved-delegatecall');
    expect(delegate).toMatchObject({
      subject_id: externalFlow,
      predicate: 'DELEGATES_TO',
    });
    expect(delegate?.provenance[0]?.line_start).toBe(lineOf(SRC, 'addr.delegatecall'));

    const staticCall = patch.facts.find((fact) => fact.value === 'unresolved-staticcall');
    expect(staticCall).toMatchObject({ subject_id: externalFlow, predicate: 'CALLS' });

    const indirect = patch.facts.find((fact) => fact.value === 'unresolved-indirect-call');
    expect(indirect).toMatchObject({ subject_id: externalFlow, predicate: 'CALLS' });

    const lowlevelFacts = patch.facts.filter((fact) => fact.value === 'unresolved-lowlevel-call');
    expect(lowlevelFacts.map((fact) => fact.subject_id).sort()).toEqual(
      [externalFlow, viaAbi].sort(),
    );

    expect(patch.issues.find((issue) => issue.code === 'unresolved_delegatecall')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
      file: 'Repo.sol',
    });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_staticcall')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
    });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_indirect_call')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
    });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_lowlevel_call')).toMatchObject({
      severity: 'UNKNOWN',
      count: 2,
    });
    expect(patch.issues.filter((issue) => issue.code.startsWith('call_target_'))).toEqual([]);
  });

  it('never fuzzy-matches abi.encodeWithSignature against repo signatures', async () => {
    const { patch } = await extractOf({ 'Repo.sol': SRC });
    const viaAbi = fn(vaultId, 'viaAbi(address)');
    expect(patch.relationships.some((rel) => rel.source_id === viaAbi)).toBe(false);
    const facts = patch.facts.filter((fact) => fact.subject_id === viaAbi);
    expect(facts.map((fact) => fact.value)).toEqual(['unresolved-lowlevel-call']);
  });
});

describe('extract: storage relationships', () => {
  it('merges compound read+write accesses into READS/WRITES edges with multi-span provenance', async () => {
    const { patch } = await extractOf({ 'Repo.sol': SRC });
    const deposit = fn(vaultId, 'deposit()');
    const reads = patch.relationships.find(
      (rel) => rel.type === 'READS' && rel.source_id === deposit && rel.target_id === state(vaultId, 'counter'),
    );
    expect(reads).toBeDefined();
    expect(reads?.provenance.length).toBeGreaterThanOrEqual(3);
    const writes = patch.relationships.find(
      (rel) => rel.type === 'WRITES' && rel.source_id === deposit && rel.target_id === state(vaultId, 'counter'),
    );
    expect(writes).toBeDefined();
    const balanceWrite = patch.relationships.find(
      (rel) => rel.type === 'WRITES' && rel.target_id === state(vaultId, 'balances'),
    );
    expect(balanceWrite?.source_id).toBe(deposit);
    const helperRead = patch.relationships.find(
      (rel) => rel.type === 'READS' && rel.target_id === state(baseId, 'baseCounter'),
    );
    expect(helperRead?.source_id).toBe(fn(baseId, 'helper()'));
    expect(helperRead?.provenance[0]?.source_type).toBe('source_code');
  });
});

describe('extract: event and custom error facts', () => {
  it('emits an EMITS fact with the event signature and emit line provenance', async () => {
    const { patch } = await extractOf({ 'Repo.sol': SRC });
    const deposit = fn(vaultId, 'deposit()');
    const fact = patch.facts.find((item) => item.predicate === 'EMITS' && item.subject_id === deposit);
    expect(fact?.value).toBe('Sent(address,uint256)');
    expect(fact?.provenance[0]).toMatchObject({
      source_type: 'source_code',
      file: 'Repo.sol',
      line_start: lineOf(SRC, 'emit Sent('),
      repository: GIT.repository,
      commit: GIT.commit,
    });
    expect(fact?.created_at).toBe(TIMESTAMP);
  });

  it('records custom-error USES facts without require/revert string noise', async () => {
    const { patch } = await extractOf({ 'Repo.sol': SRC });
    const deposit = fn(vaultId, 'deposit()');
    const fact = patch.facts.find((item) => item.predicate === 'USES' && item.subject_id === deposit);
    expect(fact?.value).toBe('custom-error:Insufficient(uint256)');
    expect(
      patch.facts.filter((item) => item.predicate === 'USES' && item.subject_id === deposit),
    ).toHaveLength(1);
  });
});
