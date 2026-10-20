import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { loadVerifiedBundle } from '../policy/generate.mjs';
import { transformRelational } from '../transform/relational.mjs';
import { parseOptions, readJsonFile, refuseArgument, writeJsonNew } from './shared.mjs';

const PHASE = 'plan-relational';

export function parsePlanRelationalArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--bundle', '--compiled-policy', '--out'], optional: ['--passphrase-file'] });
  return { bundlePath: values['--bundle'], compiledPolicyPath: values['--compiled-policy'], outPath: values['--out'], passphraseFile: values['--passphrase-file'] };
}

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: PHASE, summary, safe_details: safeDetails, report_path: null });
}

/**
 * Builds the relational staging plan (the v4 rows, the losses, the image inventory and the re-embedding
 * jobs) from the verified bundle and the compiled policy. The compiled policy must be intact and bound to
 * this exact bundle; a row v4 cannot hold is a refusal, never a skipped row.
 */
export function planRelationalCommand({ bundlePath, compiledPolicyPath, outPath, passphraseFile }) {
  const compiled = readJsonFile(PHASE, compiledPolicyPath, 'The compiled policy');
  if (compiled === null || typeof compiled !== 'object' || compiled.plan_type !== 'deterministic-v3-to-v4-policy' || typeof compiled.plan_sha256 !== 'string') throw refuseArgument(PHASE, 'The compiled policy file is not a compile-policy output.');
  const { plan_sha256: claimed, ...body } = compiled;
  if (canonicalSha256(body) !== claimed) throw refusal('RMIG-E-POLICY-MISMATCH', 'The compiled policy has been changed since compile-policy wrote it (its hash does not match its content).');
  const bundle = loadVerifiedBundle(bundlePath, { passphraseFile });
  if (compiled.bundle_manifest_sha256 !== bundle.bundle_manifest_sha256 || compiled.migration_id !== bundle.migration_id) throw refusal('RMIG-E-POLICY-MISMATCH', 'The compiled policy is not bound to this bundle.', { bundle_manifest_sha256: bundle.bundle_manifest_sha256 });
  let plan;
  try { plan = transformRelational({ bundle, compiledPolicy: compiled }); } catch (error) {
    if (error instanceof MigrationRefusal) throw error;
    throw refusal('RMIG-E-POLICY-UNRESOLVED', `The reviewed decisions produce a row that v4 cannot hold: ${error.message}`, { bundle_manifest_sha256: bundle.bundle_manifest_sha256 });
  }
  writeJsonNew(PHASE, outPath, plan);
  const rows = Object.fromEntries(Object.entries(plan.members).sort(([a], [b]) => a.localeCompare(b)).map(([table, list]) => [table, list.length]));
  return {
    command: PHASE,
    migration_id: plan.migration_id,
    bundle_manifest_sha256: plan.bundle_manifest_sha256,
    compiled_policy_sha256: plan.compiled_policy_sha256,
    plan_sha256: plan.plan_sha256,
    rows,
    total_rows: Object.values(rows).reduce((sum, count) => sum + count, 0),
    losses: plan.losses.length,
    image_entries: plan.image_inventory.entries.length,
    reembed_jobs: plan.reembed_jobs.jobs.length,
    out: outPath,
  };
}

export function humanPlanRelationalResult(result) {
  return `plan-relational: complete; rows=${result.total_rows}; losses=${result.losses}; images=${result.image_entries}; reembed_jobs=${result.reembed_jobs}; migration_id=${result.migration_id}; bundle_manifest_sha256=${result.bundle_manifest_sha256}; compiled_policy_sha256=${result.compiled_policy_sha256}; plan_sha256=${result.plan_sha256}; out=${result.out}\n`;
}
