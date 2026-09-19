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

  it.each(['.dump', '.read other.sql', '.shell echo unsafe'])('rejects shell directive %s and leaves no materialization', (directive) => {
    const source = sqlFile(`${directive}\nCREATE TABLE entities(id INTEGER);`);
    expect(() => createD1ExportAdapter({ source })).toThrow(/directive|shell|unsupported/i);
  });

  it('refuses a remote D1 identifier instead of invoking a network or Wrangler path', () => {
    expect(() => createD1ExportAdapter({ source: 'my-d1-database' })).toThrow(/remote|D1|local|export/i);
    expect(() => createD1ExportAdapter({ source: 'https://api.cloudflare.com/client/v4' })).toThrow(/remote|D1|local/i);
  });
});
