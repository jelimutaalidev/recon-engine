import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseReconConfig } from '../../src/recon/config.js';
import { analyzeProject } from '../../src/recon/index.js';
import { ERC20_PINS } from '../../src/semantic/pins.js';

// OD-8 (spec §18): pins are grounded ONLY in corpus ABI evidence observed via
// analyzeProject — never from general knowledge. This suite is the evidence
// gate: every entry of every pin list in src/semantic/pins.ts must be observed
// in >=1 corpus analysis, and ERC20_PINS (spec §7 C2) must be covered.
//
// state_output_hash root-independence is intentionally NOT asserted here
// (Task 11/13 own that); this suite only feeds pin evidence.

const ANALYSIS_TIMEOUT_MS = 120_000; // Phase 3 golden timeout precedent
const TIMESTAMP = '2026-01-01T00:00:00Z';
const PROJECT_NAME = 'pins';

const SEMANTIC_CORPORA = [
  'lending',
  'staking',
  'amm',
  'oracle',
  'proxy',
  'roles',
  'callback',
  'ambiguous',
] as const;
const CORPORA: readonly string[] = [...SEMANTIC_CORPORA, 'vault'];

function corpusRoot(corpus: string): string {
  const relative = (SEMANTIC_CORPORA as readonly string[]).includes(corpus)
    ? `semantics/${corpus}`
    : corpus;
  return fileURLToPath(new URL(`../../fixtures/solidity/${relative}`, import.meta.url));
}

interface Observation {
  corpus: string;
  contract: string;
  contractType: string;
  sourceFile: string;
}

// signature -> every (corpus, contract) where an in-scope ABI declares it.
// Interface/base declarations surface in state.functions under their own
// contract_id, so collecting state.functions covers spec §7 C2's
// "in-scope interface/base ABI" evidence.
const observed = new Map<string, Observation[]>();

function recordObservations(
  corpus: string,
  state: Awaited<ReturnType<typeof analyzeProject>>['state'],
): void {
  const contracts = new Map(state.contracts.map((c) => [c.id, c]));
  for (const fn of state.functions) {
    const contract = contracts.get(fn.contract_id);
    const observation: Observation = {
      corpus,
      contract: contract?.name ?? fn.contract_id,
      contractType: contract?.contract_type ?? 'unknown',
      sourceFile: contract?.source_file ?? 'unknown',
    };
    const forSignature = observed.get(fn.signature);
    if (forSignature === undefined) {
      observed.set(fn.signature, [observation]);
    } else {
      forSignature.push(observation);
    }
  }
}

describe('OD-8 corpus evidence intake (per-corpus analysis, 120s each)', () => {
  for (const corpus of CORPORA) {
    it(
      `analyzes the ${corpus} corpus and records observed signatures`,
      async () => {
        const config = parseReconConfig({
          root: corpusRoot(corpus),
          recordGit: false,
          projectName: PROJECT_NAME,
          timestamp: TIMESTAMP,
        });
        const { state } = await analyzeProject(config);
        expect(state.functions.length).toBeGreaterThan(0);
        recordObservations(corpus, state);
      },
      ANALYSIS_TIMEOUT_MS,
    );
  }
});

// Pin-list registry: every pin-list export of src/semantic/pins.ts must appear
// here so the evidence loop below covers it. The registry-coverage test parses
// pins.ts and fails if a pin list is declared there without being registered
// (or registered without existing), so a future pin list cannot bypass OD-8.
interface PinListBinding {
  listName: string;
  pins: readonly string[];
}

const PIN_LISTS: readonly PinListBinding[] = [
  { listName: 'ERC20_PINS', pins: ERC20_PINS },
];

const PINS_MODULE_PATH = fileURLToPath(new URL('../../src/semantic/pins.ts', import.meta.url));

describe('OD-8 pin evidence gate', () => {
  it('registry covers every pin list declared in pins.ts', () => {
    const source = readFileSync(PINS_MODULE_PATH, 'utf8');
    const declared = [...source.matchAll(/\bconst (\w+): readonly string\[\]/g)].map((m) => m[1]);
    const exported = [...source.matchAll(/\bexport const (\w+): readonly string\[\]/g)].map(
      (m) => m[1],
    );
    const registered = PIN_LISTS.map((binding) => binding.listName);
    // No unexported pin list may hide in pins.ts, and every exported pin list
    // must be registered above (and vice versa).
    expect([...declared].sort(), 'pin lists declared in pins.ts').toEqual(
      [...exported].sort(),
    );
    expect([...exported].sort(), 'pin lists registered for the OD-8 gate').toEqual(
      [...registered].sort(),
    );
  });

  it('ERC20_PINS is a subset of signatures observed across corpora', () => {
    for (const pin of ERC20_PINS) {
      expect(
        observed.has(pin),
        `ERC20_PINS entry "${pin}" was not observed in any corpus analysis (OD-8)`,
      ).toBe(true);
    }
  });

  it('every entry of every pin list is observed in at least one corpus', () => {
    for (const binding of PIN_LISTS) {
      expect(
        binding.pins.length,
        `${binding.listName} must not be empty — a pin list without corpus grounding`,
      ).toBeGreaterThan(0);
      for (const pin of binding.pins) {
        const sources = observed.get(pin) ?? [];
        expect(
          sources.length,
          `${binding.listName} pin "${pin}" has no corpus ABI evidence; pins may never exceed observed corpus signatures (OD-8)`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
