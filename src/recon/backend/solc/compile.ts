import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import solc from 'solc';
import { ReconError } from '../../../errors/errors.js';
import type { ReconConfig } from '../../config.js';
import type { DiscoveredFile } from '../../discover.js';
import { createReconIssue, sortIssues, type ReconIssue } from '../../issues.js';
import {
  longVersionFromBuildPath,
  parsePragmas,
  selectVersion,
  verifyChecksum,
  type VersionSelection,
} from './versions.js';

export type Fidelity = 'semantic' | 'syntactic';

export interface SolcSourceLocation {
  file?: string | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

export interface SolcErrorEntry {
  severity?: string | undefined;
  message?: string | undefined;
  sourceLocation?: SolcSourceLocation | undefined;
}

export interface SolcStorageEntry {
  astId?: number | undefined;
  label?: string | undefined;
  slot?: string | undefined;
  offset?: number | undefined;
  type?: string | undefined;
}

export interface SolcContractArtifact {
  evm?: { methodIdentifiers?: Record<string, string> } | undefined;
  storageLayout?: { storage?: SolcStorageEntry[] } | undefined;
}

export interface SolcAstNode {
  nodeType?: string | undefined;
  src?: string | undefined;
  id?: number | undefined;
  [key: string]: unknown;
}

export interface SolcStandardOutput {
  errors?: SolcErrorEntry[] | undefined;
  sources?: Record<string, { id?: number | undefined; ast?: SolcAstNode | undefined }> | undefined;
  contracts?: Record<string, Record<string, SolcContractArtifact>> | undefined;
}

export interface CompileProjectResult {
  output: SolcStandardOutput;
  contents: Map<string, string>;
  fidelity: Fidelity;
  longVersion: string;
  issues: ReconIssue[];
  dropped: string[];
}

interface SolcCompiler {
  compile(input: string, options?: { import?: (path: string) => { contents?: string; error?: string } }): string;
}

export interface ReleaseBuild {
  path?: string | undefined;
  version?: string | undefined;
  longVersion?: string | undefined;
  sha256?: string | undefined;
}

export interface ReleaseList {
  releases: Record<string, string>;
  builds?: ReleaseBuild[] | undefined;
}

export interface VersionPlan {
  selection: VersionSelection;
  longVersion: string;
  issues: ReconIssue[];
  releaseList: ReleaseList | undefined;
}

const SOLC_BIN_BASE = 'https://binaries.soliditylang.org/bin';
const SOLC_LIST_URL = `${SOLC_BIN_BASE}/list.json`;
const MAX_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const require = createRequire(import.meta.url);

function cacheRoot(config: ReconConfig): string {
  return join(resolve(config.root), '.recon-cache', 'solc');
}

function binDir(config: ReconConfig): string {
  return join(cacheRoot(config), 'bin');
}

function readCachedShortVersions(directory: string): string[] {
  try {
    const versions = new Set<string>();
    for (const name of readdirSync(directory)) {
      const match = /^soljson-v(\d+\.\d+\.\d+)\+/.exec(name);
      if (match?.[1] !== undefined) versions.add(match[1]);
    }
    return [...versions];
  } catch {
    return [];
  }
}

function readCachedReleaseList(directory: string): ReleaseList | undefined {
  try {
    const raw = readFileSync(join(directory, 'list.json'), 'utf8');
    const parsed = JSON.parse(raw) as ReleaseList;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.releases !== 'object') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function httpsFetch(url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsGet(url, { timeout: timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error(`unexpected redirect fetching ${url}`));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          request.destroy(new Error(`response exceeds size limit fetching ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolvePromise(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`timeout fetching ${url}`)));
    request.on('error', reject);
  });
}

async function fetchReleaseList(timeoutMs: number): Promise<ReleaseList> {
  const bytes = await httpsFetch(SOLC_LIST_URL, timeoutMs);
  const parsed = JSON.parse(bytes.toString('utf8')) as ReleaseList;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.releases !== 'object') {
    throw new Error('malformed solidity release index');
  }
  return parsed;
}

function findCachedBuildFile(directory: string, shortVersion: string): string | undefined {
  try {
    return readdirSync(directory).find((name) => name.startsWith(`soljson-v${shortVersion}+`));
  } catch {
    return undefined;
  }
}

function resolveLongVersion(
  config: ReconConfig,
  selection: VersionSelection,
  bundledFull: string,
  list: ReleaseList | undefined,
): string {
  if (selection.source === 'bundled') return bundledFull;
  if (selection.source === 'cache') {
    const fileName = findCachedBuildFile(binDir(config), selection.shortVersion);
    return fileName !== undefined ? longVersionFromBuildPath(fileName) : selection.shortVersion;
  }
  const build = list?.builds?.find((entry) => entry.version === selection.shortVersion);
  if (build?.longVersion !== undefined) return build.longVersion;
  if (build?.path !== undefined) return longVersionFromBuildPath(build.path);
  return selection.shortVersion;
}

export async function planVersion(
  config: ReconConfig,
  pragmas: readonly string[],
): Promise<VersionPlan> {
  const bundledFull = solc.version();
  const bundledShort = bundledFull.split('+')[0] ?? bundledFull;
  const cache = cacheRoot(config);
  const cached = readCachedShortVersions(binDir(config));
  const issues: ReconIssue[] = [];

  let releaseList = readCachedReleaseList(cache);
  let released: readonly string[] = releaseList !== undefined ? Object.keys(releaseList.releases) : [];

  let selection: VersionSelection;
  try {
    selection = selectVersion(config, pragmas, { bundled: bundledShort, cached, released });
  } catch (error) {
    const recoverable =
      error instanceof ReconError &&
      (error.code === 'VersionConflict' || error.code === 'CompilerUnavailable') &&
      config.compilerSource === 'auto';
    if (!recoverable) throw error;
    let fetched: ReleaseList;
    try {
      fetched = await fetchReleaseList(config.limits.timeoutMs);
    } catch {
      issues.push(
        createReconIssue({
          severity: 'RECOVERABLE',
          code: 'release_index_unavailable',
          message: 'solidity release index unavailable; relying on bundled/cached compilers only',
        }),
      );
      throw error;
    }
    releaseList = fetched;
    released = Object.keys(fetched.releases);
    selection = selectVersion(config, pragmas, { bundled: bundledShort, cached, released });
    try {
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, 'list.json'), JSON.stringify(fetched));
    } catch {
      // cache is best effort
    }
  }

  return {
    selection,
    longVersion: resolveLongVersion(config, selection, bundledFull, releaseList),
    issues,
    releaseList,
  };
}

function wrapSoljson(filePath: string): SolcCompiler {
  const soljson = require(filePath) as unknown;
  return solc.setupMethods(soljson);
}

async function loadCompiler(config: ReconConfig, plan: VersionPlan): Promise<SolcCompiler> {
  const { selection } = plan;
  if (selection.source === 'bundled') return solc;

  const filePath = join(binDir(config), `soljson-v${plan.longVersion}.js`);
  const build = plan.releaseList?.builds?.find(
    (entry) => entry.path !== undefined && longVersionFromBuildPath(entry.path) === plan.longVersion,
  );

  if (selection.source === 'cache') {
    if (!existsSync(filePath)) {
      throw new ReconError('CompilerUnavailable', `cached compiler ${plan.longVersion} is missing`, {
        file: filePath,
      });
    }
    if (build?.sha256 !== undefined) {
      const bytes = readFileSync(filePath);
      if (!verifyChecksum(build.sha256, bytes)) {
        throw new ReconError(
          'ChecksumMismatch',
          `cached compiler ${plan.longVersion} failed checksum verification`,
          { version: plan.longVersion },
        );
      }
    }
    return wrapSoljson(filePath);
  }

  if (build === undefined || build.path === undefined) {
    throw new ReconError(
      'CompilerUnavailable',
      `no release metadata for solidity ${selection.shortVersion}`,
      { version: selection.shortVersion },
    );
  }
  if (build.sha256 === undefined) {
    throw new ReconError(
      'ChecksumMismatch',
      `release ${plan.longVersion} has no published sha256 checksum`,
      { version: plan.longVersion },
    );
  }
  const bytes = await httpsFetch(`${SOLC_BIN_BASE}/${build.path}`, config.limits.timeoutMs);
  if (!verifyChecksum(build.sha256, bytes)) {
    throw new ReconError(
      'ChecksumMismatch',
      `downloaded compiler ${plan.longVersion} failed checksum verification`,
      { version: plan.longVersion },
    );
  }
  mkdirSync(binDir(config), { recursive: true });
  writeFileSync(filePath, bytes);
  return wrapSoljson(filePath);
}

const IMPORT_PATTERN = /\bimport\s+(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']/g;

function applyRemapping(spec: string, remappings: readonly string[]): string {
  for (const remapping of remappings) {
    const equals = remapping.indexOf('=');
    if (equals <= 0) continue;
    const left = remapping.slice(0, equals);
    const right = remapping.slice(equals + 1);
    const colon = left.lastIndexOf(':');
    const prefix = colon >= 0 ? left.slice(colon + 1) : left;
    if (prefix.length > 0 && spec.startsWith(prefix)) return right + spec.slice(prefix.length);
  }
  return spec;
}

function isInside(rootReal: string, target: string): boolean {
  const base = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return target === rootReal || target.startsWith(base);
}

function assertImportsStayInsideRoot(
  config: ReconConfig,
  contents: Map<string, string>,
  rootReal: string,
): void {
  for (const [path, text] of contents) {
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const rawSpec = match[1];
      if (rawSpec === undefined || rawSpec.length === 0) continue;
      const spec = applyRemapping(rawSpec, config.remappings);
      const base = dirname(join(rootReal, path));
      const candidate = spec.startsWith('.') ? resolve(base, spec) : resolve(rootReal, spec);
      let real: string;
      try {
        if (!existsSync(candidate)) continue;
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (!isInside(rootReal, real)) {
        throw new ReconError(
          'RootEscape',
          `import "${rawSpec}" in ${path} resolves outside the analysis root`,
          { file: path, import: rawSpec, resolved: real },
        );
      }
    }
  }
}

function lineAt(text: string, byteOffset: number): number {
  const bytes = Buffer.from(text, 'utf8');
  const limit = Math.min(Math.max(byteOffset, 0), bytes.length);
  let line = 1;
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0x0a) line += 1;
  }
  return line;
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failedFiles(errors: readonly SolcErrorEntry[], activePaths: readonly string[]): string[] {
  const active = new Set(activePaths);
  const failed = new Set<string>();
  for (const error of errors) {
    const file = error.sourceLocation?.file;
    if (file !== undefined && active.has(file)) failed.add(file);
  }
  return [...failed].sort(codepointCompare);
}

export async function compileProject(
  config: ReconConfig,
  files: readonly DiscoveredFile[],
): Promise<CompileProjectResult> {
  const rootReal = realpathSync(resolve(config.root));
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const activePaths = [...files.map((file) => file.path)].sort(codepointCompare);

  const contents = new Map<string, string>();
  for (const path of activePaths) {
    const file = byPath.get(path);
    if (file === undefined) continue;
    contents.set(path, readFileSync(file.absolute, 'utf8'));
  }

  assertImportsStayInsideRoot(config, contents, rootReal);

  const pragmas = activePaths.flatMap((path) => parsePragmas(contents.get(path) ?? ''));
  const plan = await planVersion(config, pragmas);
  const compiler = await loadCompiler(config, plan);

  const importCallback = (importPath: string): { contents?: string; error?: string } => {
    const candidate = resolve(rootReal, importPath);
    if (!existsSync(candidate)) return { error: `source not found: ${importPath}` };
    const real = realpathSync(candidate);
    if (!isInside(rootReal, real)) {
      throw new ReconError(
        'RootEscape',
        `import callback refused path outside the analysis root: ${importPath}`,
        { import: importPath, resolved: real },
      );
    }
    const key = relative(rootReal, real).split(sep).join('/');
    const existing = contents.get(key);
    if (existing !== undefined) return { contents: existing };
    const text = readFileSync(real, 'utf8');
    contents.set(key, text);
    return { contents: text };
  };

  const issues: ReconIssue[] = [...plan.issues];
  const seen = new Set(issues.map((issue) => JSON.stringify(issue)));
  const pushIssue = (raw: unknown): void => {
    const issue = createReconIssue(raw);
    const key = JSON.stringify(issue);
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };

  let livePaths = activePaths;
  let fidelity: Fidelity = 'semantic';
  const dropped: string[] = [];

  for (;;) {
    const input = JSON.stringify({
      language: 'Solidity',
      sources: Object.fromEntries(
        livePaths.map((path) => [path, { content: contents.get(path) ?? '' }]),
      ),
      settings: {
        ...(fidelity === 'syntactic' ? { stopAfter: 'parsing' } : {}),
        ...(config.remappings.length > 0 ? { remappings: [...config.remappings] } : {}),
        outputSelection:
          fidelity === 'semantic'
            ? { '*': { '': ['ast'], '*': ['storageLayout', 'evm.methodIdentifiers'] } }
            : { '*': { '': ['ast'] } },
      },
    });

    let output: SolcStandardOutput;
    try {
      const raw = compiler.compile(input, { import: importCallback });
      output = JSON.parse(raw) as SolcStandardOutput;
    } catch (error) {
      if (error instanceof ReconError) throw error;
      throw new ReconError('CompilationFailed', `solidity compiler failed: ${String(error)}`, {
        issues: [...issues],
        dropped: [...dropped],
      });
    }

    const fatal = (output.errors ?? []).filter((error) => error.severity === 'error');
    if (fatal.length === 0) {
      return {
        output,
        contents,
        fidelity,
        longVersion: plan.longVersion,
        issues: sortIssues(issues),
        dropped: [...dropped].sort(codepointCompare),
      };
    }

    if (fidelity === 'semantic') {
      fidelity = 'syntactic';
      for (const file of failedFiles(fatal, livePaths)) {
        pushIssue({
          severity: 'RECOVERABLE',
          code: 'syntactic_fallback',
          file,
          message: `semantic compilation failed for ${file}; analysing its syntax only`,
        });
      }
      continue;
    }

    const failing = failedFiles(fatal, livePaths);
    const unlocated = fatal.some(
      (error) =>
        error.sourceLocation?.file === undefined ||
        error.sourceLocation.start === undefined ||
        error.sourceLocation.start < 0,
    );
    if (failing.length === 0 || unlocated) {
      throw new ReconError(
        'CompilationFailed',
        `solidity compilation failed: ${fatal[0]?.message ?? 'unknown compiler error'}`,
        { issues: [...issues], dropped: [...dropped] },
      );
    }

    for (const file of failing) {
      const first = fatal.find((error) => error.sourceLocation?.file === file);
      const start = first?.sourceLocation?.start ?? -1;
      const text = contents.get(file) ?? '';
      pushIssue({
        severity: 'RECOVERABLE',
        code: 'compilation_failed',
        file,
        ...(start >= 0 ? { line_start: lineAt(text, start) } : {}),
        message: `dropping ${file}: ${first?.message ?? 'syntax errors prevent parsing'}`,
      });
      dropped.push(file);
    }
    livePaths = livePaths.filter((path) => !failing.includes(path));

    if (livePaths.length === 0) {
      throw new ReconError('CompilationFailed', 'no source survived compilation', {
        issues: [...issues],
        dropped: [...dropped],
      });
    }
    fidelity = 'semantic';
  }
}
