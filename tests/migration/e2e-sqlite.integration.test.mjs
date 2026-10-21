import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createSqliteV32Adapter } from '../../scripts/v32-to-v4/source/sqlite-v32.mjs';
import { createBundle, verifyBundle } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { generateDecisionManifest, decisionManifestHash, loadVerifiedBundle } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { buildDryRunReport, buildImportReceipt } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { validateReembedReceipts } from '../../scripts/v32-to-v4/external/reembed.mjs';
import { reconcileMigration } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
import { validateImageReceipt } from '../../scripts/v32-to-v4/external/images.mjs';
import { FilesystemObjectStore, copyImagePlan } from '../../scripts/v32-to-v4/external/filesystem-store.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [];
const fixture = (name) => join(repo, 'tests', 'fixtures', 'migration', 'v3.2', 'd1', name);
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const copySql = (path) => readFileSync(path, 'utf8');

function reviewedPolicy(bundle) {
  const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  const reviewed = { ...draft, reviewed: true, reviewed_by: 'ci-fixture-reviewer', reviewed_at: '2026-09-20T00:01:00.000Z' };
  reviewed.manifest_sha256 = decisionManifestHash(reviewed);
  return reviewed;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('synthetic D1/SQLite v3.2 to v4 operator path', () => {
  it('proves read-only source, encrypted bundle, policy, dry-run/import receipts, external refusal, validation, and cleanup', async () => {
    const root = mkdtempSync(join(repo, '.tmp-migration-e2e-'));
    roots.push(root);
    const sourcePath = join(root, 'source.sqlite');
    const bundlePath = join(root, 'bundle.rmigrate');
    const passphrasePath = join(root, 'passphrase');
    writeFileSync(passphrasePath, 'synthetic-test-passphrase', { mode: 0o600 });
    const db = new DatabaseSync(sourcePath);
    try {
      db.exec(copySql(fixture('0001_init.sql')));
      db.exec(copySql(fixture('0002_enhanced_memory.sql')));
      db.exec(copySql(fixture('0003_graph_health.sql')));
      db.prepare("INSERT INTO entities (id, name, entity_type, primary_context) VALUES (?, ?, ?, ?)").run(1, 'Synthetic person', 'person', 'default');
      db.prepare("INSERT INTO observations (id, entity_id, content, source, context) VALUES (?, ?, ?, ?, ?)").run(7, 1, 'synthetic migration proof', 'conversation', 'default');
      // v3.2 keeps a path for an image and nothing else about the object
      db.prepare("INSERT INTO images (id, path, description, entity_id, observation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(1, 'images/synthetic.png', 'a synthetic picture', 1, 7, '2026-01-02T03:04:05Z');
    } finally { db.close(); }
    const beforeHash = hashFile(sourcePath);

    const adapter = createSqliteV32Adapter({ source: sourcePath });
    const sourceIdentity = adapter.identity();
    await createBundle({ adapter, sourceKind: 'sqlite', migrationId: 'rmig_sqlite_e2e_01', outputPath: bundlePath, passphraseFile: passphrasePath, timestamp: '2026-09-20T00:02:00.000Z' });
    expect(hashFile(sourcePath)).toBe(beforeHash);
    expect(sourceIdentity.source_sha256).toBe(beforeHash);
    expect(verifyBundle({ path: bundlePath, passphraseFile: passphrasePath }).manifest.bundle_mode).toBe('encrypted');
    const memberNames = readdirSync(join(bundlePath, 'data'));
    expect(memberNames.some((name) => readFileSync(join(bundlePath, 'data', name)).includes(Buffer.from('synthetic migration proof')))).toBe(false);

    const bundle = loadVerifiedBundle(bundlePath, { passphraseFile: passphrasePath });
    const decisions = reviewedPolicy(bundle);
    const compiled = compilePolicy({ bundle, decisions });
    expect(compiled.plan_sha256).toMatch(/^[0-9a-f]{64}$/u);
    const plan = transformRelational({ bundle, compiledPolicy: compiled });
    expect(plan.legacy_vectors_imported).toBe(false);
    expect(plan.members.observations).toHaveLength(1);

    // the image: the plan states no hash, size or type, so the tool fingerprints what it copies
    const imagePlan = plan.image_inventory;
    expect(imagePlan.entries).toHaveLength(1);
    expect(imagePlan.entries[0]).toMatchObject({ expected_sha256: null, expected_size: null, expected_mime: null });
    const pictureSource = join(root, 'picture-source'); const pictureTarget = join(root, 'picture-target');
    mkdirSync(join(pictureSource, 'images'), { recursive: true }); mkdirSync(pictureTarget);
    writeFileSync(join(pictureSource, 'images', 'synthetic.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('a synthetic picture')]));
    const imageReceipt = await copyImagePlan({ plan: imagePlan, sourceStore: new FilesystemObjectStore(pictureSource), targetStore: new FilesystemObjectStore(pictureTarget) });
    expect(imageReceipt.entries[0]).toMatchObject({ mime: 'image/png', verified: true, source_fingerprint: { sha256: imageReceipt.entries[0].sha256, size: imageReceipt.entries[0].size, mime: 'image/png' } });
    const imageFingerprints = validateImageReceipt({ plan: imagePlan, receipt: imageReceipt, requireSignature: false }).fingerprints;
    const reembedPlan = plan.reembed_jobs;
    const missingExternal = () => reconcileMigration({ toolObservedImageObjects: true, expectedModel: 'synthetic-model', expectedDimension: 3, source: bundle.tables, exported: bundle.tables, staged: bundle.tables, target: bundle.tables, imagePlan, imageReceipt, reembedPlan, migrationId: plan.migration_id });
    expect(missingExternal).not.toThrow();
    expect(missingExternal().status).toBe('refused');

    const reembedReceipts = { format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, receipts: reembedPlan.jobs.map((job) => ({ job_id: job.job_id, migration_id: job.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'synthetic-model', dimension: 3, content_hash: job.content_hash, ...(job.modality === 'image' ? { source_logical_path: job.source_logical_path, target_key: job.target_key, object_sha256: imageReceipt.entries[0].sha256, source_sha256: imageReceipt.entries[0].sha256, object_size: imageReceipt.entries[0].size, object_mime: imageReceipt.entries[0].mime } : {}) })) };
    expect(validateReembedReceipts({ plan: reembedPlan, receipts: reembedReceipts, expectedModel: 'synthetic-model', expectedDimension: 3, imageFingerprints })).toMatchObject({ complete: true });
    expect(() => validateReembedReceipts({ plan: reembedPlan, receipts: reembedReceipts, expectedModel: 'synthetic-model', expectedDimension: 3 })).toThrow(/do not prove complete/u);
    const targetIdentity = { database_identity_sha256: 'c'.repeat(64) };
    const dryRunReceipt = buildDryRunReport({ plan, targetIdentity, migrationSetSha256: 'd'.repeat(64), migratorVersion: '4.0.1', stageContentSha256: canonicalSha256(plan.members), targetStateSha256: canonicalSha256({ fresh: true }) });
    const importReceipt = buildImportReceipt({ plan, dryRun: dryRunReceipt, targetIdentity, insertedRows: Object.values(plan.members).reduce((sum, rows) => sum + rows.length, 0) });
    const ready = reconcileMigration({ toolObservedImageObjects: true, expectedModel: 'synthetic-model', expectedDimension: 3, source: bundle.tables, exported: bundle.tables, staged: bundle.tables, target: bundle.tables, imagePlan, imageReceipt, reembedPlan, reembedReceipts, dryRunReceipt, importReceipt, migrationId: plan.migration_id });
    expect(ready.status).toBe('ready-for-cutover');

    const leftovers = readdirSync(root).filter((name) => name.includes('incomplete') || name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(hashFile(sourcePath)).toBe(beforeHash);
    expect(existsSync(bundlePath)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }, 30000);
});
