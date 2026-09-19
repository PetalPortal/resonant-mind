import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compareCatalog, sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { createSqliteV32Adapter } from '../../scripts/v32-to-v4/source/sqlite-v32.mjs';

const root = mkdtempSync(join(tmpdir(), 'rm-sqlite-source-'));
const sourcePath = join(root, 'source.sqlite');
const db = new DatabaseSync(sourcePath);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tagPath = { '0001_init.sql': 'migrations/0001_init.sql', '0002_enhanced_memory.sql': 'migrations/0002_enhanced_memory.sql', '0003_graph_health.sql': 'migrations/0003_graph_health.sql' };
for (const file of Object.keys(tagPath)) {
  db.exec(execFileSync('git', ['show', `v3.2.0:${tagPath[file]}`], { cwd: repositoryRoot, encoding: 'utf8' }));
}
db.exec("INSERT INTO entities(name, entity_type) VALUES ('one', 'person'), ('two', 'thing')");
db.close();

it('reads a local SQLite source read-only with exact catalog and stable rows', async () => {
  const before = statSync(sourcePath);
  const adapter = createSqliteV32Adapter({ source: sourcePath });
  try {
    await adapter.beginSnapshot();
    const catalog = await adapter.catalog();
    expect(compareCatalog(catalog, sourceSpecFor('sqlite')).match).toBe(true);
    const rows = [];
    for await (const row of adapter.streamTable('entities')) rows.push(row);
    expect(rows.map(({ name }) => name)).toEqual(['one', 'two']);
  } finally {
    await adapter.endSnapshot();
    await adapter.close();
  }
  const after = statSync(sourcePath);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
});

it('rejects remote and non-file SQLite identifiers', () => {
  expect(() => createSqliteV32Adapter({ source: 'https://example.com/db.sqlite' })).toThrow(/remote|local|source/i);
  expect(() => createSqliteV32Adapter({ source: 'd1://database-name' })).toThrow(/remote|D1|local/i);
});

it('rejects a source path that is not a regular file', () => {
  expect(() => createSqliteV32Adapter({ source: root })).toThrow(/regular|file/i);
});
