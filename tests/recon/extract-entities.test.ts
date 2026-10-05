import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { buildIr } from '../../src/recon/ir/build.js';
import {
  createProvenanceFactory,
  mergePatches,
  runExtractors,
} from '../../src/recon/extract/index.js';
import { createContract } from '../../src/domain/contract.js';
import { createReconIssue } from '../../src/recon/issues.js';
import { sourceContractId } from '../../src/ids/ids.js';
import { ReconError } from '../../src/errors/errors.js';
import type { StatePatch } from '../../src/recon/extract/types.js';

const GIT = { repository: 'https://example.com/acme/recon.git', commit: 'cafe1234deadbeef' };
const TIMESTAMP = '2026-01-02T03:04:05Z';

const MAIN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IOwned { function owner() external view returns (address); }

interface IOwnedChild is IOwned { function rename(address next) external; }

library Lib { function twice(uint256 a) internal pure returns (uint256) { return a * 2; } }

abstract contract AbstractThing { function later() public virtual; }

contract Root {}
abstract contract Left is Root {}
abstract contract Right is Root {}
contract Diamond is Left, Right {}

contract Owned is IOwnedChild {
  address public ownerAddr;
  uint256 public counter;
  uint256 immutable STAMP;
  uint256 constant CAP = 7;

  modifier guarded(uint256 limit,   address who) { _; }
  modifier plain() { _; }
  modifier bare { _; }

  constructor() { STAMP = 1; }
  receive() external payable {}
  fallback() external payable {}

  function owner() external view returns (address) { return ownerAddr; }
  function rename(address next) public guarded(5,   msg.sender) plain bare { ownerAddr = next; }
  function takeVault(Owned other) public { counter += 1; }
  function helper() internal view returns (uint256) { return counter; }
}`;

const OUTSIDE_FILES = {
  'main/Main.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "../lib/Ext.sol";

contract Child is Ext {
  function hello() external {}
}
`,
  'lib/Ext.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Ext {
  function world() external {}
}
`,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function extractOf(
  files: Record<string, string>,
  options?: { excludes?: string[] },
) {
  const root = mkdtempSync(join(tmpdir(), 'recon-ext-'));
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

describe('extract: contracts', () => {
  it('classifies structurally with D1 abstract flag, compiler version, and source span', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const owned = patch.contracts.find((contract) => contract.name === 'Owned');
    expect(owned).toMatchObject({
      id: sourceContractId('Repo.sol', 'Owned'),
      contract_type: 'unknown',
      is_abstract: false,
      source_file: 'Repo.sol',
    });
    expect(owned?.compiler_version).toMatch(/^0\.8\.\d+\+commit\.[0-9a-f]+/);
    const startLine = lineOf(MAIN, 'contract Owned is IOwnedChild');
    expect(owned?.source).toMatch(new RegExp(`^Repo\\.sol:${startLine}-\\d+$`));
    const iface = patch.contracts.find((contract) => contract.name === 'IOwnedChild');
    expect(iface?.contract_type).toBe('interface');
    const lib = patch.contracts.find((contract) => contract.name === 'Lib');
    expect(lib?.contract_type).toBe('library');
    const abstractThing = patch.contracts.find((contract) => contract.name === 'AbstractThing');
    expect(abstractThing?.contract_type).toBe('unknown');
    expect(abstractThing?.is_abstract).toBe(true);
  });

  it('runs every extractor in the registry', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    expect(patch.contracts.length).toBeGreaterThan(0);
    expect(patch.functions.length).toBeGreaterThan(0);
    expect(patch.state_variables.length).toBeGreaterThan(0);
    expect(patch.relationships.length).toBeGreaterThan(0);
    expect(patch.facts).toEqual([]);
  });
});

describe('extract: functions', () => {
  it('takes public signature and selector from methodIdentifiers', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const takeVault = patch.functions.find((fn) => fn.name === 'takeVault');
    expect(takeVault?.signature).toBe('takeVault(address)');
    expect(takeVault?.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(takeVault?.visibility).toBe('public');
    expect(takeVault?.mutability).toBe('nonpayable');
    expect(takeVault?.source).toMatch(/^Repo\.sol:\d+-\d+$/);
    expect(takeVault?.parameters).toEqual([{ name: 'other', type: 'Owned' }]);
  });

  it('gives internal functions no selector', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const helper = patch.functions.find((fn) => fn.name === 'helper');
    expect(helper).toMatchObject({
      signature: 'helper()',
      visibility: 'internal',
      mutability: 'view',
    });
    expect(helper?.selector).toBeUndefined();
    const twice = patch.functions.find((fn) => fn.name === 'twice');
    expect(twice).toMatchObject({
      contract_id: sourceContractId('Repo.sol', 'Lib'),
      signature: 'twice(uint256)',
      mutability: 'pure',
    });
    expect(twice?.selector).toBeUndefined();
  });

  it('models constructor, fallback, and receive with no selector', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const constructor = patch.functions.find((fn) => fn.name === 'constructor');
    expect(constructor).toMatchObject({
      signature: 'constructor()',
      mutability: 'nonpayable',
      parameters: [],
    });
    expect(constructor?.selector).toBeUndefined();
    const fallback = patch.functions.find((fn) => fn.name === 'fallback');
    expect(fallback?.signature).toBe('fallback()');
    expect(fallback?.selector).toBeUndefined();
    const receive = patch.functions.find((fn) => fn.name === 'receive');
    expect(receive).toMatchObject({ signature: 'receive()', mutability: 'payable' });
    expect(receive?.selector).toBeUndefined();
  });

  it('collapses modifier invocation text', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const rename = patch.functions.find(
      (fn) => fn.name === 'rename' && fn.contract_id === sourceContractId('Repo.sol', 'Owned'),
    );
    expect(rename?.modifiers).toEqual(['guarded(5, msg.sender)', 'plain', 'bare']);
  });
});

describe('extract: state variables', () => {
  it('records visibility, D2 mutability, layout slots, and source span', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const ownedId = sourceContractId('Repo.sol', 'Owned');
    const ownerAddr = patch.state_variables.find((sv) => sv.name === 'ownerAddr');
    expect(ownerAddr).toMatchObject({
      contract_id: ownedId,
      type: 'address',
      visibility: 'public',
      mutability: 'mutable',
      slot: '0',
    });
    expect(ownerAddr?.source).toMatch(/^Repo\.sol:\d+-\d+$/);
    const counter = patch.state_variables.find((sv) => sv.name === 'counter');
    expect(counter).toMatchObject({ slot: '1', mutability: 'mutable' });
    const stamp = patch.state_variables.find((sv) => sv.name === 'STAMP');
    expect(stamp).toMatchObject({ mutability: 'immutable', visibility: 'internal' });
    expect(stamp?.slot).toBeUndefined();
    const cap = patch.state_variables.find((sv) => sv.name === 'CAP');
    expect(cap).toMatchObject({ mutability: 'constant', type: 'uint256' });
    expect(cap?.slot).toBeUndefined();
  });
});

describe('extract: inheritance', () => {
  it('emits IMPLEMENTS edges for interface bases with git-aware provenance', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const ownedId = sourceContractId('Repo.sol', 'Owned');
    const child = patch.relationships.find(
      (rel) => rel.type === 'IMPLEMENTS' && rel.source_id === ownedId,
    );
    expect(child?.target_id).toBe(sourceContractId('Repo.sol', 'IOwnedChild'));
    expect(child?.provenance[0]).toMatchObject({
      source_type: 'source_code',
      file: 'Repo.sol',
      repository: GIT.repository,
      commit: GIT.commit,
      line_start: lineOf(MAIN, 'contract Owned is IOwnedChild'),
    });
    expect(child?.created_at).toBe(TIMESTAMP);
    const grandparent = patch.relationships.find(
      (rel) => rel.type === 'IMPLEMENTS' && rel.source_id === sourceContractId('Repo.sol', 'IOwnedChild'),
    );
    expect(grandparent?.target_id).toBe(sourceContractId('Repo.sol', 'IOwned'));
    for (const rel of patch.relationships) {
      expect(rel.provenance.length).toBeGreaterThanOrEqual(1);
      expect(rel.provenance[0]?.source_type).toBe('source_code');
    }
  });

  it('emits every diamond inheritance edge', async () => {
    const { patch } = await extractOf({ 'Repo.sol': MAIN });
    const diamond = sourceContractId('Repo.sol', 'Diamond');
    const left = sourceContractId('Repo.sol', 'Left');
    const right = sourceContractId('Repo.sol', 'Right');
    const root = sourceContractId('Repo.sol', 'Root');
    for (const target of [left, right, root]) {
      const edge = patch.relationships.find(
        (rel) => rel.type === 'INHERITS' && rel.source_id === diamond && rel.target_id === target,
      );
      expect(edge, `expected INHERITS edge to ${target}`).toBeDefined();
    }
    expect(
      patch.relationships.find(
        (rel) => rel.type === 'INHERITS' && rel.source_id === left && rel.target_id === root,
      ),
    ).toBeDefined();
    expect(
      patch.relationships.find(
        (rel) => rel.type === 'INHERITS' && rel.source_id === right && rel.target_id === root,
      ),
    ).toBeDefined();
    const selfEdge = patch.relationships.find(
      (rel) => rel.source_id === diamond && rel.target_id === diamond,
    );
    expect(selfEdge).toBeUndefined();
  });

  it('flags bases outside the source set without fabricating an edge', async () => {
    const { patch, ir } = await extractOf(OUTSIDE_FILES, { excludes: ['lib/**'] });
    expect(ir.files.map((file) => file.path)).toEqual(['main/Main.sol']);
    expect(patch.contracts.find((contract) => contract.name === 'Child')).toBeDefined();
    expect(patch.contracts.find((contract) => contract.name === 'Ext')).toBeUndefined();
    const issue = patch.issues.find((entry) => entry.code === 'base_outside_sources');
    expect(issue).toMatchObject({ severity: 'UNKNOWN', file: 'main/Main.sol' });
    const extId = sourceContractId('lib/Ext.sol', 'Ext');
    expect(patch.relationships.some((rel) => rel.source_id === extId || rel.target_id === extId)).toBe(
      false,
    );
  });
});

describe('extract: provenance factory', () => {
  it('omits repository and commit when git context is unavailable', () => {
    const factory = createProvenanceFactory();
    const provenance = factory({
      file: 'Repo.sol',
      byteStart: 0,
      byteEnd: 7,
      lineStart: 3,
      lineEnd: 5,
    });
    expect(provenance).toEqual({
      source_type: 'source_code',
      file: 'Repo.sol',
      line_start: 3,
      line_end: 5,
    });
  });
});

describe('extract: registry merge', () => {
  const contractA = createContract({
    name: 'Dup',
    contract_type: 'unknown',
    source_file: 'a.sol',
    source: 'a.sol:1-2',
  });
  const patchOf = (contracts: StatePatch['contracts'], issues: StatePatch['issues'] = []): StatePatch => ({
    contracts,
    functions: [],
    state_variables: [],
    relationships: [],
    facts: [],
    issues,
  });

  it('dedupes identical entities across patches', () => {
    const merged = mergePatches([patchOf([contractA]), patchOf([contractA])]);
    expect(merged.contracts).toHaveLength(1);
    expect(merged.contracts[0]?.id).toBe(contractA.id);
  });

  it('rejects conflicting content under one canonical id', () => {
    const conflicting = createContract({
      name: 'Dup',
      contract_type: 'interface',
      source_file: 'a.sol',
      source: 'a.sol:1-9',
    });
    expect(conflicting.id).toBe(contractA.id);
    expect(() => mergePatches([patchOf([contractA]), patchOf([conflicting])])).toThrow(ReconError);
    try {
      mergePatches([patchOf([contractA]), patchOf([conflicting])]);
    } catch (error) {
      expect((error as ReconError).code).toBe('DuplicateCanonicalEntity');
    }
  });

  it('sorts merged issues by severity then code', () => {
    const unknown = createReconIssue({ severity: 'UNKNOWN', code: 'zzz', message: 'unknown first' });
    const fatal = createReconIssue({ severity: 'FATAL', code: 'aaa', message: 'fatal first' });
    const merged = mergePatches([patchOf([], [unknown]), patchOf([], [fatal])]);
    expect(merged.issues.map((issue) => issue.code)).toEqual(['aaa', 'zzz']);
  });

  it('drops byte-identical duplicate issues', () => {
    const issue = createReconIssue({ severity: 'UNKNOWN', code: 'dup', message: 'same' });
    const merged = mergePatches([patchOf([], [issue]), patchOf([], [issue])]);
    expect(merged.issues).toHaveLength(1);
  });
});
