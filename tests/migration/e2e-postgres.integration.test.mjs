import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { buildImageInventory } from '../../scripts/v32-to-v4/external/images.mjs';
import { buildDryRunReport } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { reconcileMigration } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
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
      await sourceClient.end(); sourceClient = undefined;

      process.env.TEST_E2E_SOURCE_URL = sourceUrl;
      const beforeSource = await snapshot(createPostgresV32Adapter({ source: 'env:TEST_E2E_SOURCE_URL' }));
      const sourceAdapter = createPostgresV32Adapter({ source: 'env:TEST_E2E_SOURCE_URL' });
      const sourceIdentity = await sourceAdapter.identity();
      await createBundle({ adapter: sourceAdapter, sourceKind: 'postgres', migrationId, outputPath: bundlePath, passphraseFile: passphrase, timestamp: '2026-09-20T00:02:00.000Z' });
      expect(verifyBundle({ path: bundlePath, passphraseFile: passphrase }).manifest.bundle_mode).toBe('encrypted');
      expect(await snapshot(createPostgresV32Adapter({ source: 'env:TEST_E2E_SOURCE_URL' }))).toBe(beforeSource);

      const bundle = loadVerifiedBundle(bundlePath, { passphraseFile: passphrase });
      const compiled = compilePolicy({ bundle, decisions: reviewedPolicy(bundle) });
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

      const imagePlan = buildImageInventory({ images: [], migrationId: plan.migration_id, bundleManifestSha256: plan.bundle_manifest_sha256, compiledPolicySha256: plan.compiled_policy_sha256 });
      const imageReceipt = { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: imagePlan.migration_id, plan_sha256: imagePlan.plan_sha256, bundle_manifest_sha256: imagePlan.bundle_manifest_sha256, compiled_policy_sha256: imagePlan.compiled_policy_sha256, entries: [] };
      const reembedPlan = plan.reembed_jobs;
      const targetSnapshot = plan.members;
      const missingExternal = reconcileMigration({ toolObservedImageObjects: true, expectedModel: 'synthetic-ci-model', expectedDimension: 3, source: targetSnapshot, exported: targetSnapshot, staged: targetSnapshot, target: targetSnapshot, imagePlan, imageReceipt, reembedPlan, dryRunReceipt: dryRun, importReceipt: imported, migrationId });
      expect(missingExternal.status).toBe('refused');
      const reembedReceipts = { format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, receipts: reembedPlan.jobs.map((job) => ({ job_id: job.job_id, migration_id: job.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'synthetic-ci-model', dimension: 3, content_hash: job.content_hash })) };
      const report = reconcileMigration({ toolObservedImageObjects: true, expectedModel: 'synthetic-ci-model', expectedDimension: 3, source: targetSnapshot, exported: targetSnapshot, staged: targetSnapshot, target: targetSnapshot, imagePlan, imageReceipt, reembedPlan, reembedReceipts, dryRunReceipt: dryRun, importReceipt: imported, migrationId });
      expect(report.status).toBe('ready-for-cutover');
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
