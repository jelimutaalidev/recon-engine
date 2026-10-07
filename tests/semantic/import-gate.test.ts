import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_SEMANTIC = fileURLToPath(new URL('../../src/semantic', import.meta.url));
const SRC_ROOT = resolve(SRC_SEMANTIC, '..');

const ALLOWED_SPECIFIERS = new Set(['zod', 'node:crypto']);
const FORBIDDEN_SUBSTRINGS = [
  'http',
  'fetch(',
  'eval(',
  'require(',
  'Function(',
  'child_process',
  'node:net',
  'writeFile',
  'appendFile',
  'import(',
  'recon/ir',
];

const BARREL_MODULES = [
  'model',
  'ids',
  'evidence',
  'transitions',
  'custody',
  'accounting',
  'authority',
  'trust',
  'ladder',
  'derive',
  'validate',
  'report',
  'analyze',
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files.sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s*|import\s*)(['"])([^'"]+)\1/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const specifier = match[2];
    if (specifier !== undefined) specifiers.push(specifier);
    match = pattern.exec(source);
  }
  return specifiers;
}

function scanFile(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const relative = file.slice(SRC_ROOT.length + 1);
  const violations: string[] = [];

  for (const token of FORBIDDEN_SUBSTRINGS) {
    if (source.includes(token)) violations.push(`${relative}: forbidden token "${token}"`);
  }
  if (/\bimport\s*\(/.test(source)) violations.push(`${relative}: dynamic import()`);

  for (const specifier of importSpecifiers(source)) {
    if (ALLOWED_SPECIFIERS.has(specifier)) continue;
    if (specifier.startsWith('.')) {
      const resolvedSpecifier = resolve(dirname(file), specifier);
      if (resolvedSpecifier === SRC_ROOT || resolvedSpecifier.startsWith(SRC_ROOT + sep)) continue;
      violations.push(`${relative}: relative specifier escapes src/: ${specifier}`);
      continue;
    }
    violations.push(`${relative}: specifier outside allowlist: ${specifier}`);
  }
  return violations;
}

describe('static import gate (semantic)', () => {
  it('static import gate: src/semantic imports only the allowlist', () => {
    const files = listSourceFiles(SRC_SEMANTIC);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith('index.ts'))).toBe(true);
    const violations = files.flatMap((file) => scanFile(file));
    expect(violations).toEqual([]);
  });

  it('barrel re-exports every §4.2 module', () => {
    const barrel = readFileSync(join(SRC_SEMANTIC, 'index.ts'), 'utf8');
    for (const moduleName of BARREL_MODULES) {
      expect(barrel).toContain(`export * from './${moduleName}.js'`);
    }
  });
});
