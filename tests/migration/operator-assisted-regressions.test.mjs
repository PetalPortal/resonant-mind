import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { buildReembedPlan, validateReembedReceipts } from '../../scripts/v32-to-v4/external/reembed.mjs';
import { reconcileMigration } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
import { validateInvariants } from '../../scripts/v32-to-v4/validate/invariants.mjs';
import { appendCheckpoint } from '../../scripts/v32-to-v4/lib/checkpoints.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function bodyWithHash(body) {
  return { ...body, receipt_sha256: canonicalSha256(body) };
}

function reembedReceipt(plan, bindings = true) {
  const job = plan.jobs[0];
  return {
    format_version: 1,
    migration_id: plan.migration_id,
    plan_sha256: plan.plan_sha256,
    ...(bindings ? { bundle_manifest_sha256: plan.bundle_manifest_sha256, compiled_policy_sha256: plan.compiled_policy_sha256 } : {}),
    receipts: [{
      job_id: job.job_id,
      migration_id: plan.migration_id,
      plan_sha256: plan.plan_sha256,
      ...(bindings ? { bundle_manifest_sha256: plan.bundle_manifest_sha256, compiled_policy_sha256: plan.compiled_policy_sha256 } : {}),
      target_locator: job.target_locator,
      status: 'complete',
      model: 'test-model',
      dimension: 3,
      content_hash: job.content_hash,
    }],
  };
}

describe('operator-assisted migration adversarial regressions', () => {
  it('requires re-embedding envelope and receipt bindings to bundle and policy', () => {
    const plan = buildReembedPlan({ members: { observations: [{ id: 1, content: 'x' }] }, migrationId: 'rmig_regress_01', bundleManifestSha256: HASH_A, compiledPolicySha256: HASH_B });
    expect(() => validateReembedReceipts({ plan, receipts: reembedReceipt(plan, false), expectedModel: 'test-model', expectedDimension: 3 })).toThrow();
    expect(validateReembedReceipts({ plan, receipts: reembedReceipt(plan), expectedModel: 'test-model', expectedDimension: 3 })).toMatchObject({ complete: true });
  });

  it('rejects forged dry-run and import receipt bodies instead of trusting a digest-shaped field', () => {
    const imagePlan = { format_version: 1, plan_type: 'image-inventory', migration_id: 'rmig_regress_02', entries: [] };
    imagePlan.plan_sha256 = canonicalSha256(imagePlan);
    const reembedPlan = buildReembedPlan({ members: {}, migrationId: imagePlan.migration_id });
    const reembedReceipts = { format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, receipts: [] };
    const dryRun = bodyWithHash({ format_version: 1, receipt_type: 'fresh-v4-dry-run', status: 'validated', migration_id: imagePlan.migration_id, bundle_manifest_sha256: HASH_A, compiled_policy_sha256: HASH_B, plan_sha256: HASH_A, target_identity_sha256: HASH_B, target_state_sha256: HASH_A, stage_content_sha256: HASH_B, migration_set_sha256: HASH_A, migrator_version: '4.0.1' });
    const importReceipt = bodyWithHash({ format_version: 1, receipt_type: 'fresh-v4-import', status: 'complete', migration_id: imagePlan.migration_id, bundle_manifest_sha256: HASH_A, compiled_policy_sha256: HASH_B, plan_sha256: HASH_A, target_identity_sha256: HASH_B, target_state_sha256: HASH_A, stage_content_sha256: HASH_B, migration_set_sha256: HASH_A, migrator_version: '4.0.1', dry_run_receipt_sha256: dryRun.receipt_sha256 });
    const report = reconcileMigration({ source: { migration_id: imagePlan.migration_id, observations: [] }, exported: { observations: [] }, staged: { observations: [] }, target: { observations: [] }, imagePlan, imageReceipt: { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: imagePlan.migration_id, plan_sha256: imagePlan.plan_sha256, entries: [] }, reembedPlan, reembedReceipts, dryRunReceipt: { ...dryRun, target_state_sha256: HASH_B }, importReceipt });
    expect(report.violations.map(({ check }) => check)).toContain('dry-run-receipt-invalid');
  });

  it('does not let empty caller invariant specs erase catalog-derived constraints', () => {
    const catalog = { inventory_complete: true, tables: [
      { name: 'parents', columns: [{ name: 'id' }], primary_key: ['id'], unique_constraints: [], foreign_keys: [], checks: [], sequences: [] },
      { name: 'children', columns: [{ name: 'id' }, { name: 'parent_id' }], primary_key: ['id'], unique_constraints: [], foreign_keys: [{ columns: ['parent_id'], references: { table: 'parents', columns: ['id'] } }], checks: [], sequences: [] },
    ] };
    const migrations = [{ version: '001', checksum: HASH_A }];
    const result = validateInvariants({ catalog, currentMigrations: migrations, migrationSetSha256: canonicalSha256(migrations), target: { parents: [], children: [{ id: 1, parent_id: 99 }] }, relationships: [], unique: [], checks: [], sequences: [] });
    expect(result.violations.some(({ check }) => check === 'foreign-key')).toBe(true);
  });

  it('rejects observation version gaps, not only invalid starting numbers', () => {
    const catalog = { inventory_complete: true, tables: [{ name: 'observation_versions', columns: [{ name: 'observation_id' }, { name: 'version_num' }], primary_key: ['observation_id', 'version_num'], unique_constraints: [], foreign_keys: [], checks: [], sequences: [] }] };
    const migrations = [{ version: '001', checksum: HASH_A }];
    const result = validateInvariants({ catalog, currentMigrations: migrations, migrationSetSha256: canonicalSha256(migrations), target: { observation_versions: [{ observation_id: 1, version_num: 1 }, { observation_id: 1, version_num: 3 }] } });
    expect(result.violations.some(({ check }) => check === 'observation-version-gap')).toBe(true);
  });

  it('refuses checkpoint chains that skip semantic phases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rmig-checkpoint-regression-'));
    appendCheckpoint(dir, { name: 'source-inspected', migration_id: 'rmig_regress_03', artifact_sha256: HASH_A, details: {} });
    expect(() => appendCheckpoint(dir, { name: 'policy-compiled', migration_id: 'rmig_regress_03', artifact_sha256: HASH_A, details: {} })).toThrow();
  });
});
