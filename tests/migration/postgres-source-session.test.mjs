import { describe, expect, it } from 'vitest';
import { SOURCE_SESSION_SETTINGS, createPostgresV32Adapter } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';

// A stand-in for a server behind a transaction-mode pooler: it records every statement, counts how
// many are in flight at once, and answers the session-settings check with whatever it was told.
function fakeServer({ applied } = {}) {
  const log = [];
  let inflight = 0;
  let maxInflight = 0;
  const settings = applied ?? { timezone: 'UTC', datestyle: 'ISO, YMD', search_path: 'public', extra_float_digits: '1' };
  return {
    log,
    get maxInflight() { return maxInflight; },
    client: {
      async connect() {},
      async end() {},
      async query(text, values = []) {
        inflight += 1; maxInflight = Math.max(maxInflight, inflight);
        log.push({ text, values });
        await new Promise((resolve) => setImmediate(resolve));
        inflight -= 1;
        if (/SHOW transaction_read_only/u.test(text)) return { rows: [{ transaction_read_only: 'on' }] };
        if (/current_setting\('TimeZone'\)/u.test(text)) return { rows: [settings] };
        return { rows: [] };
      },
    },
  };
}

const adapterFor = (server) => createPostgresV32Adapter({ source: 'env:URL', env: { URL: 'postgres://pooled.invalid/db' }, clientFactory: () => server.client });

describe('PostgreSQL source session settings are transaction-local', () => {
  it('sets TimeZone, DateStyle, search_path and extra_float_digits with set_config(..., true) inside the snapshot transaction, before any read', async () => {
    const server = fakeServer();
    const adapter = adapterFor(server);
    await adapter.beginSnapshot();
    await adapter.rowCount('entities');
    await adapter.catalog();
    await adapter.endSnapshot();
    await adapter.close();
    const texts = server.log.map(({ text }) => text);
    expect(texts[0]).toMatch(/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u);
    const setIndex = texts.findIndex((text) => text.includes('set_config'));
    expect(setIndex).toBeGreaterThan(0);
    const set = server.log[setIndex];
    expect(set.text).toMatch(/^SELECT set_config\(\$1, \$2, true\), set_config\(\$3, \$4, true\), set_config\(\$5, \$6, true\), set_config\(\$7, \$8, true\)$/u);
    expect(set.values).toEqual(SOURCE_SESSION_SETTINGS.flatMap(({ name, value }) => [name, value]));
    const firstRead = texts.findIndex((text) => /pg_catalog\.pg_attribute|count\(\*\)/u.test(text));
    expect(setIndex).toBeLessThan(firstRead);
    expect(texts.findIndex((text) => /current_setting\('TimeZone'\)/u.test(text))).toBeGreaterThan(setIndex);
    expect(texts.at(-1)).toBe('ROLLBACK');
    // never a session-level SET, which a pooler may not keep for the next statement
    expect(texts.some((text) => /^\s*SET\b/iu.test(text))).toBe(false);
  });

  it('refuses, and rolls back, when the server did not keep a setting', async () => {
    for (const applied of [
      { timezone: 'Asia/Tokyo', datestyle: 'ISO, YMD', search_path: 'public', extra_float_digits: '1' },
      { timezone: 'UTC', datestyle: 'SQL, DMY', search_path: 'public', extra_float_digits: '1' },
      { timezone: 'UTC', datestyle: 'ISO, YMD', search_path: 'pg_catalog', extra_float_digits: '1' },
      { timezone: 'UTC', datestyle: 'ISO, YMD', search_path: 'public', extra_float_digits: '-3' },
    ]) {
      const server = fakeServer({ applied });
      const adapter = adapterFor(server);
      await expect(adapter.beginSnapshot()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-DRIFT' });
      expect(server.log.map(({ text }) => text)).toContain('ROLLBACK');
      await expect(adapter.catalog()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-NOT-READONLY' });
      await adapter.close();
    }
  });

  it('will not read the catalog, rows or counts outside a snapshot, because their text depends on those settings', async () => {
    const server = fakeServer();
    const adapter = adapterFor(server);
    await expect(adapter.catalog()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-NOT-READONLY' });
    await expect(adapter.rowCount('entities')).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-NOT-READONLY' });
    await expect(adapter.embeddingInventory()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-NOT-READONLY' });
    await expect((async () => { for await (const _row of adapter.streamTable('entities', ['id'])) { /* unreachable */ } })()).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-NOT-READONLY' });
    expect(server.log).toEqual([]);
    await adapter.close();
  });

  it('reads the catalog one statement at a time', async () => {
    const server = fakeServer();
    const adapter = adapterFor(server);
    await adapter.beginSnapshot();
    await adapter.catalog();
    await adapter.close();
    expect(server.maxInflight).toBe(1);
  });
});
