import { buildImageInventory, planHash } from '../external/images.mjs';
import { buildFilesystemInventory } from '../external/filesystem-store.mjs';
import { readArtifact } from './artifacts.mjs';
import { parseOptions, readJsonFile, refuseArgument, writeJsonNew } from './shared.mjs';

const PHASE = 'plan-images';

export function parsePlanImagesArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--out'], optional: ['--plan', '--input', '--source', '--migration-id', '--bundle-manifest-sha256', '--compiled-policy-sha256', '--passphrase-file'] });
  const sources = ['--plan', '--input', '--source'].filter((key) => values[key] !== undefined);
  if (sources.length !== 1) throw refuseArgument(PHASE, 'plan-images requires exactly one of --plan, --input or --source.');
  if (values['--plan'] !== undefined) {
    if (['--migration-id', '--bundle-manifest-sha256', '--compiled-policy-sha256'].some((key) => values[key] !== undefined)) throw refuseArgument(PHASE, 'plan-images --plan takes the migration id and the bindings from the relational plan; do not pass them.');
  } else if (values['--passphrase-file'] !== undefined) throw refuseArgument(PHASE, '--passphrase-file applies only to --plan, which may be encrypted.');
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), value]));
}

/**
 * The image plan. For a migration, take it from the relational plan (--plan): the image inventory in that
 * plan is the one derived from the imported image rows, and the one validate holds any image evidence to.
 * --input and --source build a standalone inventory (from a file of image rows, or from a directory); such
 * a plan is not bound to the imported rows and validate will not accept it as evidence for a migration.
 */
export async function planImagesCommand(args) {
  let plan;
  if (args.plan) {
    const relational = readArtifact(PHASE, args.plan, 'The relational staging plan', { kind: 'relational-plan', passphraseFile: args.passphraseFile });
    const inventory = relational?.image_inventory;
    if (relational?.plan_type !== 'relational-staging' || inventory?.plan_type !== 'image-inventory' || typeof inventory.plan_sha256 !== 'string' || planHash(inventory) !== inventory.plan_sha256) throw refuseArgument(PHASE, 'The file is not a relational staging plan with an intact image inventory.');
    plan = inventory;
  } else {
    const input = args.input ? readJsonFile(PHASE, args.input, 'The image inventory input') : { images: await buildFilesystemInventory(args.source) };
    plan = buildImageInventory({ ...input, migrationId: args.migrationId, bundleManifestSha256: args.bundleManifestSha256, compiledPolicySha256: args.compiledPolicySha256 });
  }
  writeJsonNew(PHASE, args.out, plan);
  return plan;
}
export function humanPlanImagesResult(result) { return `plan-images: entries=${result.entries.length}; plan_sha256=${result.plan_sha256}\n`; }
