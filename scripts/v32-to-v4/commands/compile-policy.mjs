import { loadVerifiedBundle } from '../policy/generate.mjs';
import { compilePolicy } from '../policy/compile.mjs';
import { assertCanWriteArtifact, plaintextChoice, writeArtifactNew } from './artifacts.mjs';
import { parseOptions, readJsonFile } from './shared.mjs';

const PHASE = 'compile-policy';

export function parseCompilePolicyArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--bundle', '--decisions', '--out'], optional: ['--passphrase-file'], switches: ['--allow-plaintext-artifact', '--acknowledge-plaintext-risk'] });
  return { bundlePath: values['--bundle'], decisionsPath: values['--decisions'], outPath: values['--out'], passphraseFile: values['--passphrase-file'], plaintext: plaintextChoice(PHASE, values) };
}

/**
 * Compiles the reviewed decisions into the policy. The policy holds migrated content (entity names, merged
 * values), so it is written encrypted with the bundle's passphrase file unless both plaintext flags are
 * given, and an existing file is never replaced. The result is a summary: the policy is not printed.
 */
export function compilePolicyCommand({ bundlePath, decisionsPath, outPath, passphraseFile, plaintext = false }) {
  assertCanWriteArtifact(PHASE, 'compiled-policy', { passphraseFile, plaintext });
  const bundle = loadVerifiedBundle(bundlePath, { passphraseFile });
  const decisions = readJsonFile(PHASE, decisionsPath, 'The decision manifest');
  const plan = compilePolicy({ bundle, decisions });
  const { encrypted } = writeArtifactNew(PHASE, outPath, plan, { kind: 'compiled-policy', passphraseFile, plaintext });
  return { command: PHASE, migration_id: plan.migration_id, bundle_manifest_sha256: plan.bundle_manifest_sha256, decision_manifest_sha256: plan.decision_manifest_sha256, plan_sha256: plan.plan_sha256, losses: plan.losses.length, encrypted, out: outPath };
}
export function humanCompilePolicyResult(result) { return `compile-policy: complete; plan_sha256=${result.plan_sha256}; losses=${result.losses}; ${result.encrypted ? 'encrypted' : 'PLAINTEXT'}; out=${result.out}\n`; }
