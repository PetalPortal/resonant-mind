import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURE_SQL = join(repo, 'tests', 'fixtures', 'migration', 'v3.2', 'postgres.sql');
export const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
export const hasAdminDatabase = typeof adminUrl === 'string' && adminUrl.length > 0;
export const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
let counter = 0;

export function urlFor(database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Runs `use(url)` against a scratch database that holds the tagged v3.2.0 PostgreSQL schema (and
 * whatever `seed(client)` adds), then drops it. The URL is handed to the callback only; callers put
 * it in an environment variable and never print it.
 */
export async function withScratchSource({ seed } = {}, use) {
  const database = `rmig_scratch_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let client;
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    const url = urlFor(database);
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(readFileSync(FIXTURE_SQL, 'utf8'));
    await seed?.(client);
    await client.end();
    client = undefined;
    return await use(url);
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}
