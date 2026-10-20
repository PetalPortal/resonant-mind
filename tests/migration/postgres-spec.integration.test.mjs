import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { SPEC_PATH, generatePostgresSpec, readVerifiedFixture } from '../../scripts/v32-to-v4/spec/generate-postgres-spec.mjs';
import { compareCatalog, sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { createPostgresV32Adapter } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';

const { Client } = pg;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const hasAdmin = typeof adminUrl === 'string' && adminUrl.length > 0;
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
let counter = 0;

/** A scratch database holding the tagged v3.2.0 PostgreSQL schema, optionally altered, dropped afterwards. */
async function withFixtureDatabase(prepare, inspect) {
  const database = `rmig_specit_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let client;
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(readVerifiedFixture().sql);
    await prepare?.(client, admin, database);
    await client.end();
    client = undefined;
    const adapter = createPostgresV32Adapter({ source: 'env:RMIG_SPEC_IT_URL', env: { RMIG_SPEC_IT_URL: url.toString() } });
    try {
      await adapter.beginSnapshot();
      return await inspect(await adapter.catalog());
    } finally {
      await adapter.endSnapshot().catch(() => {});
      await adapter.close();
    }
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

describe.skipIf(!hasAdmin)('PostgreSQL v3.2 fingerprint against a live catalog (TEST_ADMIN_DATABASE_URL)', () => {
  it('the committed v3.2-postgres.json is exactly what the tagged fixture yields on this PostgreSQL', async () => {
    const generated = await generatePostgresSpec({ adminUrl });
    expect(readFileSync(SPEC_PATH, 'utf8').replaceAll('\r\n', '\n')).toBe(generated.text);
    expect(generated.extensions).toHaveProperty('vector');
  }, 60_000);

  it('accepts the fixture schema and does not depend on the role or database search_path', async () => {
    const expected = sourceSpecFor('postgres');
    await withFixtureDatabase(null, (catalog) => expect(compareCatalog(catalog, expected).match).toBe(true));
    await withFixtureDatabase(
      (_client, admin, database) => admin.query(`ALTER DATABASE ${quoteIdentifier(database)} SET search_path = pg_catalog`),
      (catalog) => expect(compareCatalog(catalog, expected).diff).toEqual([]),
    );
  }, 60_000);

  it.each([
    ['an extra column', 'ALTER TABLE entities ADD COLUMN stray text'],
    ['a missing default', 'ALTER TABLE threads ALTER COLUMN status DROP DEFAULT'],
    ['a changed default', "ALTER TABLE threads ALTER COLUMN status SET DEFAULT 'open'"],
    ['a changed type', 'ALTER TABLE relations ALTER COLUMN from_context TYPE varchar(40)'],
    ['an added check', 'ALTER TABLE observations ADD CONSTRAINT stray_check CHECK (sit_count >= 0)'],
    ['a foreign key that sets null instead of cascading', 'ALTER TABLE observation_versions DROP CONSTRAINT observation_versions_observation_id_fkey, ADD CONSTRAINT observation_versions_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE SET NULL'],
    ['a foreign key that restricts instead of cascading', 'ALTER TABLE observation_versions DROP CONSTRAINT observation_versions_observation_id_fkey, ADD CONSTRAINT observation_versions_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE RESTRICT'],
    ['a renamed index', 'ALTER INDEX idx_threads_status RENAME TO idx_threads_state'],
    ['a renamed primary key', 'ALTER INDEX entities_pkey RENAME TO entities_key_pk'],
    ['a dropped unique constraint', 'ALTER TABLE entities DROP CONSTRAINT entities_name_primary_context_key'],
    ['a changed vector dimension', 'ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(1536)'],
    ['an extra table', 'CREATE TABLE stray (id integer PRIMARY KEY)'],
  ])('refuses %s', async (_label, statement) => {
    const expected = sourceSpecFor('postgres');
    await withFixtureDatabase((client) => client.query(statement), (catalog) => {
      const comparison = compareCatalog(catalog, expected);
      expect(comparison.match).toBe(false);
      expect(comparison.diff.length).toBeGreaterThan(0);
    });
  }, 60_000);
});
