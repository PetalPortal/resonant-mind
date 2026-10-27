import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { MigrationRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';
import { buildReviewModel } from '../../scripts/v32-to-v4/lib/review-render.mjs';
import { decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { OBS_CONTEXTS } from '../../scripts/v32-to-v4/transform/target-schema.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { buildValueMaps, normalizeContext } from '../../scripts/v32-to-v4/transform/value-map.mjs';
import { compareSourceToTarget } from '../../scripts/v32-to-v4/validate/compare.mjs';

// The released v4 schema has a CHECK on observations.context only (migrations/postgres/0009), eight values. Every other context column
// is plain TEXT. So "a known context" and "a context a reviewer may map to" are the eight for observations.context, and the longer
// v3.2 list for the rest; a source value outside the list for its column is a decision, not something to find out at plan time.
const EIGHT = ['default', 'emotional-processing', 'interests-curiosities', 'creative-space', 'relational-models', 'episodic', 'values-ethics', 'research'];
const T = '2026-01-02T03:04:05Z';
const ada = { id: 1, name: 'Ada', entity_type: 'person', primary_context: 'primary', salience: 'active', created_at: T, updated_at: T };
const strayObservation = { id: 3, entity_id: 1, content: 'x', context: 'primary', added_at: T };
const bundle = {
  migration_id: 'rmig_obs_context_test', bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [ada],
    observations: [strayObservation, { id: 4, entity_id: 1, content: 'y', context: 'Episodic', added_at: T }, { id: 5, entity_id: 1, content: 'z', context: 'default', added_at: T }],
    threads: [{ id: 'thr-1', thread_type: 'task', content: 'c', context: 'private', priority: 'low', status: 'active', created_at: T, updated_at: T }],
    context_entries: [{ id: 'ctx-1', scope: 'work', content: 'now', links: '[]', updated_at: T }],
  },
};
const itemsFor = (tables) => generateDecisionItems({ tables }).filter((item) => item.type === 'unknown-value').map((item) => `${item.source_table}.${item.field}`);

function review(choose) {
  const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  const manifest = { ...draft, items: draft.items.map((item) => ({ ...item, stated_by: 'owner', choice: choose(item) })), reviewed: true, reviewed_by: 'test', reviewed_at: '2026-09-20T00:01:00.000Z' };
  manifest.manifest_sha256 = decisionManifestHash(manifest);
  return manifest;
}

describe('the vocabulary of a context column is the column\'s own', () => {
  it('is the v4 CHECK, not a copy of it, for observations.context', () => {
    expect([...OBS_CONTEXTS].sort()).toEqual([...EIGHT].sort());
  });

  it('raises a decision for an observation context outside the eight, and none for the same value in another column', () => {
    expect(itemsFor({ observations: [strayObservation] })).toEqual(['observations.context']);
    expect(itemsFor({ entities: [ada] })).toEqual([]); // entities.primary_context = 'primary' is plain TEXT in v4
    expect(itemsFor({ entities: [{ ...ada, primary_context: 'private' }], threads: bundle.tables.threads, context_entries: bundle.tables.context_entries })).toEqual([]);
    expect(itemsFor({ observations: [{ id: 1, entity_id: 1, content: 'x', context: 'private' }] })).toEqual(['observations.context']);
    expect(itemsFor({ observations: [{ id: 1, entity_id: 1, content: 'x', context: 'Values-Ethics' }, { id: 2, entity_id: 1, content: 'x', context: 'default' }] })).toEqual([]);
    expect(itemsFor({ entities: [{ ...ada, primary_context: 'nonsense' }] })).toEqual(['entities.primary_context']); // the longer list still ends somewhere
  });

  it('offers the review exactly the eight for observations.context, and the longer list for another column', () => {
    const odd = { ...bundle, tables: { ...bundle.tables, entities: [{ ...ada, primary_context: 'nonsense' }] } };
    const model = buildReviewModel({ bundle: odd, decisions: generateDecisionManifest(odd, { now: '2026-09-20T00:00:00.000Z' }) });
    const accepted = (table) => {
      const item = model.items.find((entry) => entry.table === table && entry.type === 'unknown-value');
      const pair = item.sections.flatMap((section) => section.facts ?? []).find(([label]) => label === 'values v4 accepts');
      return pair[1].split(', ');
    };
    expect(accepted('observations').sort()).toEqual([...EIGHT].sort());
    expect(accepted('entities')).toEqual(expect.arrayContaining(['private', 'primary', ...EIGHT]));
    expect(accepted('entities')).toHaveLength(20);
  });

  it('normalizeContext refuses to map into the long list for observations.context, and still accepts it elsewhere', () => {
    const toPrivate = { choice: { action: 'map-context', value: 'private' } };
    expect(() => normalizeContext('primary', { choice: toPrivate, table: 'observations', field: 'context' })).toThrow(/unsupported/u);
    expect(() => normalizeContext('primary', { table: 'observations', field: 'context' })).toThrow(/reviewed/u);
    expect(() => normalizeContext('private', { table: 'observations', field: 'context' })).toThrow(/reviewed/u);
    expect(normalizeContext('nonsense', { choice: toPrivate, table: 'entities', field: 'primary_context' })).toBe('private');
    expect(normalizeContext('nonsense', { choice: toPrivate, table: 'threads', field: 'context' })).toBe('private');
    expect(normalizeContext('nonsense', { choice: toPrivate })).toBe('private'); // no column named: the long list, as before
    expect(normalizeContext('primary', { table: 'entities', field: 'primary_context' })).toBe('primary');
    expect(normalizeContext('Episodic', { table: 'observations', field: 'context' })).toBe('episodic');
    expect(normalizeContext('primary', { choice: { action: 'map-context', value: 'Episodic' }, table: 'observations', field: 'context' })).toBe('episodic');
  });

  it('lands a reviewed map-context in the value map, and leaves the same word in another column as it was', () => {
    const tables = { entities: [ada], observations: [strayObservation] };
    const choice = { action: 'map-context', value: 'episodic' };
    const policy = { items: [{ source_table: 'observations', source_row_sha256: canonicalSha256(strayObservation), type: 'unknown-value', field: 'context', choice }] };
    const maps = buildValueMaps({ tables, policy });
    expect(maps.losses).toEqual([]);
    expect(maps.contexts[`observations:${canonicalSha256(strayObservation)}:context`]).toBe('episodic');
    expect(maps.contexts[`entities:${canonicalSha256(ada)}:primary_context`]).toBe('primary');
    // unreviewed, or reviewed to a value the v4 CHECK refuses: an unresolved loss, which compile-policy refuses
    expect(buildValueMaps({ tables, policy: { items: [] } }).losses.map((loss) => `${loss.kind}:${loss.field}`)).toEqual(['unresolved-context:context']);
    const toPrivate = { items: [{ ...policy.items[0], choice: { action: 'map-context', value: 'private' } }] };
    expect(buildValueMaps({ tables, policy: toPrivate }).losses.map((loss) => `${loss.kind}:${loss.field}`)).toEqual(['unresolved-context:context']);
  });
});

describe('from the draft to the plan to validate', () => {
  const choose = (value) => (item) => (item.source_table === 'observations' && item.field === 'context' ? { action: 'map-context', value } : undefined);

  it('compiles and plans a reviewed map to one of the eight, and validate holds the target to it', () => {
    const decisions = review(choose('episodic'));
    const compiled = compilePolicy({ bundle, decisions });
    const plan = transformRelational({ bundle, compiledPolicy: compiled });
    const byId = (id) => plan.members.observations.find((row) => row.id === id);
    expect([byId(3).context, byId(4).context, byId(5).context]).toEqual(['episodic', 'episodic', 'default']);
    expect(plan.members.people.find((row) => row.id === 1).primary_context).toBe('primary');
    const compare = (tables) => compareSourceToTarget({ sourceTables: bundle.tables, targetTables: tables, compiled, decisions, importedAt: null, family: 'postgres' });
    expect(compare(structuredClone(plan.members)).findings.samples).toEqual([]);
    const damaged = structuredClone(plan.members);
    damaged.observations.find((row) => row.id === 3).context = 'primary'; // what the import would have to write for the old long list
    expect(compare(damaged).findings.samples).toContainEqual(expect.objectContaining({ check: 'cell-mismatch', column: 'context', difference: 'context' }));
  });

  it('refuses at compile-policy a reviewed map to a value outside the eight, before any plan is made', () => {
    const decisions = review(choose('private'));
    expect(() => compilePolicy({ bundle, decisions })).toThrow(MigrationRefusal);
    try { compilePolicy({ bundle, decisions }); } catch (error) { expect(error.code).toBe('RMIG-E-POLICY-UNRESOLVED'); }
  });
});
