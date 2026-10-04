import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { ReconError, isReconError } from '../errors/errors.js';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function openDatabase(path: string): Database {
  const db = new BetterSqlite3(path);
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database, migrationsDir = DEFAULT_MIGRATIONS_DIR): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
  } catch (error) {
    throw new ReconError('MigrationError', 'migrations directory cannot be read', {
      migrationsDir,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const applied = new Map<string, string>();
  const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as {
    version: string;
    checksum: string;
  }[];
  for (const row of rows) {
    applied.set(row.version, row.checksum);
  }
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const checksum = sha256(sql);
    const prior = applied.get(file);
    if (prior !== undefined) {
      if (prior !== checksum) {
        throw new ReconError(
          'MigrationError',
          `migration ${file} changed after it was applied`,
          { version: file, expected: prior, received: checksum },
        );
      }
      continue;
    }
    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(file, file.replace(/\.sql$/, ''), checksum, new Date().toISOString());
      })();
    } catch (error) {
      if (isReconError(error)) throw error;
      throw new ReconError('MigrationError', `migration ${file} failed to apply`, {
        version: file,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
