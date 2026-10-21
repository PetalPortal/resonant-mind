import { generateDecisionManifest, loadVerifiedBundle } from '../policy/generate.mjs';
import { parseOptions, writeJsonNew } from './shared.mjs';

const PHASE = 'draft-decisions';

export function parseDraftDecisionsArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--bundle', '--out'], optional: ['--passphrase-file'] });
  return { bundlePath: values['--bundle'], outPath: values['--out'], passphraseFile: values['--passphrase-file'] };
}

/**
 * Drafts the decision manifest for a verified bundle. Nothing is guessed: every value the library cannot
 * map deterministically becomes one item with the choices it allows and no choice selected, so the draft
 * is never reviewed and never usable to compile until a person has chosen every item.
 */
export function draftDecisionsCommand({ bundlePath, outPath, passphraseFile }) {
  const bundle = loadVerifiedBundle(bundlePath, { passphraseFile });
  const draft = generateDecisionManifest(bundle);
  writeJsonNew(PHASE, outPath, draft, { pretty: true });
  const byType = {};
  for (const item of draft.items) byType[item.type] = (byType[item.type] ?? 0) + 1;
  return {
    command: PHASE,
    migration_id: draft.migration_id,
    bundle_manifest_sha256: draft.bundle_manifest_sha256,
    manifest_sha256: draft.manifest_sha256,
    reviewed: false,
    items: draft.items.length,
    items_by_type: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
    out: outPath,
  };
}

export function humanDraftDecisionsResult(result) {
  const types = Object.entries(result.items_by_type).map(([type, count]) => `${type}=${count}`).join(',');
  return `draft-decisions: complete; items=${result.items}${types ? ` (${types})` : ''}; reviewed=false; bundle_manifest_sha256=${result.bundle_manifest_sha256}; out=${result.out}\n`;
}
