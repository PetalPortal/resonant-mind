import { describe, expect, it } from 'vitest';
import { createPostgresV32Adapter, parseEnvReference } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';
import { hasAdminDatabase, withScratchSource } from './helpers/postgres-scratch.mjs';

describe('PostgreSQL v3.2 source adapter', () => {
  it('accepts only env:NAME connection references', () => {
    expect(parseEnvReference('env:TEST_V32_DATABASE_URL')).toBe('TEST_V32_DATABASE_URL');
    expect(() => parseEnvReference('postgres://user:password@host/db')).toThrow(/env|source/i);
    expect(() => parseEnvReference('env:bad-name')).toThrow(/environment|name/i);
  });

  it('does not expose literal connection values in refusal text', () => {
    expect(() => createPostgresV32Adapter({ source: 'postgres://user:secret@db.example/mind' })).toThrow(/env|source/i);
    try { createPostgresV32Adapter({ source: 'postgres://user:secret@db.example/mind' }); } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(String(error)).not.toContain('db.example');
    }
  });
});

const SEED = `
INSERT INTO entities (id, name, entity_type) VALUES (1, 'one', 'person'), (2, 'two', 'person'), (3, 'three', 'concept'), (4, 'four', 'concept'), (5, 'five', 'person');
INSERT INTO threads (id, thread_type, content) VALUES ('b', 'task', 'second'), ('a', 'task', 'first'), ('c', 'task', 'third');
INSERT INTO embeddings (id, source_type, source_id, embedding, content, metadata) VALUES
  ('e1', 'observation', 1, NULL, 'x', '{"a": 1}'),
  ('e2', 'observation', 2, NULL, 'y', '{}'),
  ('e3', 'entity', 3, NULL, 'z', '{"nested": {"k": [1, 2]}}');
`;

// Self-provisioned: needs only TEST_ADMIN_DATABASE_URL, like the other PostgreSQL migration suites.
describe.skipIf(!hasAdminDatabase)('PostgreSQL v3.2 adapter on a live database (TEST_ADMIN_DATABASE_URL)', () => {
  const adapterFor = (url, options = {}) => createPostgresV32Adapter({ source: 'env:RMIG_ADAPTER_IT', env: { RMIG_ADAPTER_IT: url }, ...options });

  it('reads identity, catalog, counts, embedding inventory and ordered rows in a read-only snapshot', async () => {
    await withScratchSource({ seed: (client) => client.query(SEED) }, async (url) => {
      const adapter = adapterFor(url, { batchSize: 2 });
      try {
        await adapter.beginSnapshot();
        const identity = await adapter.identity();
        expect(identity.kind).toBe('postgres');
        expect(identity).not.toHaveProperty('connection_string');
        expect(JSON.stringify(identity)).not.toContain(new URL(url).pathname.slice(1));
        const catalog = await adapter.catalog();
        expect(catalog.tables.map(({ name }) => name)).toContain('embeddings');

        expect(await adapter.rowCount('entities')).toBe('5');
        expect(await adapter.rowCount('observations')).toBe('0');
        expect(await adapter.embeddingInventory()).toEqual([{ source_type: 'entity', row_count: '1' }, { source_type: 'observation', row_count: '2' }]);

        // Five rows with a batch size of two crosses three batches; order is the primary key.
        const entityIds = [];
        for await (const row of adapter.streamTable('entities', ['id'])) entityIds.push(row.id);
        expect(entityIds).toEqual([1, 2, 3, 4, 5]);
        const threadIds = [];
        for await (const row of adapter.streamTable('threads', ['id'])) threadIds.push(row.id);
        expect(threadIds).toEqual(['a', 'b', 'c']);

        // jsonb stays the text PostgreSQL printed; timestamptz is RFC 3339 text with nothing rounded.
        const embeddings = [];
        for await (const row of adapter.streamTable('embeddings', ['id'])) embeddings.push(row);
        expect(embeddings.map((row) => row.metadata)).toEqual(['{"a": 1}', '{}', '{"nested": {"k": [1, 2]}}']);
        const [entity] = await (async () => { const rows = []; for await (const row of adapter.streamTable('entities', ['id'])) rows.push(row); return rows; })();
        expect(entity.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}(?:Z|[+-]\d{2}:\d{2})$/u);
      } finally {
        await adapter.endSnapshot();
        await adapter.close();
      }
    });
  }, 60_000);

  it('refuses to read a table the exact catalog does not list', async () => {
    await withScratchSource({}, async (url) => {
      const adapter = adapterFor(url);
      try {
        await adapter.beginSnapshot();
        await expect((async () => { for await (const _row of adapter.streamTable('pg_class')) { /* unreachable */ } })()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
        await expect(adapter.rowCount('pg_class')).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT' });
      } finally {
        await adapter.endSnapshot();
        await adapter.close();
      }
    });
  }, 60_000);
});
