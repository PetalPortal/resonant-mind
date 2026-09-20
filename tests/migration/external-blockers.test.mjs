import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImageInventory, validateImageReceipt } from '../../scripts/v32-to-v4/external/images.mjs';
import { buildReembedPlan, validateReembedReceipts } from '../../scripts/v32-to-v4/external/reembed.mjs';
import { FilesystemObjectStore } from '../../scripts/v32-to-v4/external/filesystem-store.mjs';
import { appendCheckpoint, readCheckpointChain } from '../../scripts/v32-to-v4/lib/checkpoints.mjs';
import { reconcileMigration, determineMigrationStatus, validateOperatorCutoverEvidence } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
import { validateInvariants } from '../../scripts/v32-to-v4/validate/invariants.mjs';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';

const SHA = 'a'.repeat(64);
const HASH = 'b'.repeat(64);
const tempRoot = () => mkdtempSync(join(tmpdir(), 'rmig-blockers-'));
const basePlan = () => buildImageInventory({
  migrationId: 'rmig_blockers_01',
  images: [{ id: 7, path: 'source.png', sha256: SHA, size: 8, mime: 'image/png' }],
});

function signedReceipt(plan) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const body = {
    format_version: 1,
    receipt_type: 'image-copy',
    status: 'complete',
    migration_id: plan.migration_id,
    plan_sha256: plan.plan_sha256,
    entries: [{
      source_logical_path: 'source.png', target_key: plan.entries[0].target_key, target_locator: plan.entries[0].target_locator,
      source_sha256: SHA, sha256: SHA, size: 8, mime: 'image/png', verified: true,
    }],
  };
  const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64');
  return { receipt: { ...body, signature: { algorithm: 'ed25519', key_id: 'test', value: signature } }, publicKey };
}

describe('external blocker regressions', () => {
  it('requires complete plan-bound image receipts and rejects wrong locators', () => {
    const plan = basePlan();
    const receipt = { status: 'complete', migration_id: plan.migration_id, plan_sha256: plan.plan_sha256, entries: [{ verified: true, source_logical_path: 'other.png', target_key: plan.entries[0].target_key, sha256: SHA, size: 8, mime: 'image/png' }] };
    expect(() => validateImageReceipt({ plan, receipt })).toThrow();
  });

  it('verifies an offline R2 signature and refuses unsigned handoffs', () => {
    const plan = basePlan();
    const { receipt, publicKey } = signedReceipt(plan);
    expect(validateImageReceipt({ plan, receipt, requireSignature: true, trustedPublicKey: publicKey })).toMatchObject({ complete: true });
    expect(() => validateImageReceipt({ plan, receipt: { ...receipt, signature: undefined }, requireSignature: true, trustedPublicKey: publicKey })).toThrow();
  });

  it('does not clobber a differing destination object', async () => {
    const source = tempRoot(); const target = tempRoot();
    writeFileSync(join(source, 'x.png'), Buffer.from('source'));
    writeFileSync(join(target, 'x.png'), Buffer.from('different'));
    await expect(new FilesystemObjectStore(target).put('x.png', Buffer.from('source'), { mime: 'image/png' })).rejects.toThrow();
    expect(readFileSync(join(target, 'x.png'), 'utf8')).toBe('different');
  });

  it('requires exact relational receipts and does not infer readiness from booleans', () => {
    const report = reconcileMigration({ source: { observations: [{ id: 1, content: 'x' }] }, target: { observations: [{ id: 1, content: 'x' }] }, imagePlan: { entries: [] }, reembedPlan: { jobs: [] } });
    expect(report.status).not.toBe('ready-for-cutover');
    expect(report.violations.length).toBeGreaterThan(0);
    expect(determineMigrationStatus(report)).not.toBe('complete-after-operator-cutover-ack');
  });

  it('never turns the CLI acknowledgement flag into cutover completion', () => {
    const body = { migration_id: 'rmig_blockers_02', target_present: true, imported: true, relational_reconciliation_complete: true, dry_run_receipt_complete: true, import_receipt_complete: true, images_complete: true, reembed_complete: true, violations: [] };
    body.report_sha256 = canonicalSha256(body);
    expect(determineMigrationStatus(body, { operatorCutoverAcknowledged: true })).toBe('ready-for-cutover');
    const evidence = { format_version: 1, evidence_type: 'operator-cutover', migration_id: body.migration_id, report_sha256: body.report_sha256, operator_action: { performed: true, actor: 'operator-1', performed_at: '2026-09-20T00:00:00.000Z', change_id: 'deploy-1' }, readback: { verified: true, verified_at: '2026-09-20T00:01:00.000Z', observed_version: 'v4' } };
    evidence.evidence_sha256 = canonicalSha256(evidence);
    expect(validateOperatorCutoverEvidence({ report: body, evidence })).toBe(true);
    expect(determineMigrationStatus(body, { operatorCutoverEvidence: evidence })).toBe('complete-after-operator-cutover-evidence');
  });

  it('refuses invariant validation without actual catalog and migration evidence', () => {
    expect(() => validateInvariants({ target: {} })).toThrow();
  });

  it('rejects checkpoint forks and out-of-order transitions', () => {
    const dir = tempRoot();
    appendCheckpoint(dir, { name: 'source-inspected', migration_id: 'rmig_blockers_01', artifact_sha256: SHA, details: {} });
    expect(() => appendCheckpoint(dir, { name: 'import-committed', migration_id: 'rmig_blockers_01', artifact_sha256: SHA, details: {} })).toThrow();
    expect(() => readCheckpointChain(dir, { migration_id: 'rmig_blockers_01', artifact_sha256: HASH })).toThrow();
  });

  it('keeps extension-only image claims incomplete', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'fake.png'), Buffer.from('not an image'));
    const inventory = await new FilesystemObjectStore(root).inventory();
    expect(inventory[0].mime).not.toBe('image/png');
  });
});