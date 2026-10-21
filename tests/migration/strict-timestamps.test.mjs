import { describe, expect, it } from 'vitest';
import { decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { normalizeTimestamp } from '../../scripts/v32-to-v4/transform/value-map.mjs';

// new Date() rolls 2026-02-30 over to 1 March and reads T24:00:00 as midnight of the next day. A timestamp
// that is not a real calendar instant is refused, not repaired.
describe('timestamps are read as real calendar instants', () => {
  it.each([
    '2026-02-30T00:00:00Z', '2026-02-29T12:00:00+00:00', '2026-04-31T00:00:00.5Z', '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T23:60:00Z', '2026-01-01T23:59:60Z', '2026-01-01T00:00:00+25:00',
    '2026-02-30 00:00:00', '2026-01-01 24:00:00',
  ])('refuses %s without any reviewed choice', (value) => {
    expect(() => normalizeTimestamp(value, { table: 'observations', field: 'added_at' })).toThrow();
  });

  it('refuses them even when a reviewed timezone is offered, because no timezone makes them real', () => {
    for (const value of ['2026-02-30T00:00:00', '2026-01-01T24:00:00', '2026-02-30 03:04:05']) {
      expect(() => normalizeTimestamp(value, { choice: { action: 'normalize-utc', timezone: '+01:00' }, table: 'observations', field: 'added_at' })).toThrow();
    }
    // and an offset the text already carries is not overridden by a reviewed one
    expect(() => normalizeTimestamp('2026-01-01T00:00:00Z', { choice: { action: 'normalize-utc', timezone: '+00:00' } })).not.toThrow();
    expect(() => normalizeTimestamp('2026-02-29T00:00:00Z', { choice: { action: 'normalize-utc', timezone: '+00:00' } })).toThrow();
  });

  it('keeps every valid form exactly as before', () => {
    expect(normalizeTimestamp('2026-01-02T03:04:05.987654+00:00')).toBe('2026-01-02T03:04:05.987654Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05+01:00')).toBe('2026-01-02T02:04:05.000Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.123Z')).toBe('2026-01-02T03:04:05.123Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.123000Z')).toBe('2026-01-02T03:04:05.123Z');
    expect(normalizeTimestamp('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeTimestamp('2024-02-29T23:59:59Z')).toBe('2024-02-29T23:59:59.000Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05', { choice: { action: 'normalize-utc', timezone: '+01:00' } })).toBe('2026-01-02T02:04:05.000Z');
    expect(normalizeTimestamp('2026-01-02 03:04:05.5', { choice: { action: 'normalize-utc', timezone: 'UTC' } })).toBe('2026-01-02T03:04:05.500Z');
    expect(() => normalizeTimestamp('2026-01-02T03:04:05.1234567Z')).toThrow(/precision/u);
  });
});

describe('the draft names such a timestamp, and the dry run cannot be reached with one', () => {
  const bundle = (added) => ({
    migration_id: 'rmig_strict_time', bundle_manifest_sha256: 'b'.repeat(64),
    tables: { entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default' }], observations: [{ id: 5, entity_id: 1, content: 'a', added_at: added }] },
  });

  it('raises a decision item for 2026-02-30 and for 24:00, and none for a real instant', () => {
    expect(generateDecisionItems(bundle('2026-02-28T00:00:00Z')).filter((item) => item.type === 'timestamp')).toEqual([]);
    for (const value of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-02-30 00:00:00']) {
      const items = generateDecisionItems(bundle(value)).filter((item) => item.type === 'timestamp');
      expect(items, value).toHaveLength(1);
      expect(items[0].reason).toBe('timestamp is invalid');
      expect(items[0].allowed_choices).toEqual(['exclude-row']);
    }
  });

  it('compiles only if the row is excluded', () => {
    const b = bundle('2026-02-30T00:00:00Z');
    const manifest = generateDecisionManifest(b, { now: '2026-09-20T00:00:00.000Z' });
    manifest.items = manifest.items.map((item) => ({ ...item, stated_by: 'owner', choice: 'exclude-row' }));
    manifest.reviewed = true; manifest.reviewed_by = 'test'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
    expect(compilePolicy({ bundle: b, decisions: manifest }).excluded_rows.length).toBe(1);
    // a choice that cannot make the value real is not offered, and not accepted
    manifest.items = manifest.items.map((item) => ({ ...item, stated_by: 'owner', choice: { action: 'normalize-utc', timezone: '+00:00' } }));
    manifest.manifest_sha256 = decisionManifestHash(manifest);
    expect(() => compilePolicy({ bundle: b, decisions: manifest })).toThrow();
  });
});
