import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { ReconError } from '../../src/errors/errors.js';

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'recon-compile-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

async function compileRepo(files: Record<string, string>) {
  const root = makeRepo(files);
  const config = parseReconConfig({ root, recordGit: false });
  const discovered = await discoverSources(config);
  const result = await compileProject(config, discovered.files);
  return { root, config, result };
}

const TINY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Tiny {
  uint256 public total;
  function set(uint256 value) external { total = value; }
}
`;

const TYPE_ERROR = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Broken {
  uint256 public x;
  function f() external { x = "not a uint"; }
}
`;

const SYNTAX_ERROR = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Syntax {
  function f( { broken
}
`;

describe('compileProject (bundled solc, offline)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it('compiles a tiny contract semantically with AST, selectors, and storage layout', async () => {
    const root = makeRepo({ 'Tiny.sol': TINY });
    roots.push(root);
    const config = parseReconConfig({ root, recordGit: false });
    const discovered = await discoverSources(config);
    const result = await compileProject(config, discovered.files);

    expect(result.fidelity).toBe('semantic');
    expect(result.longVersion).toMatch(/^0\.8\.37\+commit\.[0-9a-f]+/);
    expect(result.issues.filter((issue) => issue.severity === 'RECOVERABLE')).toEqual([]);
    const ast = result.output.sources?.['Tiny.sol']?.ast;
    expect(ast?.nodeType).toBe('SourceUnit');
    const identifiers = result.output.contracts?.['Tiny.sol']?.Tiny?.evm?.methodIdentifiers;
    expect(identifiers?.['set(uint256)']).toBeDefined();
    expect(identifiers?.['total()']).toBeDefined();
    const layout = result.output.contracts?.['Tiny.sol']?.Tiny?.storageLayout;
    expect(layout?.storage?.[0]?.label).toBe('total');
    expect(result.contents.get('Tiny.sol')).toContain('contract Tiny');
  });

  it('falls back to syntactic fidelity when semantics fail but syntax parses', async () => {
    const root = makeRepo({ 'Broken.sol': TYPE_ERROR });
    roots.push(root);
    const config = parseReconConfig({ root, recordGit: false });
    const discovered = await discoverSources(config);
    const result = await compileProject(config, discovered.files);

    expect(result.fidelity).toBe('syntactic');
    expect(result.output.sources?.['Broken.sol']?.ast).toBeDefined();
    const fallback = result.issues.find((issue) => issue.code === 'syntactic_fallback');
    expect(fallback?.severity).toBe('RECOVERABLE');
    expect(fallback?.file).toBe('Broken.sol');
  });

  it('drops syntactically broken files and keeps compiling the rest semantically', async () => {
    const root = makeRepo({ 'Good.sol': TINY, 'Bad.sol': SYNTAX_ERROR });
    roots.push(root);
    const config = parseReconConfig({ root, recordGit: false });
    const discovered = await discoverSources(config);
    const result = await compileProject(config, discovered.files);

    expect(result.fidelity).toBe('semantic');
    expect(result.output.sources?.['Good.sol']?.ast).toBeDefined();
    expect(result.output.sources?.['Bad.sol']).toBeUndefined();
    expect(result.dropped).toEqual(['Bad.sol']);
    const failed = result.issues.find((issue) => issue.code === 'compilation_failed');
    expect(failed?.severity).toBe('RECOVERABLE');
    expect(failed?.file).toBe('Bad.sol');
    expect(failed?.line_start).toBeGreaterThanOrEqual(1);
  });

  it('throws FATAL when every source fails to compile', async () => {
    const root = makeRepo({ 'Bad.sol': SYNTAX_ERROR });
    roots.push(root);
    const config = parseReconConfig({ root, recordGit: false });
    const discovered = await discoverSources(config);
    await expect(compileProject(config, discovered.files)).rejects.toThrow(ReconError);
    await expect(compileProject(config, discovered.files)).rejects.toThrow(
      /CompilationFailed|no source/i,
    );
  });

  it('refuses imports that resolve outside the analysis root (FATAL RootEscape)', async () => {
    const root = makeRepo({
      'A.sol': `pragma solidity ^0.8.0;\nimport "../recon-outside-x/Evil.sol";\ncontract A {}`,
    });
    roots.push(root);
    const outsideDir = join(tmpdir(), 'recon-outside-x');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'Evil.sol'), 'contract Evil {}');
    try {
      const config = parseReconConfig({ root, recordGit: false });
      const discovered = await discoverSources(config);
      await expect(compileProject(config, discovered.files)).rejects.toThrow(
        /RootEscape|outside/i,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('produces byte-identical output across runs', async () => {
    const first = await compileRepo({ 'Tiny.sol': TINY });
    roots.push(first.root);
    const second = await compileRepo({ 'Tiny.sol': TINY });
    roots.push(second.root);

    const pick = (result: Awaited<ReturnType<typeof compileProject>>) =>
      JSON.stringify({
        sources: Object.keys(result.output.sources ?? {}).sort(),
        contracts: result.output.contracts,
        fidelity: result.fidelity,
        longVersion: result.longVersion,
      });
    expect(pick(first.result)).toBe(pick(second.result));
  });

  it('resolves relative imports from disk through the jailed callback', async () => {
    const root = makeRepo({
      'src/A.sol': `pragma solidity ^0.8.0;\nimport "../lib/B.sol";\nabstract contract A is B {}`,
      'lib/B.sol': `pragma solidity ^0.8.0;\nabstract contract B { function b() public virtual; }`,
    });
    roots.push(root);
    const config = parseReconConfig({ root, recordGit: false, excludes: ['lib/**'] });
    const discovered = await discoverSources(config);
    expect(discovered.files.map((file) => file.path)).toEqual(['src/A.sol']);
    const result = await compileProject(config, discovered.files);

    expect(result.fidelity).toBe('semantic');
    expect(result.output.sources?.['lib/B.sol']?.ast).toBeDefined();
    expect(result.contents.get('lib/B.sol')).toContain('contract B');
  });

  it('honours the absolute root form on disk (realpath-safe)', async () => {
    const root = makeRepo({ 'Tiny.sol': TINY });
    roots.push(root);
    const config = parseReconConfig({ root: resolve(root), recordGit: false });
    const discovered = await discoverSources(config);
    const result = await compileProject(config, discovered.files);
    expect(result.fidelity).toBe('semantic');
  });
});
