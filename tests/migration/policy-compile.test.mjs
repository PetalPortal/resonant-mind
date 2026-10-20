import { describe, expect, it } from 'vitest';
import { generateDecisionManifest, decisionManifestHash } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';

function reviewed(bundle) {
  const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  for (const item of manifest.items) item.choice = item.type === 'dormancy-translation' ? 'translate-to-orphan' : item.type === 'broken-foreign-key' ? 'null-if-allowed' : 'exclude-row';
  manifest.reviewed = true; manifest.reviewed_by = 'test-reviewer'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
  return manifest;
}

const base = {
  migration_id: 'rmig_transform_test', bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [{ id: 9, name: 'Δ Ada', entity_type: 'kin', primary_context: 'default' }],
    observations: [{ id: 30, entity_id: 9, content: 'line one\nline two', added_at: '1970-01-01 00:00:00' }],
    observation_versions: [
      { id: 4, observation_id: 30, content: 'old', changed_at: '2026-01-02 00:00:00' },
      { id: 2, observation_id: 30, content: 'new', changed_at: '2026-01-01 00:00:00' },
    ],
    images: [{ id: 6, path: 'objects/Δ.png', description: 'image', observation_id: 30, entity_id: 9, size: 3, sha256: 'c'.repeat(64) }],
    dormant_observations: [{ id: 8, observation_id: 30, first_marked: null }],
    embeddings: [{ id: 'e-1', source_type: 'observation', source_id: 30, content: 'line one', embedding: [1, 2, 3], metadata: '{}' }],
  },
};

describe('deterministic policy compilation and transformation', () => {
  it('numbers versions by observation, changed_at, and source id independent of input order', () => {
    const policy = reviewed(base);
    const first = compilePolicy({ bundle: base, decisions: policy });
    const reversed = { ...base, tables: Object.fromEntries(Object.entries(base.tables).map(([key, rows]) => [key, [...rows].reverse()]).reverse()) };
    const second = compilePolicy({ bundle: reversed, decisions: policy });
    expect(second.plan_sha256).toBe(first.plan_sha256);
    expect(Object.values(first.version_numbers).sort()).toEqual([1, 2]);
  });

  it('emits target staging, image inventory, and reembed jobs without legacy vectors', () => {
    const plan = compilePolicy({ bundle: base, decisions: reviewed(base) });
    const transformed = transformRelational({ bundle: base, compiledPolicy: plan });
    expect(transformed.members.observation_versions.find((row) => row.id === 2).version_num).toBe(1);
    expect(transformed.members.observation_versions.find((row) => row.id === 4).version_num).toBe(2);
    expect(transformed.image_inventory.entries[0]).toMatchObject({ source_logical_path: 'objects/Δ.png', expected_size: 3 });
    expect(transformed.reembed_jobs.legacy_vectors_imported).toBe(false);
    expect(transformed.reembed_jobs.jobs.some((job) => job.modality === 'image')).toBe(true);
    expect(canonicalJson(transformed)).not.toContain('[1,2,3]');
    expect(plan.mapping_tables).toContain('entities');
  });

  it('records, per entity, each NULL that the v4 routing trigger will fill in, instead of leaving it to a test comment', () => {
    const bundle = { ...base, tables: { entities: [
      { id: 1, name: 'has everything', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      { id: 2, name: 'no updated_at', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: null },
      { id: 3, name: 'nothing at all', entity_type: 'concept', primary_context: null, salience: null, created_at: null, updated_at: null },
    ] } };
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle) });
    const filled = plan.losses.filter((loss) => loss.kind === 'null-replaced-by-v4-default');
    expect(filled.map((loss) => loss.field).sort()).toEqual(['created_at', 'primary_context', 'salience', 'updated_at', 'updated_at']);
    expect(filled.every((loss) => loss.source_table === 'entities' && /^[0-9a-f]{64}$/u.test(loss.source_row_sha256) && /v4's entity routing trigger/u.test(loss.rationale))).toBe(true);
    expect(filled.find((loss) => loss.field === 'updated_at').rationale).toMatch(/import time/u);
    expect(plan.coverage.entities.losses).toBe(5);
    // the loss travels into the staging plan the dry run and the receipts are bound to
    expect(transformRelational({ bundle, compiledPolicy: plan }).losses).toEqual(plan.losses);
  });
});
