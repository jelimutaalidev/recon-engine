import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { buildIr } from '../../src/recon/ir/build.js';
import { lineMap } from '../../src/recon/ir/line-map.js';

const MAIN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Base {
  uint256 public counter;
  function bump(uint256 by) public virtual { counter += by; }
}

contract Vault is Base {
  address public owner;
  uint256 immutable STAMP;
  uint256 constant CAP = 100;
  mapping(address => uint256) balances;

  event Sent(address indexed to, uint256 amount);
  error Insufficient(uint256 want);

  modifier guarded(uint256 limit) { _; }

  constructor() { owner = msg.sender; STAMP = 1; }
  receive() external payable {}
  fallback() external payable {}

  function send(address to, uint256 amount) public guarded(5) {
    require(amount > 0, "nope");
    balances[to] = amount;
    counter += amount;
    if (amount > CAP) revert Insufficient(amount);
    emit Sent(to, amount);
  }

  function bump(uint256 by) public override {
    balances[msg.sender] += by;
    counter++;
    super.bump(by);
  }

  function allCalls(Vault other, address target) external {
    helper();
    this.bump(1);
    other.bump(2);
    (bool ok, ) = target.call{value: 1}("");
    (ok, ) = target.delegatecall("");
    (ok, ) = target.staticcall("");
    function (uint256) internal pure returns (uint256) fp = twice;
    fp(2);
  }

  function overloaded(uint256 a) public pure returns (uint256) { return a; }
  function overloaded(address a) public pure returns (address) { return a; }

  function relay(Vault other) internal { other.bump(1); }

  function helper() internal view returns (uint256) { return counter; }

  function twice(uint256 a) internal pure returns (uint256) { return a * 2; }
}

interface IVault { function deposit() external; }

contract Factory {
  function build() external returns (Vault) { return new Vault(); }
}

library Lib { function twice(uint256 a) internal pure returns (uint256) { return a; } }

abstract contract AbstractThing { function later() public virtual; }
`;

const SEMANTIC_BROKEN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Broken {
  uint256 public x;
  function f() external { x = "not a uint"; }
}
`;

async function irOf(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'recon-ir-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  try {
    const config = parseReconConfig({ root, recordGit: false });
    const discovered = await discoverSources(config);
    const result = await compileProject(config, discovered.files);
    const { ir, issues } = buildIr(result, discovered.files);
    return { ir, issues, discovered, result, root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  return text.slice(0, index).split('\n').length;
}

describe('lineMap', () => {
  it('maps byte offsets to 1-based lines (multibyte aware)', () => {
    const content = Buffer.from('aé\nbcd\nefg\n', 'utf8');
    const line = lineMap(content);
    expect(line(0)).toBe(1);
    expect(line(1)).toBe(1);
    expect(line(3)).toBe(1);
    expect(line(4)).toBe(2);
    expect(line(8)).toBe(3);
    expect(line(999)).toBe(4);
    expect(line(-5)).toBe(1);
  });
});

describe('buildIr (semantic)', () => {
  it('builds contract IR: kind, abstract, fqn, linearized bases, span', async () => {
    const { ir } = await irOf({ 'Repo.sol': MAIN });
    expect(ir.fidelity).toBe('semantic');

    const vault = ir.contracts.find((contract) => contract.name === 'Vault');
    const base = ir.contracts.find((contract) => contract.name === 'Base');
    const iface = ir.contracts.find((contract) => contract.name === 'IVault');
    const lib = ir.contracts.find((contract) => contract.name === 'Lib');
    const abstractThing = ir.contracts.find((contract) => contract.name === 'AbstractThing');

    expect(vault?.kind).toBe('contract');
    expect(vault?.fqn).toBe('Repo.sol:Vault');
    expect(vault?.abstract).toBe(false);
    expect(vault?.bases.map((entry) => entry.fqn)).toEqual(['Repo.sol:Vault', 'Repo.sol:Base']);
    expect(base?.bases.map((entry) => entry.fqn)).toEqual(['Repo.sol:Base']);
    expect(iface?.kind).toBe('interface');
    expect(iface?.abstract).toBe(false);
    expect(lib?.kind).toBe('library');
    expect(abstractThing?.abstract).toBe(true);

    expect(vault?.span.file).toBe('Repo.sol');
    expect(vault?.span.lineStart).toBe(lineOf(MAIN, 'contract Vault is Base'));
    expect(vault?.span.byteStart).toBe(MAIN.indexOf('contract Vault is Base'));
    expect(vault?.span.lineEnd).toBeGreaterThanOrEqual(vault?.span.lineStart ?? 0);
  });

  it('builds state variable IR with mutability and layout slots', async () => {
    const { ir } = await irOf({ 'Repo.sol': MAIN });
    const vault = ir.contracts.find((contract) => contract.name === 'Vault');
    const base = ir.contracts.find((contract) => contract.name === 'Base');

    const owner = vault?.stateVars.find((variable) => variable.name === 'owner');
    const stamp = vault?.stateVars.find((variable) => variable.name === 'STAMP');
    const cap = vault?.stateVars.find((variable) => variable.name === 'CAP');
    const balances = vault?.stateVars.find((variable) => variable.name === 'balances');
    const counter = base?.stateVars.find((variable) => variable.name === 'counter');

    expect(owner).toMatchObject({
      type: 'address',
      visibility: 'public',
      mutability: 'mutable',
      slot: '1',
      declaredIn: 'Repo.sol:Vault',
    });
    expect(stamp?.mutability).toBe('immutable');
    expect(stamp?.slot).toBeUndefined();
    expect(cap?.mutability).toBe('constant');
    expect(cap?.slot).toBeUndefined();
    expect(balances?.type).toBe('mapping(address => uint256)');
    expect(balances?.slot).toBe('2');
    expect(counter).toMatchObject({ mutability: 'mutable', slot: '0', declaredIn: 'Repo.sol:Base' });
    expect(vault?.stateVars.some((variable) => variable.name === 'counter')).toBe(false);
  });

  it('builds function IR with kinds, modifiers, selectors, signatures', async () => {
    const { ir } = await irOf({ 'Repo.sol': MAIN });
    const vault = ir.contracts.find((contract) => contract.name === 'Vault');

    const send = vault?.functions.find((fn) => fn.name === 'send');
    expect(send).toMatchObject({
      kind: 'function',
      visibility: 'public',
      stateMutability: 'nonpayable',
      implemented: true,
      declaredIn: 'Repo.sol:Vault',
      canonicalSignature: 'send(address,uint256)',
    });
    expect(send?.selector).toMatch(/^[0-9a-f]{8}$/);
    expect(send?.modifiers).toEqual([{ name: 'guarded', argsText: '5' }]);
    expect(send?.params).toEqual([
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ]);

    const constructor = vault?.functions.find((fn) => fn.kind === 'constructor');
    expect(constructor?.canonicalSignature).toBe('constructor()');
    expect(constructor?.selector).toBeUndefined();
    expect(vault?.functions.find((fn) => fn.kind === 'receive')?.canonicalSignature).toBe('receive()');
    expect(vault?.functions.find((fn) => fn.kind === 'fallback')?.canonicalSignature).toBe('fallback()');

    const relay = vault?.functions.find((fn) => fn.name === 'relay');
    expect(relay?.canonicalSignature).toBe('relay(Vault)');
    expect(relay?.selector).toBeUndefined();

    const overloaded = vault?.functions.filter((fn) => fn.name === 'overloaded') ?? [];
    expect(overloaded).toHaveLength(2);
    const selectors = overloaded.map((fn) => fn.selector);
    expect(selectors[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(selectors[1]).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(selectors).size).toBe(2);
    expect(new Set(overloaded.map((fn) => fn.canonicalSignature)).size).toBe(2);

    const iface = ir.contracts.find((contract) => contract.name === 'IVault');
    expect(iface?.functions[0]?.implemented).toBe(false);
  });

  it('classifies call kinds with compiler-resolved targets', async () => {
    const { ir } = await irOf({ 'Repo.sol': MAIN });
    const vault = ir.contracts.find((contract) => contract.name === 'Vault');
    const allCalls = vault?.functions.find((fn) => fn.name === 'allCalls');
    expect(allCalls?.callSites.map((site) => site.kind)).toEqual([
      'internal',
      'self-external',
      'external',
      'lowlevel',
      'delegatecall',
      'staticcall',
      'indirect',
    ]);

    const [internal, selfExternal, external, lowlevel, delegate, staticc, indirect] =
      allCalls?.callSites ?? [];
    expect(internal?.resolvedRef).toEqual({
      fqn: 'Repo.sol:Vault',
      signature: 'helper()',
      nodeType: 'FunctionDefinition',
    });
    expect(selfExternal?.resolvedRef?.signature).toBe('bump(uint256)');
    expect(external?.resolvedRef?.fqn).toBe('Repo.sol:Vault');
    expect(lowlevel?.resolvedRef).toBeUndefined();
    expect(delegate?.resolvedRef).toBeUndefined();
    expect(staticc?.resolvedRef).toBeUndefined();
    expect(indirect?.resolvedRef).toBeUndefined();

    const build = ir.contracts
      .find((contract) => contract.name === 'Factory')
      ?.functions.find((fn) => fn.name === 'build');
    expect(build?.callSites).toHaveLength(1);
    expect(build?.callSites[0]).toEqual({
      kind: 'new',
      resolvedRef: { fqn: 'Repo.sol:Vault', signature: 'constructor()', nodeType: 'FunctionDefinition' },
      span: expect.objectContaining({ file: 'Repo.sol' }),
    });

    const bump = vault?.functions.find((fn) => fn.name === 'bump');
    const superCall = bump?.callSites.find((site) => site.kind === 'super');
    expect(superCall?.resolvedRef).toEqual({
      fqn: 'Repo.sol:Base',
      signature: 'bump(uint256)',
      nodeType: 'FunctionDefinition',
    });

    const send = vault?.functions.find((fn) => fn.name === 'send');
    expect(send?.callSites).toEqual([]);
  });

  it('extracts storage accesses with declaration identity only', async () => {
    const { ir } = await irOf({ 'Repo.sol': MAIN });
    const vault = ir.contracts.find((contract) => contract.name === 'Vault');

    const send = vault?.functions.find((fn) => fn.name === 'send');
    const sendOps = send?.storageAccesses ?? [];
    expect(sendOps).toEqual([
      {
        op: 'write',
        resolvedRef: { fqn: 'Repo.sol:Vault', name: 'balances' },
        span: expect.objectContaining({ file: 'Repo.sol' }),
      },
      {
        op: 'readwrite',
        resolvedRef: { fqn: 'Repo.sol:Base', name: 'counter' },
        span: expect.objectContaining({ file: 'Repo.sol' }),
      },
      {
        op: 'read',
        resolvedRef: { fqn: 'Repo.sol:Vault', name: 'CAP' },
        span: expect.objectContaining({ file: 'Repo.sol' }),
      },
    ]);

    const bump = vault?.functions.find((fn) => fn.name === 'bump');
    expect(bump?.storageAccesses.map((access) => [access.op, access.resolvedRef?.name])).toEqual([
      ['readwrite', 'balances'],
      ['readwrite', 'counter'],
    ]);

    const helper = vault?.functions.find((fn) => fn.name === 'helper');
    expect(helper?.storageAccesses).toEqual([
      {
        op: 'read',
        resolvedRef: { fqn: 'Repo.sol:Base', name: 'counter' },
        span: expect.objectContaining({ file: 'Repo.sol' }),
      },
    ]);

    const all = [...sendOps, ...(bump?.storageAccesses ?? []), ...(helper?.storageAccesses ?? [])];
    expect(all.every((access) => access.resolvedRef !== undefined)).toBe(true);
  });

  it('records event emits and custom error uses with canonical signatures', async () => {
    const { ir } = await irOf({ 'Repo.sol': MAIN });
    const vault = ir.contracts.find((contract) => contract.name === 'Vault');

    expect(vault?.events.map((event) => event.canonicalSignature)).toEqual(['Sent(address,uint256)']);
    expect(vault?.customErrors.map((error) => error.canonicalSignature)).toEqual([
      'Insufficient(uint256)',
    ]);

    const send = vault?.functions.find((fn) => fn.name === 'send');
    expect(send?.eventEmits).toHaveLength(1);
    expect(send?.eventEmits[0]?.signature).toBe('Sent(address,uint256)');
    expect(send?.customErrorUses).toHaveLength(1);
    expect(send?.customErrorUses[0]?.signature).toBe('Insufficient(uint256)');
  });

  it('lists source files with pragmas and sha256', async () => {
    const { ir, discovered } = await irOf({ 'Repo.sol': MAIN });
    expect(ir.files).toHaveLength(1);
    expect(ir.files[0]).toEqual({
      path: 'Repo.sol',
      sha256: discovered.files[0]?.sha256,
      pragmas: ['^0.8.0'],
    });
    expect(ir.files[0]?.sha256).toBe(createHash('sha256').update(MAIN).digest('hex'));
    expect(ir.compiler?.longVersion).toMatch(/^0\.8\.37\+commit\./);
  });
});

describe('buildIr (syntactic)', () => {
  it('never resolves targets: refs, selectors, and bases stay empty', async () => {
    const { ir, result } = await irOf({ 'Repo.sol': MAIN, 'Broken.sol': SEMANTIC_BROKEN });
    expect(result.fidelity).toBe('syntactic');
    expect(ir.fidelity).toBe('syntactic');

    const vault = ir.contracts.find((contract) => contract.name === 'Vault');
    expect(vault).toBeDefined();
    expect(vault?.bases).toEqual([]);

    const allSites = vault?.functions.flatMap((fn) => fn.callSites) ?? [];
    expect(allSites.length).toBeGreaterThan(0);
    expect(allSites.every((site) => site.resolvedRef === undefined)).toBe(true);
    expect(new Set(allSites.map((site) => site.kind)).has('internal')).toBe(true);
    expect(new Set(allSites.map((site) => site.kind)).has('lowlevel')).toBe(true);

    const send = vault?.functions.find((fn) => fn.name === 'send');
    expect(send?.selector).toBeUndefined();
    expect(send?.canonicalSignature).toBe('send(address,uint256)');

    const storage = vault?.functions.flatMap((fn) => fn.storageAccesses) ?? [];
    expect(storage.length).toBeGreaterThan(0);
    expect(storage.every((access) => access.resolvedRef === undefined)).toBe(true);

    const owner = vault?.stateVars.find((variable) => variable.name === 'owner');
    expect(owner?.slot).toBeUndefined();

    const sendIr = vault?.functions.find((fn) => fn.name === 'send');
    expect(sendIr?.eventEmits).toHaveLength(1);
    expect(sendIr?.eventEmits[0]?.signature).toBeUndefined();
    expect(sendIr?.customErrorUses).toHaveLength(1);
    expect(sendIr?.customErrorUses[0]?.signature).toBeUndefined();
  });
});
