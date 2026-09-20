import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemObjectStore, copyImagePlan, buildFilesystemInventory } from '../../scripts/v32-to-v4/external/filesystem-store.mjs';
import { buildImageInventory } from '../../scripts/v32-to-v4/external/images.mjs';
import { buildReembedPlan } from '../../scripts/v32-to-v4/external/reembed.mjs';
import { validateReembedReceipts } from '../../scripts/v32-to-v4/external/receipt.mjs';
import { appendCheckpoint, readCheckpointChain, maybeInjectCheckpointFault } from '../../scripts/v32-to-v4/lib/checkpoints.mjs';
import { reconcileMigration, determineMigrationStatus } from '../../scripts/v32-to-v4/validate/reconcile.mjs';

const sha = (value) => /^[0-9a-f]{64}$/.test(value);

function tempRoot() { return mkdtempSync(join(tmpdir(), 'rmig-')); }

describe('external image inventory and receipts', () => {
  it('inventories, copies, and verifies bytes without following symlinks', async () => {
    const source = tempRoot(); const target = tempRoot();
    mkdirSync(join(source, 'nested')); writeFileSync(join(source, 'nested', 'a.png'), Buffer.from([137, 80, 78, 71]));
    const store = new FilesystemObjectStore(source);
    const inventory = await store.inventory();
    expect(inventory).toHaveLength(1); expect(inventory[0]).toMatchObject({ key: 'nested/a.png', size: 4, mime: 'image/png' }); expect(sha(inventory[0].sha256)).toBe(true);
    const receipt = await copyImagePlan({ plan: { entries: inventory.map((item) => ({ source_logical_path: item.key, target_key: `images/${item.sha256}.png`, expected_sha256: item.sha256, expected_size: item.size, expected_mime: item.mime })) }, sourceStore: store, targetStore: new FilesystemObjectStore(target) });
    expect(receipt.status).toBe('complete'); expect(receipt.entries[0].verified).toBe(true);
    expect(readFileSync(join(target, 'images', `${inventory[0].sha256}.png`))).toEqual(Buffer.from([137, 80, 78, 71]));
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
    const args = { migrationId: 'rmig_reembed_01', members: { observations: [{ id: 1, content: 'hello' }] }, images: [{ target_key: 'images/x', source_logical_path: 'x.png' }] };
    const left = buildReembedPlan(args); const right = buildReembedPlan(args);
    expect(left).toEqual(right); expect(left.legacy_vectors_imported).toBe(false); expect(left.jobs).toHaveLength(2);
    const job = left.jobs[0];
    expect(() => validateReembedReceipts({ plan: left, receipts: [{ job_id: job.job_id, status: 'partial' }] })).toThrowError(expect.objectContaining({ code: 'RMIG-E-REEMBED-INCOMPLETE' }));
    expect(() => validateReembedReceipts({ plan: left, targetRows: { [`${job.target_locator.table}:${job.target_locator.id}`]: { id: job.target_locator.id, content: 'changed' } }, receipts: [{ job_id: job.job_id, status: 'complete', model: 'test-model', dimension: 3, content_hash: job.content_hash }] })).toThrowError(expect.objectContaining({ code: 'RMIG-E-REEMBED-INCOMPLETE' }));
    const complete = left.jobs.map((item) => ({ job_id: item.job_id, status: 'complete', model: 'test-model', dimension: 3, content_hash: item.content_hash }));
    expect(validateReembedReceipts({ plan: left, receipts: complete, expectedModel: 'test-model', expectedDimension: 3 })).toMatchObject({ complete: true, status: 'complete' });
  });
});

describe('append-only checkpoints and final reconciliation', () => {
  it('chains checkpoints, resumes idempotently, and rejects tampering', () => {
    const dir = tempRoot();
    appendCheckpoint(dir, { name: 'source-inspected', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: { count: 1 } });
    appendCheckpoint(dir, { name: 'source-inspected', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: { count: 1 } });
    appendCheckpoint(dir, { name: 'policy-compiled', migration_id: 'rmig_resume_01', artifact_sha256: 'a'.repeat(64), details: {} });
    expect(readCheckpointChain(dir)).toHaveLength(2);
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
    const report = reconcileMigration({ source: { observations: [{ id: 1, content: 'x' }] }, target: { observations: [{ id: 1, content: 'x' }] }, imagePlan: { entries: [] }, reembedPlan: { jobs: [] }, reembedReceipts: [] });
    expect(report.status).toBe('ready-for-cutover'); expect(determineMigrationStatus(report)).toBe('ready-for-cutover');
  });
});
