import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../../src/repository/migrate.js';
import { SqliteReconRepository } from '../../src/repository/sqlite.js';
import { parseReconConfig, type ReconConfig } from '../../src/recon/config.js';
import { analyzeProject, type AnalysisResult } from '../../src/recon/index.js';
import { serializeReconState } from '../../src/recon-state/state.js';

const VAULT_ROOT = fileURLToPath(new URL('../../fixtures/solidity/vault', import.meta.url));

function vaultConfig(): ReconConfig {
  return parseReconConfig({
    root: VAULT_ROOT,
    recordGit: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    projectName: 'idempotency',
  });
}

function rowCounts(db: Database): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number };
    counts[table.name] = row.n;
  }
  return counts;
}

describe('persistence idempotency', () => {
  let result: AnalysisResult;
  let db: Database;
  let repo: SqliteReconRepository;
  let dbPath: string;

  beforeAll(async () => {
    result = await analyzeProject(vaultConfig());
    const dir = mkdtempSync(join(tmpdir(), 'recon-idem-'));
    dbPath = join(dir, 'recon.db');
    db = openDatabase(dbPath);
    runMigrations(db);
    repo = new SqliteReconRepository(db);
  });

  it('keeps row counts unchanged when the analyzed state is saved twice', async () => {
    expect(result.state.facts.length).toBeGreaterThan(0);
    expect(result.state.relationships.length).toBeGreaterThan(0);

    await repo.saveState(result.state);
    const afterFirst = rowCounts(db);
    expect(afterFirst.facts).toBeGreaterThan(0);
    expect(afterFirst.relationships).toBeGreaterThan(0);

    await repo.saveState(result.state);
    const afterSecond = rowCounts(db);

    expect(afterSecond).toEqual(afterFirst);
  });

  it('reloads the analyzed state with a byte-identical serialization', async () => {
    const loaded = await repo.loadState();
    expect(loaded).not.toBeNull();
    expect(serializeReconState(loaded!)).toBe(serializeReconState(result.state));
  });
});
