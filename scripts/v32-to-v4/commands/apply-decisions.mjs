import { decisionManifestHash, generateDecisionItems, loadVerifiedBundle } from '../policy/generate.mjs';
import { validateDecisionManifest } from '../policy/validate.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { parseOptions, readJsonFile, refuseArgument, writeJsonNew } from './shared.mjs';

const PHASE = 'apply-decisions';

export function parseApplyDecisionsArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--bundle', '--decisions', '--reviewed-by', '--out'], optional: ['--passphrase-file'] });
  return { bundlePath: values['--bundle'], decisionsPath: values['--decisions'], reviewedBy: values['--reviewed-by'], outPath: values['--out'], passphraseFile: values['--passphrase-file'] };
}

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: PHASE, summary, safe_details: safeDetails, report_path: null });
}

/**
 * Turns a draft that a person has filled in (a `choice` on every item) into the reviewed decision
 * manifest that compile-policy accepts. It selects nothing itself: it stamps who reviewed it and when,
 * recomputes the content hash, and runs the same validation the library runs against the verified bundle,
 * so a missing, extra, stale, wildcard or malformed choice is refused here, not later.
 */
export function applyDecisionsCommand({ bundlePath, decisionsPath, reviewedBy, outPath, passphraseFile, now = new Date().toISOString() }) {
  const edited = readJsonFile(PHASE, decisionsPath, 'The decision file');
  if (edited === null || typeof edited !== 'object' || Array.isArray(edited) || !Array.isArray(edited.items)) throw refuseArgument(PHASE, 'The decision file is not a decision manifest (it has no items list).');
  const bundle = loadVerifiedBundle(bundlePath, { passphraseFile });
  const hash = bundle.bundle_manifest_sha256;
  if (edited.bundle_manifest_sha256 !== hash) throw refusal('RMIG-E-POLICY-MISMATCH', 'The decision file was drafted for a different bundle than the one supplied.', { bundle_manifest_sha256: hash });
  const expected = generateDecisionItems(bundle);
  const chosen = new Set(edited.items.filter((item) => item && typeof item === 'object' && Object.hasOwn(item, 'choice')).map((item) => item.decision_id));
  const unresolved = expected.filter((item) => !chosen.has(item.decision_id));
  if (unresolved.length > 0) {
    throw refusal('RMIG-E-POLICY-UNRESOLVED', `${unresolved.length} decision item(s) have no choice; a person must choose every one.`, { unresolved: unresolved.length, decision_ids: unresolved.slice(0, 10).map((item) => item.decision_id) });
  }
  const reviewed = { ...edited, reviewed: true, reviewed_by: reviewedBy, reviewed_at: now };
  reviewed.manifest_sha256 = decisionManifestHash(reviewed);
  try {
    validateDecisionManifest(reviewed, { bundleManifestSha256: hash, expectedItems: expected });
  } catch (error) {
    const stale = /stale|source row|missing or extra decisions/iu.test(error.message);
    throw refusal(stale ? 'RMIG-E-POLICY-MISMATCH' : 'RMIG-E-POLICY-UNRESOLVED', `The decisions are not valid for this bundle: ${error.message}`, { bundle_manifest_sha256: hash });
  }
  writeJsonNew(PHASE, outPath, reviewed, { pretty: true });
  const byAction = {};
  for (const item of reviewed.items) {
    const action = typeof item.choice === 'string' ? item.choice : (item.choice.action ?? item.choice.type ?? item.choice.kind ?? item.choice.choice);
    byAction[action] = (byAction[action] ?? 0) + 1;
  }
  return {
    command: PHASE,
    migration_id: reviewed.migration_id,
    bundle_manifest_sha256: hash,
    manifest_sha256: reviewed.manifest_sha256,
    reviewed: true,
    reviewed_by: reviewedBy,
    reviewed_at: now,
    items: reviewed.items.length,
    choices: Object.fromEntries(Object.entries(byAction).sort(([a], [b]) => a.localeCompare(b))),
    out: outPath,
  };
}

export function humanApplyDecisionsResult(result) {
  return `apply-decisions: complete; items=${result.items}; reviewed_by=${JSON.stringify(result.reviewed_by)}; manifest_sha256=${result.manifest_sha256}; out=${result.out}\n`;
}
