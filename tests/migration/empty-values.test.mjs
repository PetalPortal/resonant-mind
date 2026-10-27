import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { buildValueMaps, normalizeContext, normalizeDate, normalizeEntityKind, normalizeEnum, normalizeTimestamp } from '../../scripts/v32-to-v4/transform/value-map.mjs';

// An empty string is not a missing value. Where the generator lists it as a decision (enums, contexts, entity kinds: '' is not in the
// vocabulary) validate holds the target to the reviewed choice, so the transform has to apply that choice and not keep the empty text.
const entity = { id: 1, name: 'Ada', entity_type: '', primary_context: '', salience: 'active' };
const observation = { id: 5, entity_id: 1, content: 'c', weight: '', certainty: '', context: '', salience: 'active', added_at: '2026-01-01T00:00:00Z' };
const bundle = { migration_id: 'rmig_empty_values_test', bundle_manifest_sha256: 'b'.repeat(64), tables: { entities: [entity], observations: [observation] } };
const decided = (table, row, type, field, choice) => ({ source_table: table, source_row_sha256: canonicalSha256(row), type, field, choice });
const policy = { items: [
  decided('observations', observation, 'unknown-value', 'weight', { action: 'map', value: 'light' }),
  decided('observations', observation, 'unknown-value', 'certainty', { action: 'map', value: 'known' }),
  decided('observations', observation, 'unknown-value', 'context', { action: 'map-context', value: 'episodic' }),
  decided('entities', entity, 'unknown-value', 'primary_context', { action: 'map-context', value: 'default' }),
  decided('entities', entity, 'entity-kind', 'entity_type', { action: 'map-to-person', kind: 'person' }),
] };

describe('what the generator does with an empty string', () => {
  it('lists it for an enum, a context and an entity kind', () => {
    const items = generateDecisionItems(bundle).map((item) => `${item.type} ${item.source_table}.${item.field}`);
    expect(items).toEqual(expect.arrayContaining(['unknown-value observations.weight', 'unknown-value observations.certainty', 'unknown-value observations.context', 'unknown-value entities.primary_context', 'entity-kind entities.entity_type']));
  });

  it('lists no timestamp or date: there is nothing reviewed for the transform to apply', () => {
    const row = { id: 7, entity_id: 1, content: 'c', added_at: '', source_date: '' };
    expect(generateDecisionItems({ tables: { observations: [row] } }).filter((item) => item.type === 'timestamp' || item.type === 'date')).toEqual([]);
    expect(normalizeTimestamp('')).toBe('');
    expect(normalizeDate('')).toBe('');
  });
});

describe('an empty string takes the reviewed choice', () => {
  it('normalizeEnum refuses it without a choice and applies the choice with one', () => {
    expect(() => normalizeEnum('', 'weight')).toThrow(/reviewed/u);
    expect(normalizeEnum('', 'weight', { choice: { action: 'map', value: 'light' } })).toBe('light');
    expect(() => normalizeEnum('', 'weight', { choice: { action: 'map', value: 'enormous' } })).toThrow(/unsupported/u);
    expect(normalizeEnum(null, 'weight')).toBeNull();
    expect(normalizeEnum('Heavy', 'weight')).toBe('heavy');
  });

  it('normalizeContext refuses it without a choice and applies the choice with one', () => {
    expect(() => normalizeContext('')).toThrow(/reviewed/u);
    expect(normalizeContext('', { choice: { action: 'map-context', value: 'episodic' } })).toBe('episodic');
    expect(() => normalizeContext('', { choice: { action: 'map-context', value: 'nowhere' } })).toThrow(/unsupported/u);
    expect(normalizeContext(null)).toBeNull();
  });

  it('normalizeEntityKind refuses it without a choice and applies the choice with one', () => {
    expect(() => normalizeEntityKind('')).toThrow(/reviewed/u);
    expect(normalizeEntityKind('', { choice: { action: 'map-to-person', kind: 'person' } })).toBe('person');
    expect(normalizeEntityKind('', { choice: { action: 'map-to-node', kind: 'concept' } })).toBe('concept');
    expect(() => normalizeEntityKind('', { choice: { action: 'map-to-node', kind: 'person' } })).toThrow(/reviewed/u);
    expect(normalizeEntityKind(null)).toBeNull();
  });

  it('lands in the value map, and is an unresolved loss until it is reviewed', () => {
    const maps = buildValueMaps({ tables: bundle.tables, policy });
    const key = (table, row, field) => `${table}:${canonicalSha256(row)}${field ? `:${field}` : ''}`;
    expect(maps.losses).toEqual([]);
    expect(maps.enums[key('observations', observation, 'weight')]).toBe('light');
    expect(maps.enums[key('observations', observation, 'certainty')]).toBe('known');
    expect(maps.contexts[key('observations', observation, 'context')]).toBe('episodic');
    expect(maps.contexts[key('entities', entity, 'primary_context')]).toBe('default');
    expect(maps.entity_kinds[key('entities', entity)]).toBe('person');
    const unreviewed = buildValueMaps({ tables: bundle.tables, policy: { items: [] } });
    expect(unreviewed.losses.map((loss) => `${loss.kind}:${loss.field ?? ''}`).sort()).toEqual(['unresolved-context:context', 'unresolved-context:primary_context', 'unresolved-entity-kind:', 'unresolved-enum:certainty', 'unresolved-enum:weight']);
  });

  it('compiles into the policy the import writes from', () => {
    const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    const choiceOf = (item) => policy.items.find((entry) => entry.source_table === item.source_table && entry.source_row_sha256 === item.source_row_sha256 && entry.type === item.type && entry.field === item.field)?.choice;
    manifest.items = manifest.items.map((item) => ({ ...item, stated_by: 'owner', choice: choiceOf(item) }));
    manifest.reviewed = true; manifest.reviewed_by = 'test'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
    const compiled = compilePolicy({ bundle, decisions: manifest });
    expect(Object.values(compiled.value_map.enums)).toEqual(expect.arrayContaining(['known', 'light']));
    expect(Object.values(compiled.value_map.contexts)).toEqual(expect.arrayContaining(['default', 'episodic']));
    expect(Object.values(compiled.value_map.entity_kinds)).toEqual(['person']);
  });
});
