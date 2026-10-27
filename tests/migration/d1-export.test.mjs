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

  // What a materialized export gives back for one table, or the refusal it raised instead.
  async function outcome(text, table = 'entities') {
    let adapter;
    try { adapter = createD1ExportAdapter({ source: sqlFile(text) }); } catch (error) { return { error }; }
    try {
      await adapter.beginSnapshot();
      const rows = [];
      for await (const row of adapter.streamTable(table)) rows.push(row);
      await adapter.endSnapshot();
      return { rows };
    } finally { await adapter.close(); }
  }
  const ENTITY = "CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT); INSERT INTO entities (name) VALUES ('a'); ";

  // wrangler writes the reset as exactly `DELETE FROM sqlite_sequence;`: unquoted, unqualified, no clause. The guard compares tokens,
  // so every other spelling of that statement is refused; a refusal costs the owner one edit, an allowance is a second door.
  it.each([
    ['a quoted table name', 'DELETE FROM "sqlite_sequence";'],
    ['a backtick-quoted table name', 'DELETE FROM `sqlite_sequence`;'],
    ['a bracket-quoted table name', 'DELETE FROM [sqlite_sequence];'],
    ['a schema-qualified table name', 'DELETE FROM main.sqlite_sequence;'],
    ['a WHERE clause', "DELETE FROM sqlite_sequence WHERE name='entities';"],
    ['the reset followed by a DELETE of another table', 'DELETE FROM sqlite_sequence; DELETE FROM entities;'],
    ['the reset followed by a DELETE with no closing semicolon', 'DELETE FROM sqlite_sequence; DELETE FROM entities'],
    ['a line comment before a DELETE of another table', '-- the reset\nDELETE FROM entities;'],
    ['a block comment before a DELETE of another table', '/* the reset */ DELETE FROM entities;'],
  ])('refuses %s', async (_label, statement) => {
    const { error } = await outcome(ENTITY + statement);
    expect(error?.code).toBe('RMIG-E-D1-SQL-UNSAFE');
    expect(error?.safe_details).toEqual({ statement: 'delete' });
  });

  // The statement is matched without regard to case, spacing or comments between its words, and a DELETE that sits inside a comment is not a statement.
  it.each([
    ['lower case and odd spacing', 'delete   from SQLITE_SEQUENCE;'],
    ['tabs and line breaks', 'DELETE\n\tFROM\r\n  sqlite_sequence\t;'],
    ['a comment between its words', 'DELETE /* the reset */ FROM sqlite_sequence;'],
    ['a line comment that holds a second DELETE', 'DELETE FROM sqlite_sequence -- ; DELETE FROM entities\n;'],
    ['a block comment that holds a second DELETE', 'DELETE FROM sqlite_sequence /* ; DELETE FROM entities */;'],
    ['a trailing comment that is a DELETE', 'DELETE FROM sqlite_sequence; -- DELETE FROM entities\n'],
  ])('accepts the reset with %s, and the comment deletes nothing', async (_label, statement) => {
    const { error, rows } = await outcome(ENTITY + statement);
    expect(error).toBeUndefined();
    expect(rows).toEqual([{ id: 1, name: 'a' }]);
  });

  // A dump's own PRAGMA can switch enforcement back on, because the guard allows foreign_keys (on/off/true/false/0/1) and
  // the export is loaded one statement at a time. wrangler does not write it (it writes only `PRAGMA defer_foreign_keys=TRUE;`), and
  // nothing wrong is let through: the result is the earlier refusal, with SQLite's own error and without the violation count.
  const SELF_REF = 'CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, superseded_by INTEGER REFERENCES entities(id)); ';
  const FORWARD = "INSERT INTO entities (id, name, superseded_by) VALUES (1, 'old', 2); INSERT INTO entities (id, name, superseded_by) VALUES (2, 'new', NULL); ";
  const DANGLING = "INSERT INTO entities (id, name, superseded_by) VALUES (1, 'old', 9); ";
  const bothRows = [{ id: 1, name: 'old', superseded_by: 2 }, { id: 2, name: 'new', superseded_by: null }];
  const sqliteRefused = (error) => {
    expect(error?.code).toBe('RMIG-E-SOURCE-FINGERPRINT');
    expect(error?.safe_details).toMatchObject({ reason: 'ERR_SQLITE_ERROR', source_kind: 'd1-export' });
    expect(error?.safe_details).not.toHaveProperty('foreign_key_violations');
  };

  it.each([
    ['first', 'PRAGMA foreign_keys=ON; PRAGMA defer_foreign_keys=TRUE; '],
    ['after the defer', 'PRAGMA defer_foreign_keys=TRUE; PRAGMA foreign_keys=ON; '],
    ['alone', 'PRAGMA foreign_keys=ON; '],
  ])('PRAGMA foreign_keys=ON (%s) turns enforcement back on, and defer_foreign_keys outside a transaction does not help', async (_label, pragmas) => {
    sqliteRefused((await outcome(pragmas + SELF_REF + FORWARD)).error);
  });

  it('turns enforcement on for the rows after PRAGMA foreign_keys=ON, even when the tables were created before it', async () => {
    sqliteRefused((await outcome('PRAGMA defer_foreign_keys=TRUE; ' + SELF_REF + 'PRAGMA foreign_keys=ON; ' + FORWARD)).error);
  });

  it('lets PRAGMA foreign_keys=OFF turn it off again, and then reads the forward reference', async () => {
    const { error, rows } = await outcome('PRAGMA foreign_keys=ON; PRAGMA foreign_keys=OFF; ' + SELF_REF + FORWARD);
    expect(error).toBeUndefined();
    expect(rows).toEqual(bothRows);
  });

  it('reads a forward reference under foreign_keys=ON when defer_foreign_keys is set inside BEGIN ... COMMIT, where it holds until the COMMIT', async () => {
    const { error, rows } = await outcome('PRAGMA foreign_keys=ON; BEGIN TRANSACTION; PRAGMA defer_foreign_keys=TRUE; ' + SELF_REF + FORWARD + 'COMMIT;');
    expect(error).toBeUndefined();
    expect(rows).toEqual(bothRows);
  });

  it('reads a forward reference when PRAGMA foreign_keys=ON comes inside BEGIN, where SQLite ignores it', async () => {
    const { error, rows } = await outcome('BEGIN TRANSACTION; PRAGMA foreign_keys=ON; ' + SELF_REF + FORWARD + 'COMMIT;');
    expect(error).toBeUndefined();
    expect(rows).toEqual(bothRows);
  });

  it('still refuses a dangling reference under foreign_keys=ON and a deferral, at the COMMIT', async () => {
    const pragmas = 'PRAGMA foreign_keys=ON; BEGIN TRANSACTION; PRAGMA defer_foreign_keys=TRUE; ';
    sqliteRefused((await outcome(pragmas + SELF_REF + DANGLING + 'COMMIT;')).error);
  });

  // SQLite rolls an open transaction back when the connection closes, so a dump that is cut off inside BEGIN (or never commits) would
  // be read as a smaller database with no error. The guard follows the transaction across the stream and refuses what does not balance.
  const txRefused = (error, reason) => {
    expect(error?.code).toBe('RMIG-E-D1-SQL-UNSAFE');
    expect(error?.safe_details).toEqual({ reason });
  };

  it('accepts a balanced BEGIN ... COMMIT, one after another, and a dump with no transaction statements at all', async () => {
    const two = await outcome(ENTITY + "BEGIN TRANSACTION; INSERT INTO entities (name) VALUES ('b'); COMMIT; BEGIN; INSERT INTO entities (name) VALUES ('c'); END TRANSACTION;");
    expect(two.error).toBeUndefined();
    expect(two.rows.map((row) => row.name)).toEqual(['a', 'b', 'c']);
    const none = await outcome(ENTITY);
    expect(none.error).toBeUndefined();
    expect(none.rows).toEqual([{ id: 1, name: 'a' }]);
  });

  it.each([
    ['BEGIN with no COMMIT', "BEGIN TRANSACTION; INSERT INTO entities (name) VALUES ('b');"],
    ['BEGIN as the last statement', 'BEGIN;'],
    ['a second transaction that never commits', "BEGIN; INSERT INTO entities (name) VALUES ('b'); COMMIT; BEGIN; INSERT INTO entities (name) VALUES ('c');"],
  ])('refuses a dump that ends inside a transaction (%s), instead of reading the rows SQLite would roll back', async (_label, statements) => {
    txRefused((await outcome(ENTITY + statements)).error, 'unterminated-transaction');
  });

  it('refuses a dangling reference in a dump that never commits as an unterminated transaction, not by the foreign key check', async () => {
    txRefused((await outcome('PRAGMA foreign_keys=ON; BEGIN TRANSACTION; PRAGMA defer_foreign_keys=TRUE; ' + SELF_REF + DANGLING)).error, 'unterminated-transaction');
  });

  it('refuses a BEGIN while a transaction is already open', async () => {
    txRefused((await outcome(ENTITY + 'BEGIN; BEGIN TRANSACTION; COMMIT;')).error, 'nested-transaction');
  });

  it.each(['COMMIT;', 'COMMIT TRANSACTION;', 'END;', 'END TRANSACTION;'])('refuses %s when no transaction is open', async (statement) => {
    txRefused((await outcome(ENTITY + statement)).error, 'commit-without-begin');
    txRefused((await outcome(ENTITY + 'BEGIN; COMMIT; ' + statement)).error, 'commit-without-begin');
  });

  it.each(['ROLLBACK;', 'ROLLBACK TRANSACTION;'])('refuses %s, inside a transaction or outside one, because an export holds data and a rollback discards part of it', async (statement) => {
    txRefused((await outcome(ENTITY + "BEGIN; INSERT INTO entities (name) VALUES ('b'); " + statement + ' COMMIT;')).error, 'rollback');
    txRefused((await outcome(ENTITY + statement)).error, 'rollback');
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
