import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemObjectStore, copyImagePlan, buildFilesystemInventory } from '../../scripts/v32-to-v4/external/filesystem-store.mjs';
import { buildImageInventory } from '../../scripts/v32-to-v4/external/images.mjs';
import { buildReembedPlan } from '../../scripts/v32-to-v4/external/reembed.mjs';
import { validateReembedReceipts } from '../../scripts/v32-to-v4/external/receipt.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { appendCheckpoint, readCheckpointChain, maybeInjectCheckpointFault } from '../../scripts/v32-to-v4/lib/checkpoints.mjs';
import { reconcileMigration, determineMigrationStatus } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
import { buildDryRunReport, buildImportReceipt } from '../../scripts/v32-to-v4/target/postgres.mjs';

const sha = (value) => /^[0-9a-f]{64}$/.test(value);
const SHA = 'a'.repeat(64);

function tempRoot() { return mkdtempSync(join(tmpdir(), 'rmig-')); }

describe('external image inventory and receipts', () => {
  it('inventories, copies, and verifies bytes without following symlinks', async () => {
    const source = tempRoot(); const target = tempRoot();
    mkdirSync(join(source, 'nested')); writeFileSync(join(source, 'nested', 'a.png'), Buffer.from([137, 80, 78, 71]));
    const store = new FilesystemObjectStore(source);
    const inventory = await store.inventory();
    expect(inventory).toHaveLength(1); expect(inventory[0]).toMatchObject({ key: 'nested/a.png', size: 4, mime: 'image/png' }); expect(sha(inventory[0].sha256)).toBe(true);
    const imagePlan = buildImageInventory({ images: inventory, migrationId: 'rmig_external_01' });
    const receipt = await copyImagePlan({ plan: imagePlan, sourceStore: store, targetStore: new FilesystemObjectStore(target) });
    expect(receipt.status).toBe('complete'); expect(receipt.entries[0].verified).toBe(true);
    expect(readFileSync(join(target, ...receipt.entries[0].target_key.split('/')))).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it('refuses source traversal and symlink escapes', async () => {
    const root = tempRoot(); const outside = tempRoot(); writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(root, 'link'), 'junction');
    await expect(buildFilesystemInventory(root, { keys: ['../secret'] })).rejects.toMatchObject({ code: 'RMIG-E-IMAGE-INCOMPLETE' });
    await expect(new FilesystemObjectStore(root).inventory()).rejects.toMatchObject({ code: 'RMIG-E-IMAGE-INCOMPLETE' });
  });
});

describe('re-embedding receipts', () => {
  it('is deterministic and rejects incomplete or changed jobs', () => {
    const args = { migrationId: 'rmig_reembed_01', members: { observations: [{ id: 1, content: 'hello' }] }, images: [{ target_key: 'images/x', source_logical_path: 'x.png', expected_sha256: SHA, expected_size: 8, expected_mime: 'image/png' }] };
    const left = buildReembedPlan(args); const right = buildReembedPlan(args);
    expect(left).toEqual(right); expect(left.legacy_vectors_imported).toBe(false); expect(left.jobs).toHaveLength(2);
    const job = left.jobs[0];
    expect(() => validateReembedReceipts({ expectedModel: 'test-model', expectedDimension: 3, plan: left, receipts: { format_version: 1, migration_id: left.migration_id, plan_sha256: left.plan_sha256, receipts: [{ job_id: job.job_id, status: 'partial' }] } })).toThrowError(expect.objectContaining({ code: 'RMIG-E-REEMBED-INCOMPLETE' }));
    expect(() => validateReembedReceipts({ expectedModel: 'test-model', expectedDimension: 3, plan: left, targetRows: { [`${job.target_locator.table}:${job.target_locator.id}`]: { id: job.target_locator.id, content: 'changed' } }, receipts: { format_version: 1, migration_id: left.migration_id, plan_sha256: left.plan_sha256, receipts: [{ job_id: job.job_id, target_locator: job.target_locator, migration_id: left.migration_id, plan_sha256: left.plan_sha256, status: 'complete', model: 'test-model', dimension: 3, content_hash: job.content_hash }] } })).toThrowError(expect.objectContaining({ code: 'RMIG-E-REEMBED-INCOMPLETE' }));
    const complete = left.jobs.map((item) => ({ job_id: item.job_id, migration_id: left.migration_id, plan_sha256: left.plan_sha256, target_locator: item.target_locator, ...(item.modality === 'image' ? { source_logical_path: item.source_logical_path, target_key: item.target_key, ...(item.object_sha256 === undefined ? {} : { object_sha256: item.object_sha256, source_sha256: item.object_sha256 }), ...(item.object_size === undefined ? {} : { object_size: item.object_size }), ...(item.object_mime === undefined ? {} : { object_mime: item.object_mime }) } : {}), status: 'complete', model: 'test-model', dimension: 3, content_hash: item.content_hash }));
    expect(validateReembedReceipts({ expectedModel: 'test-model', expectedDimension: 3, plan: left, receipts: { format_version: 1, migration_id: left.migration_id, plan_sha256: left.plan_sha256, receipts: complete }, expectedModel: 'test-model', expectedDimension: 3 })).toMatchObject({ complete: true, status: 'complete' });
  });
});

describe('append-only checkpoints and final reconciliation', () => {
  it('chains checkpoints, resumes idempotently, and rejects tampering', () => {
    const dir = tempRoot();
    appendCheckpoint(dir, { name: 'source-inspected', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: { count: 1 } });
    appendCheckpoint(dir, { name: 'bundle-member:data/entities.ndjson', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: {} });
    appendCheckpoint(dir, { name: 'bundle-finalized', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: {} });
    appendCheckpoint(dir, { name: 'policy-compiled', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: {} });
    expect(readCheckpointChain(dir)).toHaveLength(4);
    writeFileSync(join(dir, '000001.json'), readFileSync(join(dir, '000001.json'), 'utf8').replace('source-inspected', 'tampered'));
    expect(() => readCheckpointChain(dir)).toThrowError(expect.objectContaining({ code: 'RMIG-E-CHECKPOINT' }));
  });

  it('refuses fault injection outside test mode', () => {
    const prior = process.env.RM_MIGRATOR_FAULT_AFTER; const env = process.env.NODE_ENV;
    process.env.RM_MIGRATOR_FAULT_AFTER = 'source-inspected'; process.env.NODE_ENV = 'production';
    expect(() => maybeInjectCheckpointFault('source-inspected')).toThrowError(expect.objectContaining({ code: 'RMIG-E-CHECKPOINT' }));
    if (prior === undefined) delete process.env.RM_MIGRATOR_FAULT_AFTER; else process.env.RM_MIGRATOR_FAULT_AFTER = prior;
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
  });

  it('reports readiness only when relational and external receipts reconcile', () => {
    const imagePlan = buildImageInventory({ images: [], migrationId: 'rmig_reconcile_01' });
    const imageReceipt = { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: imagePlan.migration_id, plan_sha256: imagePlan.plan_sha256, entries: [] };
    imageReceipt.receipt_sha256 = canonicalSha256(imageReceipt);
    const reembedPlan = buildReembedPlan({ members: {}, migrationId: 'rmig_reconcile_01' });
    const reembedReceipts = { format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, receipts: [] };
    const rowset = { observations: [{ id: 1, content: 'x' }] };
    const plan = { migration_id: imagePlan.migration_id, bundle_manifest_sha256: SHA, compiled_policy_sha256: 'b'.repeat(64), members: {}, coverage: {}, losses: [] };
    const targetIdentity = { database_identity_sha256: 'd'.repeat(64) };
    const dryRunReceipt = buildDryRunReport({ plan, targetIdentity, migrationSetSha256: '1'.repeat(64), migratorVersion: '4.0.1', stageContentSha256: canonicalSha256({}), targetStateSha256: canonicalSha256({}) });
    const importReceipt = buildImportReceipt({ plan, dryRun: dryRunReceipt, targetIdentity, insertedRows: 0 });
    const report = reconcileMigration({ toolObservedImageObjects: true, expectedModel: 'test-model', expectedDimension: 3, source: { ...rowset, migration_id: imagePlan.migration_id }, exported: rowset, staged: rowset, target: rowset, imagePlan, imageReceipt, reembedPlan, reembedReceipts, dryRunReceipt, importReceipt });
    expect(report.status).toBe('ready-for-cutover'); expect(determineMigrationStatus(report)).toBe('ready-for-cutover');
  });
});
