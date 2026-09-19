import { describe, expect, it } from 'vitest';
import { createPostgresV32Adapter, parseEnvReference } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';

const hasIntegrationDatabase = typeof process.env.TEST_V32_DATABASE_URL === 'string' && process.env.TEST_V32_DATABASE_URL.length > 0;

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

describe.skipIf(!hasIntegrationDatabase)('PostgreSQL v3.2 exact integration (TEST_V32_DATABASE_URL)', () => {
  it('reads the exact catalog, identity, deterministic rows, and embedding inventory', async () => {
    const adapter = createPostgresV32Adapter({ source: 'env:TEST_V32_DATABASE_URL' });
    try {
      await adapter.beginSnapshot();
      const catalog = await adapter.catalog();
      expect(catalog.tables.some(({ name }) => name === 'embeddings')).toBe(true);
      const identity = await adapter.identity();
      expect(identity.kind).toBe('postgres');
      expect(identity).not.toHaveProperty('connection_string');
      const inventory = await adapter.embeddingInventory();
      expect(inventory).toEqual(expect.any(Array));
    } finally {
      await adapter.endSnapshot();
      await adapter.close();
    }
  }, 30_000);
});
