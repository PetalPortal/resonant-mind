import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR, SPEC_PATH, readVerifiedFixture, specText } from '../../scripts/v32-to-v4/spec/generate-postgres-spec.mjs';
import { compareCatalog, normalizeCatalog, sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';

// A small reader for exactly the DDL style of the tagged v3.2.0 migrations/postgres.sql. It exists
// so the committed fingerprint can be checked against the SQL without a database: if the SQL
// defines a table, column, key, reference or index that the spec lacks (or the spec invents one),
// this fails on any machine. The integration test then proves the spec equals a live catalog.
const TYPE_NAMES = { serial: 'integer', integer: 'integer', text: 'text', timestamptz: 'timestamp with time zone', real: 'real', jsonb: 'jsonb', 'vector(768)': 'vector(768)' };
const ACTIONS = { cascade: 'CASCADE', 'set null': 'SET NULL', restrict: 'RESTRICT', 'no action': 'NO ACTION' };

function topLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') depth -= 1;
    else if (text[index] === ',' && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function readDdl(sql) {
  const clean = sql.split('\n').map((line) => line.replace(/--.*$/u, '')).join('\n');
  const tables = new Map();
  for (const match of clean.matchAll(/CREATE TABLE (\w+) \(/gu)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth > 0) { if (clean[end] === '(') depth += 1; else if (clean[end] === ')') depth -= 1; end += 1; }
    const table = { name: match[1], columns: [], primary_key: [], uniques: [], foreign_keys: [] };
    for (const item of topLevel(clean.slice(match.index + match[0].length, end - 1))) {
      const unique = /^UNIQUE\s*\(([^)]*)\)/iu.exec(item);
      if (unique) { table.uniques.push(unique[1].split(',').map((name) => name.trim())); continue; }
      const [name, rawType] = item.split(/\s+/u);
      const type = rawType.toLowerCase();
      const serial = type === 'serial';
      const inlinePk = /\bPRIMARY KEY\b/iu.test(item);
      const defaultMatch = /\bDEFAULT\s+('(?:[^']|'')*'|[\w.]+(?:\(\))?)/iu.exec(item);
      const reference = /\bREFERENCES\s+(\w+)\((\w+)\)(?:\s+ON DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?/iu.exec(item);
      table.columns.push({ name, type: TYPE_NAMES[type], serial, nullable: !(inlinePk || /\bNOT NULL\b/iu.test(item)), default: defaultMatch?.[1] ?? null });
      if (inlinePk) table.primary_key.push(name);
      if (/\bUNIQUE\b/iu.test(item)) table.uniques.push([name]);
      if (reference) table.foreign_keys.push({ columns: [name], table: reference[1], references: [reference[2]], on_delete: reference[3] ? ACTIONS[reference[3].toLowerCase()] : 'NO ACTION' });
    }
    tables.set(table.name, table);
  }
  const indexes = [...clean.matchAll(/CREATE INDEX (\w+) ON (\w+)\s*(?:USING (\w+)\s*)?\(([^)]*)\)/gu)].map((match) => ({ name: match[1], table: match[2], method: match[3] ?? 'btree', columns: match[4].split(',').map((entry) => entry.trim().split(/\s+/u)[0]) }));
  return { tables, indexes };
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const specTable = (name) => spec.tables.find((table) => table.name === name);
const ddl = readDdl(readVerifiedFixture().sql);

describe('the committed PostgreSQL v3.2 fingerprint against the tagged SQL', () => {
  it('reads the SQL it checks against', () => {
    expect([...ddl.tables.keys()].sort()).toEqual(spec.tables.map((table) => table.name).sort());
    expect(ddl.tables.size).toBe(17);
    expect(ddl.indexes).toHaveLength(31);
  });

  it('has every table and exactly the columns the SQL creates, with their types, nullability and defaults', () => {
    for (const table of ddl.tables.values()) {
      const target = specTable(table.name);
      expect(target.columns.map((column) => column.name).sort(), table.name).toEqual(table.columns.map((column) => column.name).sort());
      for (const column of table.columns) {
        const actual = target.columns.find((entry) => entry.name === column.name);
        expect(actual.type, `${table.name}.${column.name} type`).toBe(column.type);
        expect(actual.nullable, `${table.name}.${column.name} nullable`).toBe(column.nullable);
        if (column.serial) expect(actual.default, `${table.name}.${column.name} default`).toBe(`nextval('${table.name}_${column.name}_seq'::regclass)`);
        else if (column.default === null) expect(actual.default, `${table.name}.${column.name} default`).toBeNull();
        else expect(actual.default.toLowerCase().startsWith(column.default.toLowerCase()), `${table.name}.${column.name} default ${actual.default} for ${column.default}`).toBe(true);
      }
    }
  });

  it('has the primary keys, unique constraints and foreign keys the SQL declares, with PostgreSQL derived names', () => {
    for (const table of ddl.tables.values()) {
      const target = specTable(table.name);
      expect(target.primary_key, `${table.name} primary key`).toEqual(table.primary_key);
      expect(target.unique_constraints.map((entry) => [entry.name, entry.columns]), `${table.name} unique`).toEqual(table.uniques.map((columns) => [`${table.name}_${columns.join('_')}_key`, columns]));
      expect(target.foreign_keys.map((entry) => [entry.name, entry.columns, entry.references.table, entry.references.columns, entry.on_delete, entry.on_update]).sort(), `${table.name} foreign keys`)
        .toEqual(table.foreign_keys.map((entry) => [`${table.name}_${entry.columns[0]}_fkey`, entry.columns, entry.table, entry.references, entry.on_delete, 'NO ACTION']).sort());
      expect(target.checks, `${table.name} checks`).toEqual([]);
    }
  });

  it('has the explicit indexes plus the indexes PostgreSQL builds for primary keys and unique constraints, and nothing else', () => {
    for (const table of ddl.tables.values()) {
      const expected = [
        ...(table.primary_key.length > 0 ? [{ name: `${table.name}_pkey`, unique: true, columns: table.primary_key }] : []),
        ...table.uniques.map((columns) => ({ name: `${table.name}_${columns.join('_')}_key`, unique: true, columns })),
        ...ddl.indexes.filter((index) => index.table === table.name).map((index) => ({ name: index.name, unique: false, columns: index.columns })),
      ];
      expect(specTable(table.name).indexes.map(({ name, unique, columns }) => ({ name, unique, columns })).sort((a, b) => a.name.localeCompare(b.name)), `${table.name} indexes`)
        .toEqual(expected.sort((a, b) => a.name.localeCompare(b.name)));
    }
    const vector = specTable('embeddings').indexes.find((index) => index.name === 'idx_embeddings_vector');
    expect(vector).toMatchObject({ method: 'ivfflat', opclass: 'vector_cosine_ops', options: "lists = '100'", columns: ['embedding'] });
  });

  it('is in the fingerprint normal form and exactly the text the generator writes', () => {
    expect(normalizeCatalog(spec)).toEqual(spec);
    expect(readFileSync(SPEC_PATH, 'utf8').replaceAll('\r\n', '\n')).toBe(specText(spec));
    expect(compareCatalog(spec, sourceSpecFor('postgres')).match).toBe(true);
  });
});

describe('the fixture the fingerprint is derived from', () => {
  it('is refused unless it is byte-for-byte the tagged v3.2.0 file', () => {
    expect(readVerifiedFixture().tag).toBe('v3.2.0');
    expect(() => readVerifiedFixture(join(FIXTURE_DIR, 'd1'))).toThrow();
  });
});
