import { describe, expect, it } from 'vitest';
import {
  compareCatalog,
  fingerprintCatalog,
  normalizeCatalog,
  sourceSpecFor,
} from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import mapping from '../../scripts/v32-to-v4/spec/v3.2-to-v4-map.json' with { type: 'json' };

const catalog = {
  family: 'synthetic',
  tables: [{
    name: 'items',
    columns: [
      { name: 'id', type: 'INTEGER', nullable: false, default: null, pk_position: 1 },
      { name: 'label', type: 'TEXT', nullable: true, default: "'x'", pk_position: 0 },
    ],
    primary_key: ['id'],
    unique_constraints: [],
    foreign_keys: [],
    checks: [],
    indexes: [{ name: 'items_label_idx', unique: false, columns: ['label'], where: null }],
  }],
};

describe('exact v3.2 source fingerprints', () => {
  it('normalizes shuffled catalog rows before hashing', () => {
    const shuffled = structuredClone(catalog);
    shuffled.tables[0].columns.reverse();
    shuffled.tables[0].indexes.reverse();
    expect(fingerprintCatalog(shuffled)).toBe(fingerprintCatalog(catalog));
    expect(normalizeCatalog(shuffled)).toEqual(normalizeCatalog(catalog));
  });

  it.each([
    ['column type', (value) => { value.tables[0].columns[1].type = 'VARCHAR'; }],
    ['default', (value) => { value.tables[0].columns[1].default = "'y'"; }],
    ['nullability', (value) => { value.tables[0].columns[1].nullable = false; }],
    ['index', (value) => { value.tables[0].indexes[0].unique = true; }],
  ])('distinguishes %s drift with a bounded exact diff', (_label, mutate) => {
    const altered = structuredClone(catalog);
    mutate(altered);
    const result = compareCatalog(altered, catalog, { maxDiffs: 2 });
    expect(result.match).toBe(false);
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff.length).toBeLessThanOrEqual(2);
    expect(result.actualFingerprint).not.toBe(result.expectedFingerprint);
  });

  it('rejects an extra user table through exact comparison', () => {
    const altered = structuredClone(catalog);
    altered.tables.push({ name: 'private_notes', columns: [], primary_key: [], unique_constraints: [], foreign_keys: [], checks: [], indexes: [] });
    const result = compareCatalog(altered, catalog);
    expect(result.match).toBe(false);
    expect(result.diff.some((entry) => entry.kind === 'extra')).toBe(true);
  });

  it('bounds diffs and never performs fuzzy version matching', () => {
    const altered = structuredClone(catalog);
    altered.tables[0].columns[0].type = 'INTEGER /* v3.2-ish */';
    const result = compareCatalog(altered, catalog, { maxDiffs: 1 });
    expect(result.diff).toHaveLength(1);
    expect(result.match).toBe(false);
    expect(sourceSpecFor('sqlite').family).toBe('sqlite-v3.2-post-0003');
    expect(() => sourceSpecFor('v3.2-ish')).toThrow();
  });

  it('maps every table in both exact fingerprints', () => {
    const mapped = new Set(mapping.map((entry) => entry.source_table));
    for (const kind of ['postgres', 'sqlite']) {
      for (const table of sourceSpecFor(kind).tables) {
        expect(mapped.has(table.name), `${kind}:${table.name}`).toBe(true);
      }
    }
    expect(sourceSpecFor('postgres').tables.some((table) => table.name === 'embeddings')).toBe(true);
    expect(sourceSpecFor('sqlite').tables.some((table) => table.name === 'embeddings')).toBe(false);
  });
});
