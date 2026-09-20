import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { canonicalJson } from './v32-to-v4/lib/canonical-json.mjs';
import { canonicalSha256 } from './v32-to-v4/lib/hash.mjs';

const { Client } = pg;
export const V4_MIGRATION_LOCK_ID = 741927401;
export const V4_MIGRATOR_VERSION = '4.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATION_DIR = join(HERE, '..', 'migrations', 'postgres');

export function migrationChecksum(sql) {
  if (typeof sql !== 'string') throw new TypeError('Migration SQL must be text.');
  return createHash('sha256').update(sql).digest('hex');
}

export function migrationSetSha256(migrations = []) {
  return canonicalSha256([...migrations].map(({ file, checksum, sql }) => ({ file, checksum: checksum ?? migrationChecksum(sql) })).sort((a, b) => a.file.localeCompare(b.file)));
}

function normalizeMigrations(migrations) {
  return Object.freeze([...migrations].map((migration) => {
    if (!migration || typeof migration.file !== 'string' || typeof migration.sql !== 'string') throw new TypeError('Migration entries must contain file and SQL text.');
    const checksum = migrationChecksum(migration.sql);
    if (migration.checksum !== undefined && migration.checksum !== checksum) throw new TypeError(`Migration checksum is not bound to ${migration.file}.`);
    return Object.freeze({ file: migration.file, sql: migration.sql, checksum });
  }));
}

export async function readV4Migrations(migrationDir = DEFAULT_MIGRATION_DIR) {
  const names = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  const migrations = [];
  for (const file of names) {
    const sql = await readFile(join(migrationDir, file), 'utf8');
    migrations.push(Object.freeze({ file, sql, checksum: migrationChecksum(sql) }));
  }
  return Object.freeze(migrations);
}

function refusal(code, message) { const error = new Error(message); error.code = code; return error; }
function untrackedSchemaError() { return refusal('RMIG-E-TARGET-NOT-FRESH', 'Existing untracked schema detected. Back up the database and use the documented v3.2-to-v4 upgrade path; the fresh-install runner will not guess.'); }
function checksumError(file) { return refusal('RMIG-E-TARGET-SCHEMA', `Checksum mismatch for applied migration ${file}`); }
function ledgerDriftError(file) { return refusal('RMIG-E-TARGET-SCHEMA', `Unexpected applied migration ${file} is not in the current v4 ledger.`); }

async function readLedger(client) {
  const result = await client.query('SELECT version, checksum FROM public.schema_migrations ORDER BY version');
  return result.rows ?? [];
}

export async function applyV4Migrations({ client, migrations = [], lockId = V4_MIGRATION_LOCK_ID, onProgress = () => {}, atomic = false } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.');
  const immutable = normalizeMigrations(migrations);
  const expected = new Map(immutable.map((migration) => [migration.file, migration.checksum]));
  await client.query('SELECT pg_advisory_lock($1)', [lockId]);
  let transactionStarted = false;
  try {
    const state = await client.query(`
      SELECT
        to_regclass('public.schema_migrations') IS NOT NULL AS has_ledger,
        to_regclass('public.entities') IS NOT NULL AS has_entities
    `);
    if (!state.rows[0]?.has_ledger && state.rows[0]?.has_entities) throw untrackedSchemaError();
    if (atomic) { await client.query('BEGIN'); transactionStarted = true; }

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const existingRows = await readLedger(client);
    for (const row of existingRows) {
      const expectedChecksum = expected.get(row.version);
      if (expectedChecksum === undefined) throw ledgerDriftError(row.version);
      if (row.checksum !== expectedChecksum) throw checksumError(row.version);
    }
    const applied = [];
    try {
      for (const migration of immutable) {
        const existing = existingRows.find((row) => row.version === migration.file);
        if (existing) {
          onProgress({ file: migration.file, status: 'already-applied', checksum: migration.checksum });
          applied.push({ ...migration, status: 'already-applied' });
          continue;
        }
        onProgress({ file: migration.file, status: 'applying', checksum: migration.checksum });
        if (!atomic) { await client.query('BEGIN'); transactionStarted = true; }
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)', [migration.file, migration.checksum]);
          await client.query('COMMIT');
          transactionStarted = false;
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { /* preserve migration error */ }
          transactionStarted = false;
          throw error;
        }
        applied.push({ ...migration, status: 'applied' });
      }
      if (atomic) { await client.query('COMMIT'); transactionStarted = false; }
    } catch (error) {
      if (transactionStarted) { try { await client.query('ROLLBACK'); } catch { /* preserve migration error */ } transactionStarted = false; }
      throw error;
    }
    return Object.freeze(applied);
  } finally {
    if (transactionStarted) { try { await client.query('ROLLBACK'); } catch { /* preserve operation error */ } }
    try { await client.query('SELECT pg_advisory_unlock($1)', [lockId]); } catch { /* preserve operation error */ }
  }
}

export function createV4MigrationRunner({ connectionString, clientFactory = (value, config) => new Client({ connectionString: value, ...config }), migrationDir = DEFAULT_MIGRATION_DIR, migrations, lockId = V4_MIGRATION_LOCK_ID, ssl, onProgress } = {}) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) throw new TypeError('A PostgreSQL connection string is required.');
  let client; let connected = false; let loaded;
  async function getMigrations() {
    loaded ??= migrations === undefined ? readV4Migrations(migrationDir) : Promise.resolve(normalizeMigrations(migrations));
    return loaded;
  }
  return {
    async connect() { if (!client) client = clientFactory(connectionString, { ssl }); if (!connected) { await client.connect(); connected = true; } return client; },
    async run(options = {}) { const target = await this.connect(); return applyV4Migrations({ client: target, migrations: await getMigrations(), lockId, onProgress, ...options }); },
    async close() { if (client && connected) await client.end(); connected = false; },
    get client() { return client; },
    async metadata() { const list = await getMigrations(); return { migration_set_sha256: migrationSetSha256(list), migrator_version: V4_MIGRATOR_VERSION, migrations: list }; },
  };
}

async function main() {
  const connectionString = process.env.PG_URL || process.env.DATABASE_URL;
  if (!connectionString) { console.error('PG_URL or DATABASE_URL is required'); process.exitCode = 1; return; }
  const ssl = process.env.PG_SSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const runner = createV4MigrationRunner({ connectionString, ssl, onProgress: ({ file, status }) => console.log(`${file} ${status}`) });
  try { await runner.run(); console.log('Postgres migrations complete'); }
  catch (error) { if (error?.code === 'RMIG-E-TARGET-NOT-FRESH') console.error(error.message); else console.error(error?.message ?? 'Postgres migration failed'); process.exitCode = 1; }
  finally { await runner.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
