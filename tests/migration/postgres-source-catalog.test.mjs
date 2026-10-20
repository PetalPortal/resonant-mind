import { describe, expect, it } from 'vitest';
import {
  SOURCE_SESSION_OPTIONS,
  buildPostgresCatalog,
  parseIndexDefinition,
  rfc3339FromPostgres,
} from '../../scripts/v32-to-v4/source/postgres-v32.mjs';

describe('PostgreSQL timestamptz text as RFC 3339', () => {
  it('keeps every digit PostgreSQL printed and writes UTC as Z', () => {
    expect(rfc3339FromPostgres('2026-09-20 00:02:00+00')).toBe('2026-09-20T00:02:00Z');
    expect(rfc3339FromPostgres('2026-09-20 00:02:00.123456+00')).toBe('2026-09-20T00:02:00.123456Z');
    expect(rfc3339FromPostgres('2026-09-20 00:02:00.5+00')).toBe('2026-09-20T00:02:00.500Z');
    expect(rfc3339FromPostgres('2026-09-20 00:02:00.120+00')).toBe('2026-09-20T00:02:00.120Z');
  });

  it('keeps a non-UTC offset as an offset and never converts the instant', () => {
    expect(rfc3339FromPostgres('2026-09-20 01:32:00+05:30')).toBe('2026-09-20T01:32:00+05:30');
    expect(rfc3339FromPostgres('2026-09-20 01:32:00-08')).toBe('2026-09-20T01:32:00-08:00');
  });

  it('returns anything it does not recognise exactly as it was', () => {
    for (const value of ['infinity', '-infinity', '2026-09-20', '2026-09-20 00:02:00', 'not a time', '']) expect(rfc3339FromPostgres(value)).toBe(value);
  });
});

describe('PostgreSQL source session', () => {
  it('pins the settings that make catalog text and timestamps a function of the data alone', () => {
    expect(SOURCE_SESSION_OPTIONS.split(' -c ').map((entry) => entry.replace(/^-c /u, '')).sort()).toEqual(['DateStyle=ISO,YMD', 'TimeZone=UTC', 'search_path=public']);
  });
});

describe('PostgreSQL index definitions', () => {
  it('reads an ivfflat index with its operator class and options as PostgreSQL prints them', () => {
    expect(parseIndexDefinition("CREATE INDEX idx_embeddings_vector ON public.embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')"))
      .toEqual({ columns: ['embedding'], expressions: [], opclass: 'vector_cosine_ops', where: null, options: "lists = '100'" });
  });

  it('reads plain, multi-column and partial btree indexes', () => {
    expect(parseIndexDefinition('CREATE UNIQUE INDEX entities_name_primary_context_key ON public.entities USING btree (name, primary_context)')).toMatchObject({ columns: ['name', 'primary_context'], where: null });
    expect(parseIndexDefinition("CREATE INDEX i ON public.t USING btree (a DESC NULLS LAST) WHERE (b = 'x'::text)")).toMatchObject({ columns: ['a'], where: "(b = 'x'::text)" });
  });
});

describe('PostgreSQL catalog rows to the fingerprint shape', () => {
  const column = (table_name, column_name, extra = {}) => ({ table_name, column_name, data_type: 'integer', not_null: true, column_default: null, ordinal_position: 1, ...extra });
  const foreignKey = (delete_action, update_action = 'a') => ({ constraint_name: 'child_parent_id_fkey', constraint_type: 'f', table_name: 'child', columns: ['parent_id'], referenced_table: 'parent', referenced_columns: ['id'], delete_action, update_action });
  const build = (...constraints) => buildPostgresCatalog([column('parent', 'id'), column('child', 'parent_id')], constraints, [], []);
  const actions = (catalog) => { const fk = catalog.tables.find((table) => table.name === 'child').foreign_keys[0]; return [fk.on_delete, fk.on_update]; };

  it('names every PostgreSQL foreign-key action, including SET NULL', () => {
    expect(actions(build(foreignKey('a')))).toEqual(['NO ACTION', 'NO ACTION']);
    expect(actions(build(foreignKey('c', 'r')))).toEqual(['CASCADE', 'RESTRICT']);
    expect(actions(build(foreignKey('n', 'd')))).toEqual(['SET NULL', 'SET DEFAULT']);
  });

  it('refuses an action code it does not know instead of reading it as NO ACTION', () => {
    expect(() => build(foreignKey('x'))).toThrow(/foreign-key action/u);
  });

  it('keeps defaults, nullability and primary keys, and lowercases types only', () => {
    const catalog = buildPostgresCatalog(
      [column('t', 'id', { column_default: "nextval('t_id_seq'::regclass)" }), column('t', 'note', { data_type: 'Text', not_null: false, column_default: "'x'::text" })],
      [{ constraint_name: 't_pkey', constraint_type: 'p', table_name: 't', columns: ['id'], referenced_table: null, referenced_columns: null, delete_action: ' ', update_action: ' ' }],
      [], [],
    );
    expect(catalog.tables[0].primary_key).toEqual(['id']);
    expect(catalog.tables[0].columns).toEqual([
      { name: 'id', type: 'integer', nullable: false, default: "nextval('t_id_seq'::regclass)", pk_position: 1 },
      { name: 'note', type: 'text', nullable: true, default: "'x'::text", pk_position: 0 },
    ]);
  });
});
