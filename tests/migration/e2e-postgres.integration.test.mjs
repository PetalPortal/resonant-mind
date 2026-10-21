import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresV32Adapter } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';
import { createBundle, verifyBundle } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { generateDecisionManifest, decisionManifestHash, loadVerifiedBundle } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { inspectTarget, prepareTarget, dryRunStaging, importPlan } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { createV4MigrationRunner, migrationSetSha256, readV4Migrations } from '../../scripts/migrate-postgres.mjs';
import { FilesystemObjectStore, copyImagePlan } from '../../scripts/v32-to-v4/external/filesystem-store.mjs';
import { buildDryRunReport } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { reconcileMigration } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
import { validateCommand } from '../../scripts/v32-to-v4/commands/validate.mjs';
import { passphraseBytes } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';

const { Client } = pg;
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(repo, 'tests', 'fixtures', 'migration', 'v3.2', 'postgres.sql');
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const runE2E = typeof adminUrl === 'string' && adminUrl.length > 0;
const migrationId = 'rmig_postgres_e2e_01';
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

function databaseUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function reviewedPolicy(bundle) {
  const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  const reviewed = { ...draft, reviewed: true, reviewed_by: 'ci-fixture-reviewer', reviewed_at: '2026-09-20T00:01:00.000Z' };
  reviewed.manifest_sha256 = decisionManifestHash(reviewed);
  return reviewed;
}

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function snapshot(adapter) {
  await adapter.beginSnapshot();
  try {
    const catalog = await adapter.catalog();
    const rows = {};
    for (const table of catalog.tables) {
      rows[table.name] = [];
      for await (const row of adapter.streamTable(table.name, table.primary_key)) rows[table.name].push(row);
    }
    return canonicalSha256({ catalog, rows });
  } finally {
    await adapter.endSnapshot();
    await adapter.close();
  }
}

describe.skipIf(!runE2E)('real PostgreSQL/pgvector v3.2 to fresh-v4 E2E', () => {
  it('runs exact tagged source export through fresh target dry-run/import/validation', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const sourceDb = `rmig_src_${suffix}`;
    const targetDb = `rmig_tgt_${suffix}`;
    let root;
    let admin;
    let sourceClient;
    let targetClient;
    let runner;
    try {
      root = mkdtempSync(join(repo, '.tmp-postgres-e2e-'));
      const passphrase = join(root, 'passphrase');
      const bundlePath = join(root, 'bundle.rmigrate');
      writeFileSync(passphrase, 'postgres-e2e-passphrase', { mode: 0o600 });
      admin = await connect(adminUrl);
      await admin.query(`CREATE DATABASE ${quoteIdentifier(sourceDb)}`);
      await admin.query(`CREATE DATABASE ${quoteIdentifier(targetDb)}`);
      const sourceUrl = databaseUrl(adminUrl, sourceDb);
      const targetUrl = databaseUrl(adminUrl, targetDb);
      sourceClient = await connect(sourceUrl);
      await sourceClient.query(readFileSync(fixture, 'utf8'));
      await sourceClient.query("INSERT INTO entities (name, entity_type, primary_context) VALUES ('CI synthetic person', 'person', 'default')");
      await sourceClient.query("INSERT INTO observations (entity_id, content, context) SELECT id, 'CI synthetic migration proof', 'default' FROM entities WHERE name = 'CI synthetic person'");
      // v3.2 keeps a path for an image and nothing else about the object
      await sourceClient.query("INSERT INTO images (path, description, context, entity_id, observation_id) SELECT 'images/ci-synthetic.png', 'a synthetic picture', 'default', e.id, o.id FROM entities e, observations o WHERE e.name = 'CI synthetic person' AND o.entity_id = e.id");
      await sourceClient.end(); sourceClient = undefined;

      process.env.TEST_E2E_SOURCE_URL = sourceUrl;
      const beforeSource = await snapshot(createPostgresV32Adapter({ source: 'env:TEST_E2E_SOURCE_URL' }));
      const sourceAdapter = createPostgresV32Adapter({ source: 'env:TEST_E2E_SOURCE_URL' });
      const sourceIdentity = await sourceAdapter.identity();
      await createBundle({ adapter: sourceAdapter, sourceKind: 'postgres', migrationId, outputPath: bundlePath, passphraseFile: passphrase, timestamp: '2026-09-20T00:02:00.000Z' });
      expect(verifyBundle({ path: bundlePath, passphraseFile: passphrase }).manifest.bundle_mode).toBe('encrypted');
      expect(await snapshot(createPostgresV32Adapter({ source: 'env:TEST_E2E_SOURCE_URL' }))).toBe(beforeSource);

      const bundle = loadVerifiedBundle(bundlePath, { passphraseFile: passphrase });
      const decisions = reviewedPolicy(bundle);
      const compiled = compilePolicy({ bundle, decisions });
      const plan = transformRelational({ bundle, compiledPolicy: compiled });
      const targetMigrations = await readV4Migrations();
      const setHash = migrationSetSha256(targetMigrations);
      targetClient = await connect(targetUrl);
      expect((await inspectTarget({ client: targetClient, sourceIdentity })).pgvector).toBe(true);
      runner = createV4MigrationRunner({ connectionString: targetUrl });
      const prepared = await prepareTarget({ client: targetClient, migrationRunner: runner, sourceIdentity, migrationId, bundleManifestSha256: plan.bundle_manifest_sha256, compiledPolicySha256: plan.compiled_policy_sha256, plan });
      const target = await (await import('../../scripts/v32-to-v4/target/postgres.mjs')).readTargetIdentity({ client: targetClient });
      const dryRun = await dryRunStaging({ client: targetClient, plan, stagingSchema: prepared.schema, targetIdentity: target });
      const imported = await importPlan({ client: targetClient, plan, dryRun, targetIdentity: target, stagingSchema: prepared.schema });
      expect(imported.receipt_sha256).toMatch(/^[0-9a-f]{64}$/u);
      const counts = await targetClient.query("SELECT (SELECT count(*)::int FROM public.entities) AS entities, (SELECT count(*)::int FROM public.observations) AS observations");
      expect(counts.rows[0]).toMatchObject({ entities: 1, observations: 1 });

      // the image: the plan states no hash, size or type, so the tool fingerprints what it copies
      const imagePlan = plan.image_inventory;
      expect(imagePlan.entries).toHaveLength(1);
      expect(imagePlan.entries[0]).toMatchObject({ expected_sha256: null, expected_size: null, expected_mime: null });
      const pictureSource = join(root, 'picture-source'); const pictureTarget = join(root, 'picture-target');
      mkdirSync(join(pictureSource, 'images'), { recursive: true }); mkdirSync(pictureTarget);
      writeFileSync(join(pictureSource, 'images', 'ci-synthetic.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('a synthetic picture')]));
      const sealPassphrase = passphraseBytes({ phase: 'copy-images', passphraseFile: passphrase });
      const imageReceipt = await copyImagePlan({ plan: imagePlan, sourceStore: new FilesystemObjectStore(pictureSource), targetStore: new FilesystemObjectStore(pictureTarget), sealPassphrase });
      expect(imageReceipt.entries[0]).toMatchObject({ mime: 'image/png', verified: true });
      const reembedPlan = plan.reembed_jobs;
      const targetSnapshot = plan.members;

      // An offline comparison of snapshots is not a validation: whatever it is handed, it cannot read as ready.
      const offline = reconcileMigration({ expectedModel: 'synthetic-ci-model', expectedDimension: 768, source: targetSnapshot, exported: targetSnapshot, staged: targetSnapshot, target: targetSnapshot, imagePlan, imageReceipt, reembedPlan, dryRunReceipt: dryRun, importReceipt: imported, migrationId });
      expect(offline.status).toBe('refused');

      // The ready state is reached only through validate, which reads the live source and the live target itself.
      const reembedReceipts = { format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, receipts: reembedPlan.jobs.map((job) => ({ job_id: job.job_id, migration_id: job.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'synthetic-ci-model', dimension: 768, content_hash: job.content_hash, ...(job.modality === 'image' ? { source_logical_path: job.source_logical_path, target_key: job.target_key, object_sha256: imageReceipt.entries[0].sha256, source_sha256: imageReceipt.entries[0].sha256, object_size: imageReceipt.entries[0].size, object_mime: imageReceipt.entries[0].mime } : {}) })) };
      const put = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
      // the scratch cluster's certificate is self-signed: validate reads both databases over a connection without TLS, as the CLI flow does
      const noTls = (url) => { const value = new URL(url); value.searchParams.set('sslmode', 'disable'); return value.toString(); };
      process.env.TEST_E2E_TARGET_URL = noTls(targetUrl);
      process.env.TEST_E2E_VALIDATE_SOURCE_URL = noTls(sourceUrl);
      const common = {
        bundlePath, decisionsPath: put('decisions.json', decisions), planPath: put('plan.json', plan), sourceKind: 'postgres', source: 'env:TEST_E2E_VALIDATE_SOURCE_URL', target: 'env:TEST_E2E_TARGET_URL', migrationId,
        dryRunReceiptPath: put('dry-run-receipt.json', dryRun), importReceiptPath: put('import-receipt.json', imported), passphraseFile: passphrase,
        imagePlanPath: put('image-plan.json', imagePlan), imageReceiptPath: put('image-receipt.json', imageReceipt), imageTargetDir: pictureTarget, imageSourceDir: pictureSource,
      };
      const withoutReembedding = await validateCommand({ ...common, outPath: join(root, 'validation-images.json') });
      expect(withoutReembedding).toMatchObject({ status: 'data-imported-not-search-ready', violations: [], images_complete: true, reembed_complete: false });
      expect(withoutReembedding.images).toMatchObject({ basis: 'tool-rehashed-source-and-target', source_objects_rehashed_by_tool: true, objects_rehashed_by_tool: true, receipt_seal: 'valid' });
      const report = await validateCommand({ ...common, outPath: join(root, 'validation-ready.json'), reembedPlanPath: put('reembed-plan.json', reembedPlan), reembedReceiptsPath: put('reembed-receipts.json', reembedReceipts), embeddingModel: 'synthetic-ci-model' });
      expect(report.status).toBe('ready-for-cutover');
      expect(report.violations).toEqual([]);
      expect(report.validation_mode).toBe('live');
      expect(dryRun.receipt_sha256).toBe(buildDryRunReport({ plan: { ...plan, migration_set_sha256: setHash }, targetIdentity: target, migrationSetSha256: dryRun.migration_set_sha256, migratorVersion: dryRun.migrator_version, stageContentSha256: dryRun.stage_content_sha256, targetStateSha256: dryRun.target_state_sha256 }).receipt_sha256);
    } finally {
      await runner?.close().catch(() => {});
      await sourceClient?.end().catch(() => {});
      await targetClient?.end().catch(() => {});
      await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceDb)} WITH (FORCE)`).catch(() => {});
      await admin?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDb)} WITH (FORCE)`).catch(() => {});
      await admin?.end().catch(() => {});
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
