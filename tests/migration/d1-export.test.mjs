import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createD1ExportAdapter } from '../../scripts/v32-to-v4/source/d1-export.mjs';

function sqlFile(text) {
  const directory = mkdtempSync(join(tmpdir(), 'rm-d1-export-input-'));
  const path = join(directory, 'export.sql');
  writeFileSync(path, text);
  return path;
}

describe('local D1 SQL export adapter', () => {
  it('materializes PRAGMA, transactions, and quoted text beneath a fresh temp directory', async () => {
    const source = sqlFile("PRAGMA foreign_keys=ON; BEGIN; CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO entities VALUES (1, 'O''Reilly'); COMMIT;");
    const adapter = createD1ExportAdapter({ source });
    const tempDirectory = adapter.tempDirectory;
    await adapter.beginSnapshot();
    const rows = [];
    for await (const row of adapter.streamTable('entities')) rows.push(row);
    expect(rows).toEqual([{ id: 1, name: "O'Reilly" }]);
    await adapter.endSnapshot();
    await adapter.close();
    expect(existsSync(tempDirectory)).toBe(false);
  });

  it('materializes what `wrangler d1 export` writes: a sqlite_sequence reset, and rows that reference later rows', async () => {
    const source = sqlFile([
      'PRAGMA defer_foreign_keys=TRUE;',
      'CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, superseded_by INTEGER REFERENCES entities(id));',
      "INSERT INTO \"entities\" (\"id\",\"name\",\"superseded_by\") VALUES(1,'old',2);",
      "INSERT INTO \"entities\" (\"id\",\"name\",\"superseded_by\") VALUES(2,'new',NULL);",
      'DELETE FROM sqlite_sequence;',
      "INSERT INTO \"sqlite_sequence\" (\"name\",\"seq\") VALUES('entities',2);",
      '',
    ].join(String.fromCharCode(10)));
    const adapter = createD1ExportAdapter({ source });
    await adapter.beginSnapshot();
    const rows = [];
    for await (const row of adapter.streamTable('entities')) rows.push(row);
    expect(rows).toEqual([{ id: 1, name: 'old', superseded_by: 2 }, { id: 2, name: 'new', superseded_by: null }]);
    await adapter.endSnapshot();
    await adapter.close();
  });

  it('refuses an export whose rows violate its own foreign keys', () => {
    const source = sqlFile("CREATE TABLE entities (id INTEGER PRIMARY KEY, superseded_by INTEGER REFERENCES entities(id)); INSERT INTO entities VALUES (1, 9);");
    let error;
    try { createD1ExportAdapter({ source }); } catch (caught) { error = caught; }
    expect(error?.code).toBe('RMIG-E-SOURCE-FINGERPRINT');
    expect(error?.safe_details).toMatchObject({ foreign_key_violations: 1, tables: ['entities'] });
  });

  it('refuses a DELETE that is not the sqlite_sequence reset', () => {
    const source = sqlFile('CREATE TABLE entities (id INTEGER PRIMARY KEY); DELETE FROM entities;');
    expect(() => createD1ExportAdapter({ source })).toThrow(/DELETE other than the sqlite_sequence reset/);
  });

  it.each(['.dump', '.read other.sql', '.shell echo unsafe'])('rejects shell directive %s and leaves no materialization', (directive) => {
    const source = sqlFile(`${directive}\nCREATE TABLE entities(id INTEGER);`);
    expect(() => createD1ExportAdapter({ source })).toThrow(/directive|shell|unsupported/i);
  });

  it('refuses a remote D1 identifier instead of invoking a network or Wrangler path', () => {
    expect(() => createD1ExportAdapter({ source: 'my-d1-database' })).toThrow(/remote|D1|local|export/i);
    expect(() => createD1ExportAdapter({ source: 'https://api.cloudflare.com/client/v4' })).toThrow(/remote|D1|local/i);
  });
});
