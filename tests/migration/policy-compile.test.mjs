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
    expect(transformed.members.observation_versions.find((row) => row.legacy_id === 2).version_num).toBe(1);
    expect(transformed.members.observation_versions.find((row) => row.legacy_id === 4).version_num).toBe(2);
    expect(transformed.image_inventory.entries[0]).toMatchObject({ source_logical_path: 'objects/Δ.png', expected_size: 3 });
    expect(transformed.reembed_jobs.legacy_vectors_imported).toBe(false);
    expect(transformed.reembed_jobs.jobs.some((job) => job.modality === 'image')).toBe(true);
    expect(canonicalJson(transformed)).not.toContain('[1,2,3]');
    expect(plan.mapping_tables).toContain('co_surfacing');
  });
});
