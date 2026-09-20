import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Client } = pg;
export const V4_MIGRATION_LOCK_ID = 741927401;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATION_DIR = join(HERE, '..', 'migrations', 'postgres');

export function migrationChecksum(sql) {
  if (typeof sql !== 'string') throw new TypeError('Migration SQL must be text.');
  return createHash('sha256').update(sql).digest('hex');
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

function untrackedSchemaError() {
  const error = new Error('Existing untracked schema detected. Back up the database and use the documented v3.2-to-v4 upgrade path; the fresh-install runner will not guess.');
  error.code = 'RMIG-E-TARGET-NOT-FRESH';
  return error;
}

function checksumError(file) {
  const error = new Error(`Checksum mismatch for applied migration ${file}`);
  error.code = 'RMIG-E-TARGET-SCHEMA';
  return error;
}

export async function applyV4Migrations({ client, migrations = [], lockId = V4_MIGRATION_LOCK_ID, onProgress = () => {} } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.');
  const immutable = Object.freeze([...migrations].map((migration) => {
    if (!migration || typeof migration.file !== 'string' || typeof migration.sql !== 'string') throw new TypeError('Migration entries must contain file and SQL text.');
    const checksum = migrationChecksum(migration.sql);
    if (migration.checksum !== undefined && migration.checksum !== checksum) throw new TypeError(`Migration checksum is not bound to ${migration.file}.`);
    return Object.freeze({ file: migration.file, sql: migration.sql, checksum });
  }));
  await client.query('SELECT pg_advisory_lock($1)', [lockId]);
  try {
    const state = await client.query(`
      SELECT
        to_regclass('public.schema_migrations') IS NOT NULL AS has_ledger,
        to_regclass('public.entities') IS NOT NULL AS has_entities
    `);
    if (!state.rows[0]?.has_ledger && state.rows[0]?.has_entities) throw untrackedSchemaError();

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = [];
    for (const migration of immutable) {
      const existing = await client.query('SELECT checksum FROM public.schema_migrations WHERE version = $1', [migration.file]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== migration.checksum) throw checksumError(migration.file);
        onProgress({ file: migration.file, status: 'already-applied', checksum: migration.checksum });
        applied.push({ ...migration, status: 'already-applied' });
        continue;
      }
      onProgress({ file: migration.file, status: 'applying', checksum: migration.checksum });
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)',
          [migration.file, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the migration error */ }
        throw error;
      }
      applied.push({ ...migration, status: 'applied' });
    }
    return Object.freeze(applied);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [lockId]); } catch { /* preserve the operation error */ }
  }
}

export function createV4MigrationRunner({
  connectionString,
  clientFactory = (value, config) => new Client({ connectionString: value, ...config }),
  migrationDir = DEFAULT_MIGRATION_DIR,
  migrations,
  lockId = V4_MIGRATION_LOCK_ID,
  ssl,
  onProgress,
} = {}) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) throw new TypeError('A PostgreSQL connection string is required.');
  let client;
  let connected = false;
  let loaded;
  async function getMigrations() {
    loaded ??= migrations === undefined
      ? readV4Migrations(migrationDir)
      : Promise.resolve(Object.freeze([...migrations].map((migration) => {
        if (!migration || typeof migration.file !== 'string' || typeof migration.sql !== 'string') throw new TypeError('Migration entries must contain file and SQL text.');
        const checksum = migrationChecksum(migration.sql);
        if (migration.checksum !== undefined && migration.checksum !== checksum) throw new TypeError(`Migration checksum is not bound to ${migration.file}.`);
        return Object.freeze({ file: migration.file, sql: migration.sql, checksum });
      })));
    return loaded;
  }
  return {
    async connect() {
      if (!client) client = clientFactory(connectionString, { ssl });
      if (!connected) { await client.connect(); connected = true; }
      return client;
    },
    async run() {
      const target = await this.connect();
      return applyV4Migrations({ client: target, migrations: await getMigrations(), lockId, onProgress });
    },
    async close() {
      if (client && connected) await client.end();
      connected = false;
    },
    get client() { return client; },
  };
}

async function main() {
  const connectionString = process.env.PG_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('PG_URL or DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  const ssl = process.env.PG_SSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const runner = createV4MigrationRunner({ connectionString, ssl, onProgress: ({ file, status }) => console.log(`${file} ${status}`) });
  try {
    await runner.run();
    console.log('Postgres migrations complete');
  } catch (error) {
    if (error?.code === 'RMIG-E-TARGET-NOT-FRESH') console.error(error.message);
    else console.error(error?.message ?? 'Postgres migration failed');
    process.exitCode = 1;
  } finally {
    await runner.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
