import { describe, expect, it } from 'vitest';
import { sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { DATE_FIELDS, TIMESTAMP_FIELDS, generateDecisionItems } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { buildValueMaps } from '../../scripts/v32-to-v4/transform/value-map.mjs';

// Text columns that hold a date but that v4 also stores as free text, so they are carried verbatim
// and have nothing to normalize. Each is a decision, listed here so a new one cannot slip in unseen.
const VERBATIM_TEXT_DATES = new Set(['journals.entry_date']);

const columnsOf = (kind) => sourceSpecFor(kind).tables.flatMap((table) => table.columns.map((column) => ({ key: `${table.name}.${column.name}`, table: table.name, name: column.name, type: column.type })));

describe('every point-in-time column in the exact v3.2 specs is normalized', () => {
  const postgres = columnsOf('postgres');
  const sqlite = columnsOf('sqlite');

  it('covers each PostgreSQL timestamp and date column', () => {
    const timestamps = postgres.filter((column) => /^timestamp/u.test(column.type));
    expect(timestamps.length).toBeGreaterThan(20);
    expect(timestamps.filter((column) => !TIMESTAMP_FIELDS.has(column.key)).map((column) => column.key)).toEqual([]);
    expect(postgres.filter((column) => column.type === 'date').filter((column) => !DATE_FIELDS.has(column.key)).map((column) => column.key)).toEqual([]);
  });

  it('covers each SQLite column that is a timestamp in PostgreSQL, and anything named like one', () => {
    const pgTimestamps = new Set(postgres.filter((column) => /^timestamp/u.test(column.type)).map((column) => column.key));
    const sqliteKeys = new Set(sqlite.map((column) => column.key));
    for (const key of pgTimestamps) if (sqliteKeys.has(key)) expect(TIMESTAMP_FIELDS.has(key), key).toBe(true);
    const named = sqlite.filter((column) => /(?:_at|^timestamp|^first_marked|^valid_from|^valid_until)$/u.test(column.name));
    expect(named.filter((column) => !TIMESTAMP_FIELDS.has(column.key)).map((column) => column.key)).toEqual([]);
  });

  it('covers the text date column v4 stores as a DATE, and names the one it carries verbatim', () => {
    expect(DATE_FIELDS.has('observations.source_date')).toBe(true);
    const textDates = [...postgres, ...sqlite].filter((column) => /(?:^|_)date$/u.test(column.name));
    expect(textDates.length).toBeGreaterThan(0);
    for (const column of textDates) expect(DATE_FIELDS.has(column.key) || VERBATIM_TEXT_DATES.has(column.key), column.key).toBe(true);
  });

  it('lists no column that no v3.2 table has', () => {
    const known = new Set([...postgres, ...sqlite].map((column) => column.key));
    expect([...TIMESTAMP_FIELDS, ...DATE_FIELDS].filter((key) => !known.has(key))).toEqual([]);
  });

  it('actually normalizes and reviews the two observation columns that were missed before', () => {
    const row = { id: 1, entity_id: 1, content: 'x', archived_at: '2026-04-01T02:00:00+02:00', last_accessed_at: '2026-04-01 00:00:00.123456' };
    const maps = buildValueMaps({ tables: { observations: [row] }, policy: { items: [] } });
    const keys = Object.keys(maps.timestamps).map((key) => key.split(':')[2]);
    expect(keys).toContain('archived_at');
    expect(maps.timestamps[Object.keys(maps.timestamps).find((key) => key.endsWith(':archived_at'))]).toBe('2026-04-01T00:00:00.000Z');
    // a naive value is not guessed: it is an unresolved item until a reviewer picks a timezone
    expect(maps.losses.map((loss) => `${loss.kind}:${loss.field}`)).toContain('unresolved-timestamp:last_accessed_at');
    const items = generateDecisionItems({ tables: { observations: [row] } });
    expect(items.filter((item) => item.type === 'timestamp').map((item) => item.field)).toEqual(['last_accessed_at']);
  });
});
