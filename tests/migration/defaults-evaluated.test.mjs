import { describe, expect, it } from 'vitest';
import { comparePlanToTarget, evaluableDefault, literalDefault, unstatedCellState } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { parseValidateArgs } from '../../scripts/v32-to-v4/commands/validate.mjs';

// A column the plan does not state is filled by the database from its default. now(), CURRENT_TIMESTAMP and
// transaction_timestamp() are the start of the import transaction, so such a column must hold exactly the
// import's imported_at; nextval(...) must hold an integer the sequence could give. Anything else the catalog
// prints as a function call cannot be confirmed here, is listed by column, and keeps validate from a ready state.
const IMPORTED_AT = 1_792_454_400_123_456n; // 2026-10-20T00:00:00.123456Z, in microseconds
const IMPORT_TIME = '2026-10-20T00:00:00.123456Z';
const SEQUENCES = { 'public.journals_visit_seq': { min: '1', max: '2147483647' }, 'public.small_seq': { min: '1', max: '10' }, 'public.big_seq': { min: '1', max: '9223372036854775807' } };

describe('which default expressions the tool evaluates', () => {
  it('knows the three forms of the transaction time, and nextval of a sequence, from the text the catalog prints', () => {
    for (const expression of ['now()', 'NOW()', 'CURRENT_TIMESTAMP', 'current_timestamp', 'transaction_timestamp()', 'now()::timestamptz', 'now()::timestamp with time zone']) expect(evaluableDefault(expression), expression).toEqual({ kind: 'import-time' });
    expect(evaluableDefault("nextval('journals_id_seq'::regclass)")).toEqual({ kind: 'sequence', schema: 'public', name: 'journals_id_seq' });
    expect(evaluableDefault("nextval('public.journals_id_seq'::regclass)")).toEqual({ kind: 'sequence', schema: 'public', name: 'journals_id_seq' });
    expect(evaluableDefault('nextval(\'"Odd Schema"."odd ""name"""\'::regclass)')).toEqual({ kind: 'sequence', schema: 'Odd Schema', name: 'odd "name"' });
  });

  it('does not evaluate anything else: other times, expressions, casts that change the value, or a name it cannot read', () => {
    for (const expression of ['clock_timestamp()', 'statement_timestamp()', 'CURRENT_TIMESTAMP(3)', 'CURRENT_DATE', 'now()::date', 'now()::text', '(now() + \'1 day\'::interval)', 'timezone(\'utc\'::text, now())', 'lower(\'X\'::text)', "nextval('a.b.c'::regclass)", "nextval(some_function())", 'nextval(\'x\'::regclass) + 1', null, undefined, 7]) expect(evaluableDefault(expression), String(expression)).toEqual({ kind: null });
    // and a literal is still a literal, not an expression
    expect(literalDefault('now()')).toEqual({ literal: false });
  });
});

describe('a column filled by now() is exactly the import time', () => {
  const info = { default: 'now()' };
  it('accepts the import time and no other time', () => {
    expect(unstatedCellState({ dbValue: IMPORT_TIME, columnInfo: info, importedAt: IMPORTED_AT })).toBe('default');
    expect(unstatedCellState({ dbValue: '2026-10-20T01:00:00.123456+01:00', columnInfo: info, importedAt: IMPORTED_AT })).toBe('default'); // the same instant, another offset
    expect(unstatedCellState({ dbValue: '2026-10-20T00:00:00.123457Z', columnInfo: info, importedAt: IMPORTED_AT })).toBe('default-differs'); // one microsecond off
    expect(unstatedCellState({ dbValue: '2026-01-01T00:00:00Z', columnInfo: info, importedAt: IMPORTED_AT })).toBe('default-differs');
    expect(unstatedCellState({ dbValue: 'not a time', columnInfo: info, importedAt: IMPORTED_AT })).toBe('default-differs');
    expect(unstatedCellState({ dbValue: 12, columnInfo: info, importedAt: IMPORTED_AT })).toBe('default-differs');
    expect(unstatedCellState({ dbValue: null, columnInfo: info, importedAt: IMPORTED_AT })).toBe('absent');
    for (const alias of ['CURRENT_TIMESTAMP', 'transaction_timestamp()']) expect(unstatedCellState({ dbValue: IMPORT_TIME, columnInfo: { default: alias }, importedAt: IMPORTED_AT }), alias).toBe('default');
  });
  it('cannot confirm it when the import time is not known', () => {
    expect(unstatedCellState({ dbValue: IMPORT_TIME, columnInfo: info, importedAt: null })).toBe('default-expression-not-evaluated');
    expect(unstatedCellState({ dbValue: IMPORT_TIME, columnInfo: info })).toBe('default-expression-not-evaluated');
  });
});

describe('a column filled by nextval(...) is an integer the sequence could give', () => {
  const info = (name) => ({ default: `nextval('${name}'::regclass)` });
  it('accepts an integer within the sequence\'s range, as a number or as the text a bigint arrives as', () => {
    expect(unstatedCellState({ dbValue: 5, columnInfo: info('journals_visit_seq'), sequences: SEQUENCES })).toBe('default');
    expect(unstatedCellState({ dbValue: '9223372036854775807', columnInfo: info('big_seq'), sequences: SEQUENCES })).toBe('default');
    expect(unstatedCellState({ dbValue: 10, columnInfo: info('small_seq'), sequences: SEQUENCES })).toBe('default');
  });
  it('refuses a value outside the range, a fraction, text, or a sequence it knows nothing about', () => {
    for (const value of [0, -4, 11, '11', 2.5, 'seven', true, {}, 9007199254740993]) expect(unstatedCellState({ dbValue: value, columnInfo: info('small_seq'), sequences: SEQUENCES }), String(value)).toBe('default-differs');
    expect(unstatedCellState({ dbValue: '9223372036854775808', columnInfo: info('big_seq'), sequences: SEQUENCES })).toBe('default-differs');
    expect(unstatedCellState({ dbValue: 5, columnInfo: info('unknown_seq'), sequences: SEQUENCES })).toBe('default-expression-not-evaluated');
    expect(unstatedCellState({ dbValue: 5, columnInfo: info('journals_visit_seq') })).toBe('default-expression-not-evaluated');
  });
});

describe('what the plan-to-target comparison does with them', () => {
  const plan = { members: { journals: [{ id: 1, content: 'a day' }] } };
  const defaults = { journals: { created_at: { default: 'now()' }, visit: { default: "nextval('journals_visit_seq'::regclass)" }, emotion: { default: "lower('X'::text)" }, tags: { default: "transform_tags('[]'::text)" } } };
  const compare = (row, { importedAt = IMPORTED_AT, sequences = SEQUENCES, columnDefaults = defaults } = {}) => comparePlanToTarget({ plan, targetTables: { journals: [{ id: 1, content: 'a day', ...row }] }, columnTypes: {}, columnDefaults, importedAt, sequences });

  it('is clean for journals.created_at at the import time and a sequence column in range', () => {
    const result = compare({ created_at: IMPORT_TIME, visit: 3 });
    expect(result.findings.samples).toEqual([]);
    expect(result.unevaluated_defaults).toEqual([]);
    expect(result.tables.journals.default_expressions_not_evaluated).toBe(0);
  });

  it('makes a finding of a time that is not the import time, and of a sequence value out of range', () => {
    const result = compare({ created_at: '2026-10-19T00:00:00Z', visit: 0 });
    expect(result.findings.samples).toEqual([
      expect.objectContaining({ check: 'target-column-not-in-plan', table: 'journals', column: 'created_at', difference: 'default-differs' }),
      expect.objectContaining({ check: 'target-column-not-in-plan', table: 'journals', column: 'visit', difference: 'default-differs' }),
    ]);
    expect(JSON.stringify(result.findings.samples)).not.toContain('2026-10-19');
  });

  it('lists what it cannot evaluate by column and makes a finding of each, so validate cannot reach a ready state', () => {
    const result = compare({ emotion: 'x', tags: '[]' });
    expect(result.findings.counts).toEqual({ 'default-expression-not-evaluated': 2 });
    expect(result.findings.total).toBe(2);
    expect(result.findings.samples).toEqual([
      expect.objectContaining({ check: 'default-expression-not-evaluated', table: 'journals', column: 'emotion' }),
      expect.objectContaining({ check: 'default-expression-not-evaluated', table: 'journals', column: 'tags' }),
    ]);
    expect(result.unevaluated_defaults).toEqual([{ table: 'journals', column: 'emotion', cells: 1 }, { table: 'journals', column: 'tags', cells: 1 }]);
    expect(result.tables.journals.default_expressions_not_evaluated).toBe(2);
    // the finding names the column, never the value
    expect(JSON.stringify(result.findings.samples)).not.toContain('"x"');
  });

  it('cannot confirm now() or a sequence without the import time or the sequence range, and says which columns', () => {
    const result = compare({ created_at: IMPORT_TIME, visit: 3 }, { importedAt: null, sequences: null });
    expect(result.unevaluated_defaults).toEqual([{ table: 'journals', column: 'created_at', cells: 1 }, { table: 'journals', column: 'visit', cells: 1 }]);
    expect(result.findings.counts).toEqual({ 'default-expression-not-evaluated': 2 });
  });

  it('counts a column once per row it is found in, and says nothing of a column that is empty', () => {
    const many = comparePlanToTarget({ plan: { members: { journals: [{ id: 1, content: 'a' }, { id: 2, content: 'b' }, { id: 3, content: 'c' }] } }, targetTables: { journals: [{ id: 1, content: 'a', emotion: 'x' }, { id: 2, content: 'b', emotion: 'y' }, { id: 3, content: 'c', emotion: null }] }, columnTypes: {}, columnDefaults: defaults, importedAt: IMPORTED_AT, sequences: SEQUENCES });
    expect(many.unevaluated_defaults).toEqual([{ table: 'journals', column: 'emotion', cells: 2 }]);
    expect(many.findings.total).toBe(2);
  });
});

describe('validate\'s image options', () => {
  const base = ['--bundle', 'b', '--decisions', 'd', '--plan', 'p', '--source-kind', 'sqlite', '--source', 's', '--target', 'env:T', '--migration-id', 'm', '--dry-run-receipt', 'r', '--import-receipt', 'i', '--out', 'o'];
  it('reads the source directory only alongside the target directory it is held to', () => {
    expect(() => parseValidateArgs([...base, '--image-source-dir', 'src'])).toThrow(/--image-source-dir needs --image-target-dir/u);
    expect(parseValidateArgs([...base, '--image-target-dir', 'dst', '--image-source-dir', 'src'])).toMatchObject({ imageTargetDir: 'dst', imageSourceDir: 'src' });
    expect(parseValidateArgs([...base, '--image-target-dir', 'dst']).imageSourceDir).toBeUndefined();
    expect(() => parseValidateArgs([...base, '--image-target-dir', 'dst', '--image-source-dir', 'a', '--image-source-dir', 'b'])).toThrow(/only once/u);
  });
});
