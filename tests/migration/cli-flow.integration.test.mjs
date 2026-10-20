import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertNoSecrets, runCli } from './helpers/cli-run.mjs';
import { buildImageInventory } from '../../scripts/v32-to-v4/external/images.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { readArtifactFile } from './helpers/artifacts.mjs';
import { adminUrl, hasAdminDatabase, quoteIdentifier, urlFor, withScratchDatabase, withScratchSource } from './helpers/postgres-scratch.mjs';
import { RICH_POSTGRES_SEED, RICH_REVIEW, SQLITE_REVIEW, createD1Export, createSqliteSource } from './helpers/seeds.mjs';

// The whole operator flow, every step a separate process, against live PostgreSQL (TEST_ADMIN_DATABASE_URL):
// inspect, export, verify, draft the decisions, apply a review, compile, plan, inspect and prepare the target,
// dry run, import, validate, status. The connection strings are only ever in environment variables, and the
// tests check that they appear in no output and no artifact.
const { Client } = pg;
const noTls = (url) => { const value = new URL(url); value.searchParams.set('sslmode', 'disable'); return value.toString(); };
const sha = /[0-9a-f]{64}/u;

function step(label, args, env, expected = 0) {
  const result = runCli(args, env);
  expect(result.status, `${label}\n${result.output}`).toBe(expected);
  return result;
}

/** Plays the person who reviews the draft: chooses every item from `review`, by the item's kind. */
function reviewDraft(draftPath, outPath, review) {
  const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  const unexpected = draft.items.filter((item) => review[item.type] === undefined).map((item) => `${item.type} ${item.source_table}.${item.field ?? ''}: ${item.reason}`);
  expect(unexpected, 'draft items nobody planned a review for').toEqual([]);
  writeFileSync(outPath, JSON.stringify({ ...draft, items: draft.items.map((item) => ({ ...item, choice: review[item.type] })) }, null, 2));
  return draft;
}

/** inspect-source .. import, as an operator runs them. Returns the artifact paths and every command output. */
function runPipeline({ work, env, source, sourceKind, migrationId, review }) {
  const file = (name) => join(work, name);
  const outputs = [];
  const run = (label, args, expected = 0) => { const result = step(label, args, env, expected); outputs.push(result.output); return result; };
  writeFileSync(file('passphrase'), 'cli-flow-live-passphrase', { mode: 0o600 });
  const bundleArgs = ['--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')];

  run('inspect-source', ['inspect-source', '--source-kind', sourceKind, '--source', source, '--report', file('source-report.json')]);
  run('export', ['export', '--source-kind', sourceKind, '--source', source, '--source-report', file('source-report.json'), '--migration-id', migrationId, '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')]);
  run('verify-bundle', ['verify-bundle', ...bundleArgs]);
  run('draft-decisions', ['draft-decisions', ...bundleArgs, '--out', file('decisions-draft.json')]);
  reviewDraft(file('decisions-draft.json'), file('decisions-edited.json'), review);
  run('apply-decisions', ['apply-decisions', ...bundleArgs, '--decisions', file('decisions-edited.json'), '--reviewed-by', 'Live Test Reviewer', '--out', file('decisions-reviewed.json')]);
  run('compile-policy', ['compile-policy', ...bundleArgs, '--decisions', file('decisions-reviewed.json'), '--out', file('compiled-policy.json')]);
  const planned = run('plan-relational', ['plan-relational', ...bundleArgs, '--compiled-policy', file('compiled-policy.json'), '--out', file('plan.json')]);
  const hashes = Object.fromEntries([...planned.stdout.matchAll(/(bundle_manifest_sha256|compiled_policy_sha256|plan_sha256)=([0-9a-f]{64})/gu)].map((match) => [match[1], match[2]]));
  expect(Object.keys(hashes).sort()).toEqual(['bundle_manifest_sha256', 'compiled_policy_sha256', 'plan_sha256']);

  const inspected = run('inspect-target', ['inspect-target', '--target', 'env:RMIG_TARGET', '--source', sourceKind === 'postgres' ? source : source, '--source-kind', sourceKind]);
  expect(inspected.stdout).toBe('inspect-target: fresh=true; pgvector=true\n');
  const prepared = run('prepare-target', ['prepare-target', '--target', 'env:RMIG_TARGET', '--source', source, '--source-kind', sourceKind, '--migration-id', migrationId, '--bundle-manifest-sha256', hashes.bundle_manifest_sha256, '--compiled-policy-sha256', hashes.compiled_policy_sha256, '--plan', file('plan.json'), '--passphrase-file', file('passphrase')]);
  const schema = /schema=(rmig_[A-Za-z0-9_]+); status=staged/u.exec(prepared.stdout)?.[1];
  expect(schema, prepared.output).toBeTruthy();
  const dryRun = run('dry-run', ['dry-run', '--target', 'env:RMIG_TARGET', '--plan', file('plan.json'), '--staging-schema', schema, '--receipt-out', file('dry-run-receipt.json'), '--passphrase-file', file('passphrase')]);
  expect(dryRun.stdout).toMatch(/^dry-run: receipt_sha256=[0-9a-f]{64}; report=/u);
  const imported = run('import', ['import', '--target', 'env:RMIG_TARGET', '--plan', file('plan.json'), '--dry-run', file('dry-run-receipt.json'), '--staging-schema', schema, '--receipt-out', file('import-receipt.json'), '--passphrase-file', file('passphrase')]);
  expect(imported.stdout).toMatch(/^import: status=complete; receipt_sha256=[0-9a-f]{64}; rows=\d+; receipt=/u);
  return { file, outputs, run, hashes, schema, bundleArgs };
}

function validateArgs({ file, bundleArgs, source, sourceKind, migrationId, out, decisions = 'decisions-reviewed.json', plan = 'plan.json', target = 'env:RMIG_TARGET', extra = [] }) {
  return ['validate', ...bundleArgs, '--decisions', file(decisions), '--plan', file(plan), '--source-kind', sourceKind, '--source', source, '--target', target, '--migration-id', migrationId, '--dry-run-receipt', file('dry-run-receipt.json'), '--import-receipt', file('import-receipt.json'), '--out', file(out), ...extra];
}

describe.skipIf(!hasAdminDatabase)('the operator flow through the CLI against live PostgreSQL (TEST_ADMIN_DATABASE_URL)', () => {
  it('runs a rich PostgreSQL v3.2 source to a validated v4 target, refuses each kind of damage, and leaks no connection string', async () => {
    const work = mkdtempSync(join(tmpdir(), 'rmig-cli-flow-'));
    const admin = new Client({ connectionString: adminUrl });
    const clones = [];
    try {
      await admin.connect();
      await withScratchSource({ seed: (client) => client.query(RICH_POSTGRES_SEED) }, async (sourceBase) => {
        await withScratchDatabase(async (targetBase, targetDatabase) => {
          const sourceUrl = noTls(sourceBase);
          const targetUrl = noTls(targetBase);
          const env = { RMIG_SOURCE: sourceUrl, RMIG_TARGET: targetUrl };
          const migrationId = 'rmig_cli_flow_rich';
          const pipeline = runPipeline({ work, env, source: 'env:RMIG_SOURCE', sourceKind: 'postgres', migrationId, review: RICH_REVIEW });
          const { file, outputs, bundleArgs } = pipeline;
          const common = { file, bundleArgs, source: 'env:RMIG_SOURCE', sourceKind: 'postgres', migrationId };

          // The clean run: no finding, and the state is honest about what is still external.
          const valid = step('validate', validateArgs({ ...common, out: 'validation.json' }), env);
          outputs.push(valid.output);
          expect(valid.stdout).toMatch(/^validate: status=data-imported-images-pending; report_sha256=[0-9a-f]{64}; sealed=true; violations=0; cells_compared=\d+\n$/u);
          const report = JSON.parse(readFileSync(file('validation.json'), 'utf8'));
          expect(report).toMatchObject({ status: 'data-imported-images-pending', violations: [], violation_counts: {}, validation_mode: 'live', images: { planned: 1, complete: false }, imported: true, relational_reconciliation_complete: true, reembed_complete: false });
          expect(report.comparison.source_to_target.cells_compared).toBeGreaterThan(250);
          expect(report.comparison.plan_to_target.cells_compared).toBeGreaterThan(250);
          expect(report.comparison.source_to_target.sanctioned_differences).toMatchObject({ 'null-replaced-by-v4-default': 1, 'enum-alias': 1, 'tension-state-from-review': expect.any(Number) });
          expect(report.invariants).toMatchObject({ foreign_keys: expect.any(Number), check_constraints: expect.any(Number) });
          expect(report.invariants.foreign_keys).toBeGreaterThan(5);
          expect(report.counts.target.people).toBe(2);
          expect(report.counts.target.nodes).toBe(1);
          const status = step('status', ['status', '--report', file('validation.json'), '--passphrase-file', file('passphrase')], env);
          outputs.push(status.output);
          expect(status.stdout).toMatch(/^status: data-imported-images-pending; report_verified=true; report_sha256=/u);
          // the same validation twice must not overwrite its evidence
          const again = step('validate again', validateArgs({ ...common, out: 'validation.json' }), env, 2);
          expect(again.stderr).toMatch(/already exists/u);

          // Image evidence is held to the image plan validate derives, and the CLI hands that plan out: plan-images --plan.
          step('plan-images from the relational plan', ['plan-images', '--plan', file('plan.json'), '--passphrase-file', file('passphrase'), '--out', file('image-plan.json')], env);
          const imagePlan = JSON.parse(readFileSync(file('image-plan.json'), 'utf8'));
          expect(imagePlan).toEqual(readArtifactFile(file('plan.json'), 'relational-plan', file('passphrase')).image_inventory);
          expect(imagePlan.entries).toHaveLength(1);
          // an empty image plan, with a receipt that matches it exactly, is not evidence for the planned image
          const emptyImagePlan = buildImageInventory({ images: [], migrationId, bundleManifestSha256: imagePlan.bundle_manifest_sha256, compiledPolicySha256: imagePlan.compiled_policy_sha256 });
          const emptyReceiptBody = { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: migrationId, plan_sha256: emptyImagePlan.plan_sha256, bundle_manifest_sha256: imagePlan.bundle_manifest_sha256, compiled_policy_sha256: imagePlan.compiled_policy_sha256, entries: [] };
          writeFileSync(file('image-plan-empty.json'), JSON.stringify(emptyImagePlan));
          writeFileSync(file('image-receipt-empty.json'), JSON.stringify({ ...emptyReceiptBody, receipt_sha256: canonicalSha256(emptyReceiptBody) }));
          const emptyEvidence = step('validate with an empty image plan', validateArgs({ ...common, out: 'validation-empty-images.json', extra: ['--image-plan', file('image-plan-empty.json'), '--image-receipt', file('image-receipt-empty.json')] }), env, 2);
          outputs.push(emptyEvidence.output);
          const emptyReport = JSON.parse(readFileSync(file('validation-empty-images.json'), 'utf8'));
          expect(Object.keys(emptyReport.violation_counts).sort()).toEqual(['external-image-plan-not-the-planned-inventory', 'image-row-not-in-image-plan']);
          expect(emptyReport).toMatchObject({ status: 'refused', images_complete: false });

          // Each kind of damage is found, by a check that names it. A clone of the migrated target is damaged
          // each time (a clone is a different database, so identity findings come with every one of them).
          const identityNoise = ['target-identity-changed-since-import', 'import-receipt-differs-from-target-record'];
          const damage = [
            ['a changed text', "UPDATE journals SET content = content || '.' WHERE id = 1", ['cell-mismatch', 'plan-cell-mismatch']],
            ['a timestamp rounded to the millisecond', "UPDATE people SET created_at = date_trunc('milliseconds', created_at) WHERE id = 1", ['cell-mismatch', 'plan-cell-mismatch']],
            ['a missing row', 'DELETE FROM relations WHERE id = 2', ['source-row-missing-in-target', 'plan-row-missing-in-target']],
            ['an extra row', "INSERT INTO journals (content) VALUES ('stray')", ['target-row-without-source', 'target-row-not-in-plan']],
            ['an enum value changed', "UPDATE threads SET thread_type = 'task' WHERE id = 'thr-2'", ['cell-mismatch', 'plan-cell-mismatch']],
            ['a sequence left behind the data', 'ALTER SEQUENCE journals_id_seq RESTART WITH 1', ['sequence-behind-data']],
            ['a CHECK constraint added that the released schema does not have (never run, so its violations are not even read)', 'ALTER TABLE journals ADD CONSTRAINT journals_never_valid CHECK (length(content) > 100000) NOT VALID', ['constraint-not-validated', 'check-constraint-unexpected']],
            ['the importer\'s own receipt row removed', 'DELETE FROM migration_import_receipts', ['import-receipt-not-in-target', 'cell-mismatch', 'plan-cell-mismatch', 'recorded-default-not-observed']], // without the importer's own record the import time is unknown, so the v4 defaults cannot be shown to be right
          ];
          for (const [index, [label, sql, expected]] of damage.entries()) {
            const name = `rmig_cli_clone_${process.pid}_${Date.now()}_${index}`;
            clones.push(name);
            await admin.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(targetDatabase)}`);
            const cloneUrl = noTls(urlFor(name));
            const clone = new Client({ connectionString: cloneUrl });
            await clone.connect();
            try { await clone.query(sql); } finally { await clone.end(); }
            const out = `validation-damage-${index}.json`;
            const refused = step(`validate after ${label}`, validateArgs({ ...common, out, target: 'env:RMIG_CLONE' }), { ...env, RMIG_CLONE: cloneUrl }, 2);
            outputs.push(refused.output);
            expect(refused.stderr, label).toContain('RMIG-E-VALIDATION');
            expect(refused.stderr, label).toContain(`Report: ${file(out)}`);
            const damaged = JSON.parse(readFileSync(file(out), 'utf8'));
            expect(damaged.status, label).toBe('refused');
            const found = Object.keys(damaged.violation_counts);
            for (const check of expected) expect(found, `${label}: ${check}`).toContain(check);
            expect(found.filter((check) => !expected.includes(check) && !identityNoise.includes(check)), `${label}: nothing unrelated`).toEqual([]);
            expect(damaged.violations.length).toBeGreaterThan(0);
            expect(JSON.stringify(damaged), label).not.toContain('stray');
          }

          // Pointing validate at the source as if it were the target is found, not read as a target.
          const notATarget = step('validate against the source as target', validateArgs({ ...common, out: 'validation-not-a-target.json', target: 'env:RMIG_SOURCE' }), env, 2);
          outputs.push(notATarget.output);
          const notTargetChecks = Object.keys(JSON.parse(readFileSync(file('validation-not-a-target.json'), 'utf8')).violation_counts);
          expect(notTargetChecks).toEqual(expect.arrayContaining(['target-is-the-source', 'target-ledger-mismatch', 'import-receipt-not-in-target', 'target-table-missing']));

          // A refusal is JSON on stdout under --json, like every other refusal.
          const cloneName = clones.at(-1);
          const json = step('validate --json', [...validateArgs({ ...common, out: 'validation-json.json', target: 'env:RMIG_CLONE' }), '--json'], { ...env, RMIG_CLONE: noTls(urlFor(cloneName)) }, 2);
          expect(JSON.parse(json.stdout)).toMatchObject({ code: 'RMIG-E-VALIDATION', phase: 'validate' });
          expect(json.stderr).toBe('');

          // The source moved after the export: the re-read of the live source says so.
          const sourceClient = new Client({ connectionString: sourceUrl });
          await sourceClient.connect();
          try {
            await sourceClient.query("UPDATE observations SET resolution_note = 'changed after export' WHERE id = 5");
            const moved = step('validate after the source changed', validateArgs({ ...common, out: 'validation-source.json' }), env, 2);
            outputs.push(moved.output);
            expect(Object.keys(JSON.parse(readFileSync(file('validation-source.json'), 'utf8')).violation_counts)).toEqual(['source-row-changed-since-export']);
          } finally {
            await sourceClient.query('UPDATE observations SET resolution_note = $1 WHERE id = 5', ['settled']);
            await sourceClient.end();
          }

          // Edited artifacts do not validate: a plan, a reviewed decision file, a receipt.
          const plan = readArtifactFile(file('plan.json'), 'relational-plan', file('passphrase'));
          plan.members.journals[0].content = 'edited';
          writeFileSync(file('plan-edited.json'), JSON.stringify(plan));
          const editedPlan = step('validate an edited plan', validateArgs({ ...common, out: 'validation-plan.json', plan: 'plan-edited.json' }), env, 2);
          outputs.push(editedPlan.output);
          const planChecks = Object.keys(JSON.parse(readFileSync(file('validation-plan.json'), 'utf8')).violation_counts);
          expect(planChecks).toEqual(expect.arrayContaining(['plan-not-reproducible-from-bundle', 'dry-run-stage-content-differs', 'plan-cell-mismatch']));

          const receipt = JSON.parse(readFileSync(file('import-receipt.json'), 'utf8'));
          receipt.inserted_rows += 1;
          writeFileSync(file('import-receipt-edited.json'), JSON.stringify(receipt));
          const editedReceipt = step('validate an edited receipt', validateArgs({ ...common, out: 'validation-receipt.json' }).map((value) => (value === file('import-receipt.json') ? file('import-receipt-edited.json') : value)), env, 2);
          outputs.push(editedReceipt.output);
          expect(Object.keys(JSON.parse(readFileSync(file('validation-receipt.json'), 'utf8')).violation_counts)).toContain('import-receipt-invalid');

          const otherReview = { ...RICH_REVIEW, 'tension-state': { action: 'preserve-visits-and-open', last_visited: '2026-01-05T00:00:00.000Z' } };
          reviewDraft(file('decisions-draft.json'), file('decisions-edited-2.json'), otherReview);
          step('apply a different review', ['apply-decisions', ...bundleArgs, '--decisions', file('decisions-edited-2.json'), '--reviewed-by', 'Someone Else', '--out', file('decisions-reviewed-2.json')], env);
          const otherDecisions = step('validate with other decisions', validateArgs({ ...common, out: 'validation-decisions.json', decisions: 'decisions-reviewed-2.json' }), env, 2);
          outputs.push(otherDecisions.output);
          expect(Object.keys(JSON.parse(readFileSync(file('validation-decisions.json'), 'utf8')).violation_counts)).toContain('plan-not-built-from-these-decisions');

          // Not one output or artifact holds a connection string or its password.
          const secrets = [sourceUrl, targetUrl, sourceBase, targetBase, new URL(adminUrl).password, new URL(sourceBase).password, new URL(sourceBase).username === '' ? '' : `${new URL(sourceBase).username}:${new URL(sourceBase).password}`];
          assertNoSecrets({ outputs, root: work, secrets, expect });
        });
      });
    } finally {
      for (const name of clones) await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }, 900_000);

  it.each([['sqlite', 'source.sqlite'], ['d1-export', 'source.sql']])('runs a %s v3.2 source to a validated v4 target, to ready-for-cutover once the external re-embedding evidence is supplied', async (kind, sourceName) => {
    const work = mkdtempSync(join(tmpdir(), 'rmig-cli-flow-sqlite-'));
    try {
      await withScratchDatabase(async (targetBase) => {
        const targetUrl = noTls(targetBase);
        const env = { RMIG_TARGET: targetUrl };
        const file = (name) => join(work, name);
        if (kind === 'sqlite') createSqliteSource(file(sourceName)); else createD1Export(file(sourceName));
        const migrationId = 'rmig_cli_flow_sqlite';
        const pipeline = runPipeline({ work, env, source: file(sourceName), sourceKind: kind, migrationId, review: SQLITE_REVIEW });
        const { bundleArgs, hashes, outputs } = pipeline;
        const common = { file, bundleArgs, source: file(sourceName), sourceKind: kind, migrationId };

        // No re-embedding evidence yet: the data is imported and the report says it is not search ready.
        const pending = step('validate', validateArgs({ ...common, out: 'validation-pending.json' }), env);
        expect(pending.stdout).toMatch(/^validate: status=data-imported-not-search-ready;/u);
        const pendingReport = JSON.parse(readFileSync(file('validation-pending.json'), 'utf8'));
        expect(pendingReport).toMatchObject({ violations: [], images: { planned: 0, complete: true }, reembed: { complete: false, evidence_supplied: false } });
        expect(pendingReport.source.matches_bundle).toBe(true);
        expect(pendingReport.comparison.source_to_target.sanctioned_differences).toMatchObject({ 'timestamp-reviewed-timezone': 1, 'enum-alias': 1, 'entity-renamed-or-merged-by-review': 2, 'endpoint-renamed-by-review': 1, 'tension-state-from-review': expect.any(Number), 'null-replaced-by-v4-default': 1 });

        // The external provider's work, as the operator supplies it: a job plan from the CLI and a receipt for every job.
        step('plan-reembed', ['plan-reembed', '--input', file('plan.json'), '--passphrase-file', file('passphrase'), '--migration-id', migrationId, '--bundle-manifest-sha256', hashes.bundle_manifest_sha256, '--compiled-policy-sha256', hashes.compiled_policy_sha256, '--out', file('reembed-plan.json')], env);
        const reembedPlan = JSON.parse(readFileSync(file('reembed-plan.json'), 'utf8'));
        const receipts = (planOf, model = 'synthetic-model') => ({ format_version: 1, migration_id: migrationId, plan_sha256: planOf.plan_sha256, bundle_manifest_sha256: hashes.bundle_manifest_sha256, compiled_policy_sha256: hashes.compiled_policy_sha256, receipts: planOf.jobs.map((job) => ({ job_id: job.job_id, migration_id: migrationId, plan_sha256: planOf.plan_sha256, bundle_manifest_sha256: hashes.bundle_manifest_sha256, compiled_policy_sha256: hashes.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model, dimension: 3, content_hash: job.content_hash })) });
        const incomplete = receipts(reembedPlan);
        incomplete.receipts.pop();
        writeFileSync(file('reembed-receipts-incomplete.json'), JSON.stringify(incomplete));
        const refused = step('validate with incomplete receipts', validateArgs({ ...common, out: 'validation-incomplete.json', extra: ['--reembed-plan', file('reembed-plan.json'), '--reembed-receipts', file('reembed-receipts-incomplete.json')] }), env, 2);
        expect(Object.keys(JSON.parse(readFileSync(file('validation-incomplete.json'), 'utf8')).violation_counts)).toEqual(['external-reembed-receipt-invalid']);
        expect(refused.stderr).toContain('RMIG-E-VALIDATION');

        writeFileSync(file('reembed-receipts.json'), JSON.stringify(receipts(reembedPlan)));
        const ready = step('validate with receipts', validateArgs({ ...common, out: 'validation-ready.json', extra: ['--reembed-plan', file('reembed-plan.json'), '--reembed-receipts', file('reembed-receipts.json')] }), env);
        expect(ready.stdout).toMatch(/^validate: status=ready-for-cutover;/u);
        const status = step('status', ['status', '--report', file('validation-ready.json'), '--passphrase-file', file('passphrase')], env);
        expect(status.stdout).toMatch(/^status: ready-for-cutover;/u);

        // A job plan that is not the one these imported rows produce is not accepted, receipts or not.
        const foreign = { ...reembedPlan, jobs: reembedPlan.jobs.slice(1), searchable_job_count: reembedPlan.jobs.length - 1 };
        delete foreign.plan_sha256;
        foreign.plan_sha256 = canonicalSha256(foreign);
        writeFileSync(file('reembed-plan-foreign.json'), JSON.stringify(foreign));
        writeFileSync(file('reembed-receipts-foreign.json'), JSON.stringify(receipts(foreign)));
        step('validate a foreign job plan', validateArgs({ ...common, out: 'validation-foreign.json', extra: ['--reembed-plan', file('reembed-plan-foreign.json'), '--reembed-receipts', file('reembed-receipts-foreign.json')] }), env, 2);
        expect(Object.keys(JSON.parse(readFileSync(file('validation-foreign.json'), 'utf8')).violation_counts)).toEqual(['reembed-plan-not-derived-from-imported-rows']);

        assertNoSecrets({ outputs, root: work, secrets: [targetUrl, targetBase, new URL(targetBase).password], expect });
        expect(existsSync(file('validation-ready.json'))).toBe(true);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 900_000);
});
