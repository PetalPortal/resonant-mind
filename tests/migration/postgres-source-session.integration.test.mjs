import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { POSTGRES_CATALOG_QUERIES, createPostgresV32Adapter } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { adminUrl, hasAdminDatabase, quoteIdentifier, withScratchSource } from './helpers/postgres-scratch.mjs';

const { Client } = pg;

const SEED = `
INSERT INTO entities (id, name, entity_type, created_at, updated_at) VALUES
  (1, 'Session One', 'person', '2026-01-02 03:04:05.123456+00', '2026-01-03 03:04:05+00'),
  (2, 'Session Two', 'concept', '2026-02-01 12:00:00+01', NULL);
INSERT INTO observations (id, entity_id, content, added_at, valid_until, novelty_score) VALUES
  (1, 1, 'text', '2026-01-02 04:00:00.987654+00', '2026-12-31 23:59:59.5-05', 0.1),
  (2, 1, 'more', '2026-06-30 23:30:00+14', NULL, 0.3333333);
INSERT INTO identity (id, section, content, weight, connections, timestamp) VALUES (1, 'core.values', 'x', 0.5, '[]', '2026-03-04 05:06:07.000001+00');
INSERT INTO embeddings (id, source_type, source_id, embedding, content, metadata) VALUES ('e1', 'observation', 1, NULL, 'x', '{"a":  1, "b": [1,2]}');
`;

async function readEverything(url) {
  const adapter = createPostgresV32Adapter({ source: 'env:RMIG_SESSION_IT', env: { RMIG_SESSION_IT: url }, batchSize: 1 });
  try {
    await adapter.beginSnapshot();
    const catalog = await adapter.catalog();
    const rows = {};
    for (const table of catalog.tables) {
      rows[table.name] = [];
      for await (const row of adapter.streamTable(table.name, table.primary_key)) rows[table.name].push(row);
    }
    return { catalog, rows, counts: Object.fromEntries(await Promise.all(catalog.tables.map(async ({ name }) => [name, await adapter.rowCount(name)]))) };
  } finally {
    await adapter.endSnapshot();
    await adapter.close();
  }
}

describe.skipIf(!hasAdminDatabase)('PostgreSQL source reads do not depend on the session defaults (TEST_ADMIN_DATABASE_URL)', () => {
  it('yields the identical catalog and identical row text when the database defaults differ', async () => {
    await withScratchSource({ seed: (client) => client.query(SEED) }, async (url) => {
      const database = new URL(url).pathname.slice(1);
      const before = await readEverything(url);
      expect(before.rows.entities).toHaveLength(2);
      expect(before.rows.entities[0].created_at).toBe('2026-01-02T03:04:05.123456Z');
      expect(before.rows.observations[1].added_at).toBe('2026-06-30T09:30:00Z');
      expect(before.rows.observations[1].novelty_score).toBe(0.3333333);

      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        // A search_path without public, a time zone that is not UTC, a date style that is not ISO and a
        // float setting that prints fewer digits: each one changes what an unprotected read would see.
        await admin.query(`ALTER DATABASE ${quoteIdentifier(database)} SET search_path = pg_catalog`);
        await admin.query(`ALTER DATABASE ${quoteIdentifier(database)} SET TimeZone = 'Asia/Kolkata'`);
        await admin.query(`ALTER DATABASE ${quoteIdentifier(database)} SET DateStyle = 'SQL, DMY'`);
        await admin.query(`ALTER DATABASE ${quoteIdentifier(database)} SET extra_float_digits = -3`);
      } finally {
        await admin.end();
      }

      // Prove the changed defaults are real and would have changed the answer: an unprotected client sees them.
      const raw = new Client({ connectionString: url });
      await raw.connect();
      try {
        const settings = (await raw.query("SELECT current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds, current_setting('search_path') AS sp, current_setting('extra_float_digits') AS efd")).rows[0];
        expect(settings).toEqual({ tz: 'Asia/Kolkata', ds: 'SQL, DMY', sp: 'pg_catalog', efd: '-3' });
        expect((await raw.query('SELECT added_at::text AS t FROM public.observations WHERE id = 1')).rows[0].t).not.toBe('2026-01-02 04:00:00.987654+00');
        expect((await raw.query('SELECT novelty_score::text AS n FROM public.observations WHERE id = 2')).rows[0].n).not.toBe('0.3333333');
        const unprotectedDefaults = (await raw.query(POSTGRES_CATALOG_QUERIES.columns, ['public'])).rows.map((row) => row.column_default).filter((value) => typeof value === 'string' && value.includes('nextval'));
        expect(unprotectedDefaults.length).toBeGreaterThan(0);
        expect(unprotectedDefaults.every((value) => value.includes("'public."))).toBe(true);
      } finally {
        await raw.end();
      }

      const after = await readEverything(url);
      expect(canonicalSha256(after.catalog)).toBe(canonicalSha256(before.catalog));
      expect(after.catalog).toEqual(before.catalog);
      expect(after.rows).toEqual(before.rows);
      expect(after.counts).toEqual(before.counts);
      expect(canonicalSha256(after.rows)).toBe(canonicalSha256(before.rows));
      // and the connection was not left holding the settings it used
      const reread = new Client({ connectionString: url });
      await reread.connect();
      try { expect((await reread.query("SELECT current_setting('TimeZone') AS tz")).rows[0].tz).toBe('Asia/Kolkata'); } finally { await reread.end(); }
    });
  }, 120_000);
});
