import { readFileSync } from 'node:fs';
import pg from 'pg';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { redactText } from '../lib/redact.mjs';
import { compilePolicy } from '../policy/compile.mjs';
import { loadVerifiedBundle } from '../policy/generate.mjs';
import { transformRelational } from '../transform/relational.mjs';
import { checkExternalEvidence } from '../validate/external-evidence.mjs';
import { passphraseBytes } from '../lib/bundle.mjs';
import { sealReport } from '../lib/report-seal.mjs';
import { postgresClientConfig } from '../source/postgres-v32.mjs';
import { IMPORT_ORDER, bindRelationalPlan, buildDryRunReport, stageContentSha256 } from '../target/postgres.mjs';
import { readV4Migrations, migrationSetSha256 } from '../../migrate-postgres.mjs';
import { checkVersionOrdering } from '../validate/invariants.mjs';
import { determineMigrationStatus, successfulReceipt, tableCounts } from '../validate/reconcile.mjs';
import { readArtifact } from './artifacts.mjs';
import { Findings, compareSourceToTarget, comparePlanToTarget } from '../validate/compare.mjs';
import { compareSourceToBundle } from '../validate/live-source.mjs';
import { readLiveTarget } from '../validate/live-target.mjs';
import { adapterFor } from './export.mjs';
import { connectionFor } from './target.mjs';
import { parseOptions, readJsonFile, refuseArgument, writeJsonNew } from './shared.mjs';

const { Client } = pg;
const PHASE = 'validate';
const REQUIRED = ['--bundle', '--decisions', '--plan', '--source-kind', '--source', '--target', '--migration-id', '--dry-run-receipt', '--import-receipt', '--out'];
const OPTIONAL = ['--passphrase-file', '--image-plan', '--image-receipt', '--reembed-plan', '--reembed-receipts', '--trusted-public-key'];
const OPTION_NAMES = Object.freeze({
  '--bundle': 'bundlePath', '--decisions': 'decisionsPath', '--plan': 'planPath', '--source-kind': 'sourceKind', '--source': 'source', '--target': 'target',
  '--migration-id': 'migrationId', '--dry-run-receipt': 'dryRunReceiptPath', '--import-receipt': 'importReceiptPath', '--out': 'outPath',
  '--passphrase-file': 'passphraseFile', '--image-plan': 'imagePlanPath', '--image-receipt': 'imageReceiptPath', '--reembed-plan': 'reembedPlanPath',
  '--reembed-receipts': 'reembedReceiptsPath', '--trusted-public-key': 'trustedPublicKeyPath',
});

export function parseValidateArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: REQUIRED, optional: OPTIONAL });
  if (!['postgres', 'sqlite', 'd1-export'].includes(values['--source-kind'])) throw refuseArgument(PHASE, '--source-kind must be postgres, sqlite, or d1-export.');
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [OPTION_NAMES[key], value]));
}

function bindings(findings, name, receipt, plan) {
  for (const field of ['migration_id', 'bundle_manifest_sha256', 'compiled_policy_sha256']) if (receipt?.[field] !== plan?.[field]) findings.add('receipt-not-bound-to-plan', { receipt: name, field });
}

/**
 * Final validation, against the live systems. It re-reads the source and the target itself and compares
 * what each holds with the verified bundle, the reviewed decisions, the relational plan and the receipts.
 * A finding of any kind makes the report 'refused' and the command exit with RMIG-E-VALIDATION; the report
 * is written either way, because the evidence is the point.
 */
export async function validateCommand(args) {
  const decisions = readJsonFile(PHASE, args.decisionsPath, 'The reviewed decision manifest');
  const plan = readArtifact(PHASE, args.planPath, 'The relational staging plan', { kind: 'relational-plan', passphraseFile: args.passphraseFile });
  const dryRun = readJsonFile(PHASE, args.dryRunReceiptPath, 'The dry-run receipt');
  const importReceipt = readJsonFile(PHASE, args.importReceiptPath, 'The import receipt');
  const files = {
    imagePlan: args.imagePlanPath ? readJsonFile(PHASE, args.imagePlanPath, 'The image plan') : undefined,
    imageReceipt: args.imageReceiptPath ? readJsonFile(PHASE, args.imageReceiptPath, 'The image receipt') : undefined,
    reembedPlan: args.reembedPlanPath ? readJsonFile(PHASE, args.reembedPlanPath, 'The re-embedding plan') : undefined,
    reembedReceipts: args.reembedReceiptsPath ? readJsonFile(PHASE, args.reembedReceiptsPath, 'The re-embedding receipts') : undefined,
    trustedPublicKey: undefined,
  };
  if (args.trustedPublicKeyPath) { try { files.trustedPublicKey = readFileSync(args.trustedPublicKeyPath, 'utf8'); } catch { throw refuseArgument(PHASE, 'The trusted public-key file is missing or unreadable.'); } }
  if (plan === null || typeof plan !== 'object' || plan.plan_type !== 'relational-staging' || typeof plan.members !== 'object') throw refuseArgument(PHASE, 'The plan file is not a plan-relational output.');

  const bundle = loadVerifiedBundle(args.bundlePath, { passphraseFile: args.passphraseFile });
  const migrationId = args.migrationId;
  if (bundle.migration_id !== migrationId) throw refuseArgument(PHASE, '--migration-id is not the migration id of this bundle.');
  if (bundle.manifest.source_kind !== args.sourceKind) throw refuseArgument(PHASE, '--source-kind is not the source kind this bundle was exported from.');
  const family = args.sourceKind === 'd1-export' ? 'sqlite' : args.sourceKind;

  const findings = new Findings();
  const external = new Findings();
  // the same passphrase file that opens the bundle keys the report's seal; without one the report is unsealed (and says so)
  const sealKey = args.passphraseFile !== undefined || process.env.RM_MIGRATION_PASSPHRASE_FILE ? passphraseBytes({ phase: PHASE, passphraseFile: args.passphraseFile }) : null;

  // 1. The reviewed decisions compile to the policy the plan was built from, and the plan is what that policy produces.
  const compiled = compilePolicy({ bundle, decisions }); // refuses unresolved, stale or invalid decisions
  const rebuilt = transformRelational({ bundle, compiledPolicy: compiled });
  if (plan.compiled_policy_sha256 !== compiled.plan_sha256) findings.add('plan-not-built-from-these-decisions', {});
  if (canonicalJson(rebuilt) !== canonicalJson(plan)) findings.add('plan-not-reproducible-from-bundle', {});
  if (plan.bundle_manifest_sha256 !== bundle.bundle_manifest_sha256 || plan.migration_id !== migrationId) findings.add('plan-not-bound-to-bundle', {});

  // 2. Receipts: internally consistent, bound to this plan, and the import consistent with its dry run.
  const dryRunOk = successfulReceipt(dryRun, ['validated', 'complete'], { migrationId, kind: 'fresh-v4-dry-run' });
  const importOk = successfulReceipt(importReceipt, ['complete', 'imported'], { migrationId, kind: 'fresh-v4-import', dryRunReceipt: dryRun });
  if (!dryRunOk) findings.add('dry-run-receipt-invalid', {});
  if (!importOk) findings.add('import-receipt-invalid', {});
  if (dryRunOk) {
    bindings(findings, 'dry-run', dryRun, plan);
    try {
      const bound = bindRelationalPlan(plan, { migrationSetSha256: dryRun.migration_set_sha256, migratorVersion: dryRun.migrator_version });
      if (dryRun.plan_sha256 !== bound.plan_sha256) findings.add('dry-run-plan-hash-differs', {});
    } catch { findings.add('dry-run-plan-hash-differs', {}); }
    if (dryRun.stage_content_sha256 !== stageContentSha256(plan.members)) findings.add('dry-run-stage-content-differs', {});
    try {
      const expected = buildDryRunReport({ plan, targetIdentity: { database_identity_sha256: dryRun.target_identity_sha256 }, migrationSetSha256: dryRun.migration_set_sha256, migratorVersion: dryRun.migrator_version, stageContentSha256: dryRun.stage_content_sha256, targetStateSha256: dryRun.target_state_sha256, status: dryRun.status });
      if (canonicalJson(expected) !== canonicalJson(dryRun)) findings.add('dry-run-receipt-not-derived-from-plan', {});
    } catch { findings.add('dry-run-receipt-not-derived-from-plan', {}); }
    const reported = dryRun.validation ?? {};
    for (const group of ['foreign_keys', 'uniqueness', 'enums', 'routing']) if ((reported[group]?.violations ?? ['missing']).length > 0) findings.add('dry-run-reported-violations', { group });
  }
  if (importOk) {
    bindings(findings, 'import', importReceipt, plan);
    const expectedRows = IMPORT_ORDER.filter((table) => table !== 'people' && table !== 'nodes').reduce((sum, table) => sum + (plan.members[table]?.length ?? 0), 0);
    if (importReceipt.inserted_rows !== expectedRows) findings.add('import-row-count-differs-from-plan', {});
  }

  // 3. The live source still holds exactly what the bundle holds.
  const adapter = await adapterFor(args.sourceKind, args.source);
  let sourceIdentity;
  let sourceCounts = {};
  try {
    sourceIdentity = await adapter.identity();
    sourceCounts = await compareSourceToBundle({ adapter, sourceKind: args.sourceKind, expectedFingerprint: bundle.manifest.source_fingerprint, bundleTables: bundle.tables, findings });
  } catch (error) {
    try { await adapter.close(); } catch { /* the original failure wins */ }
    throw error;
  }

  // 4. The live target.
  const { connectionString, ssl } = connectionFor(args.target);
  const client = new Client({ ...postgresClientConfig(connectionString), ssl });
  let live;
  try {
    try { await client.connect(); } catch (error) { throw new MigrationRefusal({ code: 'RMIG-E-TARGET-SCHEMA', phase: PHASE, summary: `Validation could not connect to the target (${redactText(String(error?.code ?? 'connection-failed'))}).`, safe_details: {}, report_path: null }); }
    live = await readLiveTarget({ client, migrationId, findings });
  } finally { await client.end().catch(() => {}); }
  if (importOk && live.identity.database_identity_sha256 !== importReceipt.target_identity_sha256) findings.add('target-identity-changed-since-import', {});
  if (sourceIdentity?.database_identity_sha256 !== undefined && sourceIdentity.database_identity_sha256 === live.identity.database_identity_sha256) findings.add('target-is-the-source', {});
  if (live.receiptRow === null) findings.add('import-receipt-not-in-target', {});
  else if (importOk) {
    for (const field of ['migration_id', 'bundle_manifest_sha256', 'compiled_policy_sha256', 'target_identity_sha256', 'migration_set_sha256', 'migrator_version', 'plan_sha256', 'stage_content_sha256', 'target_state_sha256', 'receipt_sha256']) if (live.receiptRow[field] !== importReceipt[field]) findings.add('import-receipt-differs-from-target-record', { field });
    if (live.receiptRow.status !== 'complete') findings.add('import-receipt-differs-from-target-record', { field: 'status' });
  }
  const releasedSet = migrationSetSha256(await readV4Migrations());
  if (dryRunOk && (dryRun.migration_set_sha256 !== releasedSet || live.ledger?.migration_set_sha256 !== releasedSet)) findings.add('migration-set-differs', {});

  // 5. Column by column: source -> target, and plan -> target.
  const sourceToTarget = compareSourceToTarget({ sourceTables: bundle.tables, targetTables: live.tables, compiled, decisions, importedAt: live.importedAt, family });
  const planToTarget = comparePlanToTarget({ plan, targetTables: live.tables, columnTypes: live.columnTypes, importedAt: live.importedAt });
  const merge = (target, from) => { target.samples.push(...from.samples); for (const [check, count] of Object.entries(from.counts)) target.counts[check] = (target.counts[check] ?? 0) + count; };

  // 6. Cross-table invariants over the stored rows.
  for (const finding of checkVersionOrdering({ observation_versions: live.tables.observation_versions })) findings.add(finding.check, { table: finding.table, observation_id: finding.observation_id });
  const ids = (table) => new Set((live.tables[table] ?? []).map((row) => String(row.id)));
  const people = ids('people'); const nodes = ids('nodes'); const entities = ids('entities');
  for (const id of entities) if ((people.has(id) ? 1 : 0) + (nodes.has(id) ? 1 : 0) !== 1) findings.add('entity-not-routed-exactly-once', {});
  for (const id of [...people, ...nodes]) if (!entities.has(id)) findings.add('routed-row-without-entity', {});
  const plannedImages = new Set(rebuilt.image_inventory.entries.map((entry) => String(entry.linked_target_ids?.image_id)));
  const storedImages = ids('images');
  for (const id of storedImages) if (!plannedImages.has(id)) findings.add('image-row-not-in-inventory', {});
  for (const id of plannedImages) if (!storedImages.has(id)) findings.add('inventoried-image-row-missing', {});

  // 7. External work: supplied evidence is validated; none supplied leaves the state pending, never ready.
  const evidence = checkExternalEvidence({ derived: { members: rebuilt.members, imageInventory: rebuilt.image_inventory, reembedPlan: rebuilt.reembed_jobs }, files, migrationId, live: { tables: live.tables, columnTypes: live.columnTypes, importedAt: live.importedAt }, findings: external });

  merge(findings, sourceToTarget.findings);
  merge(findings, planToTarget.findings);
  const relationalClean = findings.total === 0;
  const violations = [...findings.samples, ...external.samples];
  const violationCounts = { ...findings.counts };
  for (const [check, count] of Object.entries(external.counts)) violationCounts[check] = (violationCounts[check] ?? 0) + count;
  const totalViolations = findings.total + external.total;

  const report = {
    format_version: 1,
    report_type: 'migration-reconciliation',
    validation_mode: 'live',
    migration_id: migrationId,
    bundle_manifest_sha256: bundle.bundle_manifest_sha256,
    decision_manifest_sha256: decisions.manifest_sha256,
    compiled_policy_sha256: compiled.plan_sha256,
    plan_sha256: plan.plan_sha256,
    source: { kind: args.sourceKind, fingerprint: bundle.manifest.source_fingerprint, rows_now: sourceCounts, matches_bundle: Object.keys(findings.counts).filter((check) => check.startsWith('source-')).length === 0 },
    target: { identity_sha256: live.identity.database_identity_sha256, migration_set_sha256: live.ledger?.migration_set_sha256 ?? null, import_receipt_sha256: live.receiptRow?.receipt_sha256 ?? null, imported_at_micros: live.importedAt === null ? null : live.importedAt.toString(10) },
    counts: { bundle: tableCounts(bundle.tables), target: Object.fromEntries(Object.entries(live.tables).map(([table, rows]) => [table, rows.length])), plan: Object.fromEntries(Object.entries(plan.members).map(([table, rows]) => [table, rows.length])) },
    comparison: {
      source_to_target: { cells_compared: sourceToTarget.cells_compared, tables: sourceToTarget.tables, sanctioned_differences: sourceToTarget.sanctioned },
      plan_to_target: { cells_compared: planToTarget.cells_compared, tables: planToTarget.tables },
    },
    invariants: live.checks,
    decisions: { count: decisions.items.length, sha256: canonicalSha256(decisions) },
    losses: { count: plan.losses.length, sha256: canonicalSha256(plan.losses) },
    images: evidence.images,
    reembed: evidence.reembed,
    target_present: true,
    exported: true,
    dry_run_receipt_complete: dryRunOk,
    import_receipt_complete: importOk,
    dry_run_accepted: dryRunOk,
    imported: importOk,
    relational_reconciliation_complete: relationalClean && dryRunOk && importOk,
    images_complete: evidence.images.complete,
    reembed_complete: evidence.reembed.complete,
    violation_counts: Object.fromEntries(Object.entries(violationCounts).sort(([a], [b]) => a.localeCompare(b))),
    violations,
  };
  report.status = totalViolations > 0 ? 'refused' : determineMigrationStatus(report, { requireReportHash: false });
  report.report_sha256 = canonicalSha256(report);
  // The keyed seal lets `status` tell this report from an edited one (see lib/report-seal.mjs). It needs the passphrase file.
  if (sealKey !== null) { try { report.report_seal = sealReport(report, sealKey); } finally { sealKey.fill(0); } }
  writeJsonNew(PHASE, args.outPath, report);
  if (totalViolations > 0) {
    throw new MigrationRefusal({ code: 'RMIG-E-VALIDATION', phase: PHASE, summary: `Validation found ${totalViolations} finding(s) in ${Object.keys(violationCounts).length} check(s): ${Object.keys(violationCounts).sort().slice(0, 6).join(', ')}.`, safe_details: { checks: violationCounts, report_sha256: report.report_sha256 }, report_path: args.outPath });
  }
  return report;
}

export function humanValidateResult(report) {
  return `validate: status=${report.status}; report_sha256=${report.report_sha256}; sealed=${report.report_seal !== undefined}; violations=${Object.values(report.violation_counts).reduce((sum, count) => sum + count, 0)}; cells_compared=${report.comparison.source_to_target.cells_compared + report.comparison.plan_to_target.cells_compared}\n`;
}
