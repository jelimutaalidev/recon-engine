import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileProject } from '../../src/recon/backend/solc/compile.js';
import { parseReconConfig } from '../../src/recon/config.js';
import { discoverSources } from '../../src/recon/discover.js';
import { buildIr } from '../../src/recon/ir/build.js';
import { createProvenanceFactory, runExtractors } from '../../src/recon/extract/index.js';
import { functionId, sourceContractId } from '../../src/ids/ids.js';

const TIMESTAMP = '2026-01-02T03:04:05Z';

const SYNTAX_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Synt {
  uint256 counter;
  event Ping(uint256 n);
  error Boom(uint256 n);

  function go(address target) external {
    counter += 1;
    emit Ping(counter);
    if (counter > 3) revert Boom(counter);
    bare();
    (bool ok, ) = target.call("");
    (ok, ) = target.delegatecall("");
    function (uint256) internal pure returns (uint256) fp = twice;
    fp(1);
  }

  function bare() external {}
  function twice(uint256 a) internal pure returns (uint256) { return a; }
}`;

const SEMANTIC_BROKEN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Broken {
  uint256 public x;
  function f() external { x = "not a uint"; }
}
`;

const OUTSIDE_FILES = {
  'main/Main.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "../lib/Ext.sol";

contract Child {
  function go(Ext ext) external { ext.ping(); }
}
`,
  'lib/Ext.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Ext {
  function ping() external {}
}
`,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function extractOf(files: Record<string, string>, options?: { excludes?: string[] }) {
  const root = mkdtempSync(join(tmpdir(), 'recon-unk-'));
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
  const provenance = createProvenanceFactory();
  const patch = runExtractors({ ir, config, provenance });
  return { patch, ir, config };
}

describe('extract: syntactic mode UNKNOWN discipline', () => {
  it('produces zero semantic relationships from names alone', async () => {
    const { patch, ir } = await extractOf({
      'Repo.sol': SYNTAX_SRC,
      'Broken.sol': SEMANTIC_BROKEN,
    });
    expect(ir.fidelity).toBe('syntactic');
    expect(patch.relationships.filter((rel) => ['CALLS', 'READS', 'WRITES', 'IMPLEMENTS', 'INHERITS'].includes(rel.type))).toEqual([]);
    expect(patch.facts.length).toBeGreaterThan(0);
    expect(patch.facts.every((fact) => String(fact.value ?? '').startsWith('unresolved-'))).toBe(true);
    for (const fact of patch.facts) {
      expect(fact.provenance[0]?.source_type).toBe('source_code');
      expect(fact.provenance[0]?.file).toBe('Repo.sol');
    }
  });

  it('marks syntactic call sites and surfaces storage, event, and error issues', async () => {
    const { patch } = await extractOf({
      'Repo.sol': SYNTAX_SRC,
      'Broken.sol': SEMANTIC_BROKEN,
    });
    const go = functionId(sourceContractId('Repo.sol', 'Synt'), 'go(address)');
    const markerValues = patch.facts
      .filter((fact) => fact.subject_id === go)
      .map((fact) => fact.value)
      .sort();
    expect(markerValues).toEqual([
      'unresolved-delegatecall',
      'unresolved-indirect-call',
      'unresolved-lowlevel-call',
    ]);
    const indirect = patch.facts.find(
      (fact) => fact.value === 'unresolved-indirect-call' && fact.subject_id === go,
    );
    expect(indirect?.provenance).toHaveLength(2);
    expect(
      patch.issues.find(
        (issue) => issue.code === 'unresolved_storage_access' && issue.file === 'Repo.sol',
      ),
    ).toMatchObject({ severity: 'UNKNOWN' });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_event_emit')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
    });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_custom_error')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
    });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_lowlevel_call')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
    });
    expect(patch.issues.find((issue) => issue.code === 'unresolved_delegatecall')).toMatchObject({
      severity: 'UNKNOWN',
      count: 1,
    });
  });
});

describe('extract: out-of-source call targets', () => {
  it('issues call_target_outside_sources and emits no edge', async () => {
    const { patch } = await extractOf(OUTSIDE_FILES, { excludes: ['lib/**'] });
    const childId = sourceContractId('main/Main.sol', 'Child');
    const goId = functionId(childId, 'go(address)');
    expect(patch.issues.find((issue) => issue.code === 'call_target_outside_sources')).toMatchObject({
      severity: 'UNKNOWN',
      file: 'main/Main.sol',
      count: 1,
    });
    expect(patch.relationships.filter((rel) => rel.source_id === goId)).toEqual([]);
    expect(patch.facts.filter((fact) => fact.subject_id === goId)).toEqual([]);
  });
});
