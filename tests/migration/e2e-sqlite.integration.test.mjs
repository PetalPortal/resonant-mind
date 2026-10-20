import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { buildImageInventory, validateImageReceipt } from '../../scripts/v32-to-v4/external/images.mjs';
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

    const imagePlan = buildImageInventory({ images: [], migrationId: plan.migration_id, bundleManifestSha256: plan.bundle_manifest_sha256, compiledPolicySha256: plan.compiled_policy_sha256 });
    const imageReceipt = { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: imagePlan.migration_id, plan_sha256: imagePlan.plan_sha256, bundle_manifest_sha256: imagePlan.bundle_manifest_sha256, compiled_policy_sha256: imagePlan.compiled_policy_sha256, entries: [] };
    validateImageReceipt({ plan: imagePlan, receipt: imageReceipt, requireSignature: false });
    const reembedPlan = plan.reembed_jobs;
    const missingExternal = () => reconcileMigration({ toolObservedImageObjects: true, expectedModel: 'synthetic-model', expectedDimension: 3, source: bundle.tables, exported: bundle.tables, staged: bundle.tables, target: bundle.tables, imagePlan, imageReceipt, reembedPlan, migrationId: plan.migration_id });
    expect(missingExternal).not.toThrow();
    expect(missingExternal().status).toBe('refused');

    const reembedReceipts = { format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, receipts: reembedPlan.jobs.map((job) => ({ job_id: job.job_id, migration_id: job.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'synthetic-model', dimension: 3, content_hash: job.content_hash })) };
    expect(validateReembedReceipts({ plan: reembedPlan, receipts: reembedReceipts, expectedModel: 'synthetic-model', expectedDimension: 3 })).toMatchObject({ complete: true });
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
