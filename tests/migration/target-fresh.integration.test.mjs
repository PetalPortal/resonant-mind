import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { inspectTarget } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { hasAdminDatabase, withScratchDatabase } from './helpers/postgres-scratch.mjs';

const { Client } = pg;
// inspectTarget only compares identities; any other source identity will do.
const OTHER_SOURCE = { database_identity_sha256: 'f'.repeat(64) };

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function inspectWith(url, setup) {
  const client = await connect(url);
  try {
    await setup?.(client);
    return await inspectTarget({ client, sourceIdentity: OTHER_SOURCE });
  } finally {
    await client.end();
  }
}

const refusalOf = (promise) => promise.then(() => { throw new Error('expected a refusal'); }, (error) => error);

describe.skipIf(!hasAdminDatabase)('the fresh-target check, live (TEST_ADMIN_DATABASE_URL)', () => {
  it('accepts a fresh target', async () => {
    await withScratchDatabase(async (url) => {
      const result = await inspectWith(url);
      expect(result).toMatchObject({ object_count: 0, pgvector: true, read_only_proven: true });
    });
  });

  it('accepts a fresh target that already has the vector extension, in public or in its own schema', async () => {
    await withScratchDatabase(async (url) => {
      expect(await inspectWith(url, (client) => client.query('CREATE EXTENSION vector'))).toMatchObject({ object_count: 0, pgvector: true });
    });
    await withScratchDatabase(async (url) => {
      const result = await inspectWith(url, async (client) => { await client.query('CREATE SCHEMA ext'); await client.query('CREATE EXTENSION vector SCHEMA ext'); });
      expect(result).toMatchObject({ object_count: 0, pgvector: true });
    });
  });

  it('refuses a target that holds a user table', async () => {
    await withScratchDatabase(async (url) => {
      const error = await refusalOf(inspectWith(url, (client) => client.query('CREATE TABLE public.leftover (id int)')));
      expect(error).toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
      expect(error.safe_details.object_count).toBe(1);
      expect(error.safe_details.objects).toEqual([{ schema: 'public', name: 'leftover', kind: 'relation' }]);
    });
  });

  it.each([
    ['a view', 'CREATE VIEW public.leftover AS SELECT 1 AS x'],
    ['a sequence', 'CREATE SEQUENCE public.leftover'],
    ['a function', 'CREATE FUNCTION public.leftover() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
    ['an enum type', "CREATE TYPE public.leftover AS ENUM ('a')"],
    ['a table in another schema', 'CREATE SCHEMA other; CREATE TABLE other.leftover (id int)'],
  ])('refuses a target that holds %s', async (_label, sql) => {
    await withScratchDatabase(async (url) => {
      const error = await refusalOf(inspectWith(url, (client) => client.query(sql)));
      expect(error).toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
    });
  });

  it('refuses a non-public schema even when it is empty', async () => {
    await withScratchDatabase(async (url) => {
      const error = await refusalOf(inspectWith(url, (client) => client.query('CREATE SCHEMA leftover_schema')));
      expect(error).toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
      expect(error.safe_details.schemas).toEqual(['leftover_schema']);
      expect(error.safe_details.object_count).toBe(0);
    });
  });

  it('refuses an extension that is not vector', async () => {
    await withScratchDatabase(async (url) => {
      const probe = await connect(url);
      let candidate;
      try {
        const available = (await probe.query("SELECT name FROM pg_catalog.pg_available_extensions WHERE name = ANY($1) ORDER BY name", [['pg_trgm', 'citext', 'hstore', 'btree_gin', 'fuzzystrmatch']])).rows;
        candidate = available[0]?.name;
      } finally { await probe.end(); }
      // A cluster without any contrib extension cannot show this case; that is reported, not skipped silently.
      expect(candidate, 'no contrib extension is available on this cluster to test with').toBeTruthy();
      const error = await refusalOf(inspectWith(url, (client) => client.query(`CREATE EXTENSION ${candidate}`)));
      expect(error).toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
      expect(error.safe_details.extensions).toEqual([candidate]);
    });
  });

  it('is not made to refuse by another session\'s temporary objects, but still sees real objects next to them', async () => {
    await withScratchDatabase(async (url) => {
      const other = await connect(url);
      try {
        await other.query('CREATE TEMP TABLE someone_elses_scratch (id int)');
        await other.query('CREATE TEMP SEQUENCE someone_elses_seq');
        await other.query('CREATE FUNCTION pg_temp.someone_elses_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
        const inspector = await connect(url);
        try {
          // the temporary schemas are really there, so this is not a vacuous pass
          const temps = (await inspector.query("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname ~ '^pg_(toast_)?temp_[0-9]+$'")).rows;
          expect(temps.length).toBeGreaterThan(0);
          expect(await inspectTarget({ client: inspector, sourceIdentity: OTHER_SOURCE })).toMatchObject({ object_count: 0, pgvector: true });
          await inspector.query('CREATE TABLE public.real_leftover (id int)');
          const error = await refusalOf(inspectTarget({ client: inspector, sourceIdentity: OTHER_SOURCE }));
          expect(error).toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
          expect(error.safe_details.objects).toEqual([{ schema: 'public', name: 'real_leftover', kind: 'relation' }]);
          expect(error.safe_details.schemas).toEqual([]);
        } finally { await inspector.end(); }
      } finally { await other.end(); }
    });
  });
});
