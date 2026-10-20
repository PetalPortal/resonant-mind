import { buildReembedPlan } from '../external/reembed.mjs';
import { readArtifact } from './artifacts.mjs';
import { parseOptions, readJsonFile, writeJsonNew } from './shared.mjs';

const PHASE = 'plan-reembed';

export function parsePlanReembedArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--input', '--out', '--migration-id'], optional: ['--images', '--bundle-manifest-sha256', '--compiled-policy-sha256', '--passphrase-file'] });
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), value]));
}
export function planReembedCommand(args) {
  const input = readArtifact(PHASE, args.input, 'The relational staging input', { kind: 'relational-plan', passphraseFile: args.passphraseFile, migrationId: args.migrationId });
  const images = args.images ? readJsonFile(PHASE, args.images, 'The image plan') : input.image_inventory ?? [];
  const plan = buildReembedPlan({ ...input, images, migrationId: args.migrationId, bundleManifestSha256: args.bundleManifestSha256, compiledPolicySha256: args.compiledPolicySha256 });
  writeJsonNew(PHASE, args.out, plan);
  return plan;
}
export function humanPlanReembedResult(result) { return `plan-reembed: jobs=${result.jobs.length}; plan_sha256=${result.plan_sha256}\n`; }
