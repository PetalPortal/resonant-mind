import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { choiceForItem, decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { MigrationRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';

// One observation with two broken references. Each is its own decision, and a reviewer may answer them differently.
const bundle = {
  migration_id: 'rmig_binding_test', bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [{ id: 9, name: 'Ada', entity_type: 'person', primary_context: 'default' }],
    observations: [
      { id: 30, entity_id: 9, content: 'a', added_at: '2026-01-01T00:00:00Z' },
      { id: 31, entity_id: 9, content: 'b', added_at: '2026-01-02T00:00:00Z', superseded_by: 900, linked_observation_id: 901 },
    ],
  },
};

function review(manifest, chooser) {
  const copy = JSON.parse(JSON.stringify(manifest));
  for (const item of copy.items) item.choice = chooser(item);
  copy.reviewed = true; copy.reviewed_by = 'test-reviewer'; copy.reviewed_at = '2026-09-20T00:00:00.000Z'; copy.manifest_sha256 = decisionManifestHash(copy);
  return copy;
}

describe('a reviewed choice binds to exactly one item', () => {
  it('raises one item per broken reference, with distinct ids, instead of dropping the second', () => {
    const items = generateDecisionItems(bundle).filter((item) => item.type === 'broken-foreign-key');
    expect(items.map((item) => item.field).sort()).toEqual(['linked_observation_id', 'superseded_by']);
    expect(new Set(items.map((item) => item.decision_id)).size).toBe(2);
  });

  it('applies different choices to two broken references on one row', () => {
    const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    const reviewed = review(manifest, (item) => (item.field === 'superseded_by' ? 'null-if-allowed' : { action: 'link-by-reviewed-id', target_id: 30 }));
    const compiled = compilePolicy({ bundle, decisions: reviewed });
    const rowHash = canonicalSha256(bundle.tables.observations[1]);
    expect(compiled.link_map[`observations:${rowHash}:superseded_by`]).toBeNull();
    expect(compiled.link_map[`observations:${rowHash}:linked_observation_id`]).toBe(30);
    const planned = transformRelational({ bundle, compiledPolicy: compiled }).members.observations.find((row) => row.id === 31);
    expect(planned.superseded_by ?? null).toBeNull(); // a reviewed nullification is omitted from the staged row
    expect(planned.linked_observation_id).toBe(30);
  });

  it('does not hand one sibling field the choice meant for the other, even if the ids were forced to differ from the content', () => {
    const [first, second] = generateDecisionItems(bundle).filter((item) => item.type === 'broken-foreign-key');
    const decisions = { items: [{ ...first, choice: 'null-if-allowed' }, { ...second, choice: 'exclude-row' }] };
    expect(choiceForItem(decisions, first)).toBe('null-if-allowed');
    expect(choiceForItem(decisions, second)).toBe('exclude-row');
    // the second field's item with a foreign decision id (a hand-edited file) is not found by row hash and type
    expect(choiceForItem({ items: [{ ...first, choice: 'null-if-allowed' }] }, { ...second, decision_id: 'f'.repeat(64) })).toBeUndefined();
  });

  it('refuses an ambiguous match instead of taking the first', () => {
    const [first] = generateDecisionItems(bundle).filter((item) => item.type === 'broken-foreign-key');
    const decisions = { items: [{ ...first, choice: 'null-if-allowed' }, { ...first, choice: 'exclude-row' }] };
    expect(() => choiceForItem(decisions, first)).toThrow(MigrationRefusal);
    // an entry that carries the id but names another field is a contradiction, not a match
    const wrongField = { items: [{ ...first, field: first.field === 'superseded_by' ? 'linked_observation_id' : 'superseded_by', choice: 'null-if-allowed' }] };
    expect(() => choiceForItem(wrongField, first)).toThrow(MigrationRefusal);
  });

  it('keeps two unknown values on one row apart (a status and a context)', () => {
    const rows = { ...bundle, tables: { ...bundle.tables, threads: [{ id: 't1', thread_type: 'task', content: 'x', context: 'odd-context', priority: 'low', status: 'weird-status', source: 'self', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] } };
    const items = generateDecisionItems(rows).filter((item) => item.type === 'unknown-value');
    expect(items.map((item) => item.field).sort()).toEqual(['context', 'status']);
  });
  it('maps two unknown values on one row with two different reviewed choices', () => {
    const rows = { ...bundle, tables: { ...bundle.tables, threads: [{ id: 't1', thread_type: 'task', content: 'x', context: 'odd-context', priority: 'low', status: 'weird-status', source: 'self', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] } };
    const manifest = generateDecisionManifest(rows, { now: '2026-09-20T00:00:00.000Z' });
    const reviewed = review(manifest, (item) => (item.field === 'status' ? { action: 'map', value: 'resolved' } : item.field === 'context' ? { action: 'map-context', value: 'work' } : 'null-if-allowed'));
    const compiled = compilePolicy({ bundle: rows, decisions: reviewed });
    const rowHash = canonicalSha256(rows.tables.threads[0]);
    expect(compiled.value_map.enums[`threads:${rowHash}:status`]).toBe('resolved');
    expect(compiled.value_map.contexts[`threads:${rowHash}:context`]).toBe('work');
  });
  it('refuses reviewed decisions that belong to another migration than the bundle', () => {
    const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    const reviewed = review(manifest, (item) => (item.field === 'superseded_by' ? 'null-if-allowed' : { action: 'link-by-reviewed-id', target_id: 30 }));
    expect(() => compilePolicy({ bundle, decisions: reviewed })).not.toThrow();
    const foreign = { ...reviewed, migration_id: 'rmig_another_run_99' };
    foreign.manifest_sha256 = decisionManifestHash(foreign);
    expect(() => compilePolicy({ bundle, decisions: foreign })).toThrow(/different migration/u);
  });
});
