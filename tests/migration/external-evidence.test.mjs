import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { buildImageInventory } from '../../scripts/v32-to-v4/external/images.mjs';
import { generateDecisionManifest, decisionManifestHash } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { Findings } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { checkExternalEvidence } from '../../scripts/v32-to-v4/validate/external-evidence.mjs';
import { determineMigrationStatus } from '../../scripts/v32-to-v4/validate/reconcile.mjs';

// The evidence check, with no database: the bundle, the decisions and the plan are real, the target is a set of rows.
const MIGRATION_ID = 'rmig_evidence_test';
const bundle = {
  migration_id: MIGRATION_ID, bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [{ id: 9, name: 'Ada', entity_type: 'person', primary_context: 'default' }],
    observations: [{ id: 30, entity_id: 9, content: 'a thought about the garden', added_at: '2026-01-01T00:00:00Z' }],
    images: [
      { id: 6, path: 'objects/one.png', description: 'one', observation_id: 30, entity_id: 9, size: 3, sha256: 'c'.repeat(64), mime: 'image/png' },
      { id: 7, path: 'objects/two.png', description: 'two', observation_id: 30, entity_id: 9, size: 4, sha256: 'd'.repeat(64), mime: 'image/png' },
    ],
  },
};

function plan() {
  const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  for (const item of manifest.items) item.choice = 'exclude-row';
  manifest.reviewed = true; manifest.reviewed_by = 'test-reviewer'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
  const compiled = compilePolicy({ bundle, decisions: manifest });
  return transformRelational({ bundle, compiledPolicy: compiled });
}

function imageReceipt(imagePlan, overrides = {}) {
  const body = {
    format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: imagePlan.migration_id, plan_sha256: imagePlan.plan_sha256,
    ...(imagePlan.bundle_manifest_sha256 === undefined ? {} : { bundle_manifest_sha256: imagePlan.bundle_manifest_sha256 }),
    ...(imagePlan.compiled_policy_sha256 === undefined ? {} : { compiled_policy_sha256: imagePlan.compiled_policy_sha256 }),
    entries: imagePlan.entries.map((entry) => ({ target_key: entry.target_key, source_logical_path: entry.source_logical_path, target_locator: entry.target_locator, verified: true, sha256: entry.expected_sha256, source_sha256: entry.expected_sha256, size: entry.expected_size, mime: entry.expected_mime })),
    ...overrides,
  };
  return { ...body, receipt_sha256: canonicalSha256(body) };
}

function reembedReceipts(reembedPlan, { drop = 0 } = {}) {
  return {
    format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256,
    receipts: reembedPlan.jobs.slice(drop).map((job) => ({ job_id: job.job_id, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'test-model', dimension: 3, content_hash: job.content_hash, ...(job.modality === 'image' ? { source_logical_path: job.source_logical_path, target_key: job.target_key, object_sha256: job.object_sha256, source_sha256: job.object_sha256, object_size: job.object_size, object_mime: job.object_mime } : {}) })),
  };
}

/** The target as the importer left it: every planned row, with the images table holding the planned image rows. */
function targetFor(relational) {
  const tables = { images: relational.image_inventory.entries.map((entry) => ({ id: entry.linked_target_ids.image_id })) };
  for (const [table, rows] of Object.entries(relational.members)) if (table !== 'images') tables[table] = rows.map((row) => ({ ...row }));
  return tables;
}

const run = ({ relational, files, tables = targetFor(relational) }) => {
  const findings = new Findings();
  const evidence = checkExternalEvidence({
    derived: { members: relational.members, imageInventory: relational.image_inventory, reembedPlan: relational.reembed_jobs },
    files, migrationId: MIGRATION_ID, live: { tables, columnTypes: {}, importedAt: null }, findings,
  });
  return { evidence, findings };
};

describe('external evidence is held to the plan validate derives, not to the plan it is handed', () => {
  const relational = plan();

  it('accepts the planned inventory with a matching receipt, and the planned re-embedding jobs with receipts for unchanged rows', () => {
    expect(relational.image_inventory.entries).toHaveLength(2);
    const { evidence, findings } = run({ relational, files: { imagePlan: relational.image_inventory, imageReceipt: imageReceipt(relational.image_inventory), reembedPlan: relational.reembed_jobs, reembedReceipts: reembedReceipts(relational.reembed_jobs) } });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, evidence_supplied: true, planned: 2 });
    expect(evidence.reembed).toMatchObject({ complete: true, evidence_supplied: true });
  });

  it.each([
    ['a smaller image plan', (inventory) => buildImageInventory({ images: [bundle.tables.images[0]], migrationId: MIGRATION_ID, bundleManifestSha256: inventory.bundle_manifest_sha256, compiledPolicySha256: inventory.compiled_policy_sha256 })],
    ['an empty image plan', (inventory) => buildImageInventory({ images: [], migrationId: MIGRATION_ID, bundleManifestSha256: inventory.bundle_manifest_sha256, compiledPolicySha256: inventory.compiled_policy_sha256 })],
    ['a different image plan', (inventory) => buildImageInventory({ images: [{ ...bundle.tables.images[0], id: 60, path: 'objects/elsewhere.png' }, { ...bundle.tables.images[1], id: 70, path: 'objects/other.png' }], migrationId: MIGRATION_ID, bundleManifestSha256: inventory.bundle_manifest_sha256, compiledPolicySha256: inventory.compiled_policy_sha256 })],
  ])('refuses %s even when its receipt matches it exactly', (_label, build) => {
    const supplied = build(relational.image_inventory);
    const { evidence, findings } = run({ relational, files: { imagePlan: supplied, imageReceipt: imageReceipt(supplied) } });
    expect(findings.counts['external-image-plan-not-the-planned-inventory']).toBe(1);
    expect(evidence.images.complete).toBe(false);
    // and the report that follows can never reach a ready state
    const report = { relational_reconciliation_complete: true, dry_run_receipt_complete: true, import_receipt_complete: true, target_present: true, imported: true, images_complete: evidence.images.complete, reembed_complete: true };
    expect(determineMigrationStatus(report, { requireReportHash: false })).toBe('data-imported-images-pending');
  });

  it('finds an image row the plan does not list, and a listed image with no row', () => {
    const extra = targetFor(relational);
    extra.images.push({ id: 999 });
    const surplus = run({ relational, files: { imagePlan: relational.image_inventory, imageReceipt: imageReceipt(relational.image_inventory) }, tables: extra });
    expect(surplus.findings.counts['image-row-not-in-image-plan']).toBe(1);
    expect(surplus.evidence.images.complete).toBe(false);
    const fewer = targetFor(relational);
    fewer.images.pop();
    const missing = run({ relational, files: { imagePlan: relational.image_inventory, imageReceipt: imageReceipt(relational.image_inventory) }, tables: fewer });
    expect(missing.findings.counts['image-plan-entry-without-row']).toBe(1);
    expect(missing.evidence.images.complete).toBe(false);
  });

  it('needs the plan and the receipt together', () => {
    const { evidence, findings } = run({ relational, files: { imagePlan: relational.image_inventory } });
    expect(findings.counts['external-image-evidence-incomplete']).toBe(1);
    expect(evidence.images.complete).toBe(false);
  });

  it('checks the re-embedding receipts against the content the target holds now', () => {
    const files = { reembedPlan: relational.reembed_jobs, reembedReceipts: reembedReceipts(relational.reembed_jobs) };
    const changed = targetFor(relational);
    changed.observations[0] = { ...changed.observations[0], content: 'changed after the receipts were issued' };
    const edited = run({ relational, files, tables: changed });
    expect(edited.findings.counts['external-reembed-receipt-invalid']).toBe(1);
    expect(edited.findings.samples[0].reasons).toContain('target-content-changed');
    expect(edited.evidence.reembed.complete).toBe(false);

    const gone = targetFor(relational);
    gone.observations = [];
    const missing = run({ relational, files, tables: gone });
    expect(missing.findings.samples[0].reasons).toContain('target-row-missing');
  });

  it('refuses a re-embedding plan that is not the one these imported rows produce', () => {
    const foreign = { ...relational.reembed_jobs, jobs: relational.reembed_jobs.jobs.slice(1) };
    delete foreign.plan_sha256;
    foreign.plan_sha256 = canonicalSha256(foreign);
    const { findings, evidence } = run({ relational, files: { reembedPlan: foreign, reembedReceipts: reembedReceipts(foreign) } });
    expect(findings.counts['reembed-plan-not-derived-from-imported-rows']).toBe(1);
    expect(evidence.reembed.complete).toBe(false);
  });
});
