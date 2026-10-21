import { loadVerifiedBundle } from '../policy/generate.mjs';
import { buildReviewModel, renderHtml, renderText } from '../lib/review-render.mjs';
import { parseOptions, readJsonFile, writeBytesNew } from './shared.mjs';

const PHASE = 'review-decisions';

export function parseReviewDecisionsArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--bundle', '--decisions'], optional: ['--passphrase-file', '--html'] });
  return { bundlePath: values['--bundle'], decisionsPath: values['--decisions'], passphraseFile: values['--passphrase-file'], htmlPath: values['--html'] };
}

/**
 * Shows the owner, locally, every open item with the real values it concerns (from the encrypted bundle), the
 * choices it allows and what each one does. It reads the bundle and the decision file and writes nothing but the
 * HTML file when --html is given; the values are never put into the decision file, a report or the structured
 * (--json) result, which holds counts and paths only. The terminal rendering is returned as `text`, to be printed
 * to the person reading it and nowhere else.
 */
export function reviewDecisionsCommand({ bundlePath, decisionsPath, passphraseFile, htmlPath }) {
  const decisions = readJsonFile(PHASE, decisionsPath, 'The decision file');
  const bundle = loadVerifiedBundle(bundlePath, { passphraseFile });
  const model = buildReviewModel({ bundle, decisions });
  if (htmlPath !== undefined) writeBytesNew(PHASE, htmlPath, Buffer.from(renderHtml(model), 'utf8'));
  return {
    command: PHASE,
    migration_id: model.migration_id,
    bundle_manifest_sha256: model.bundle_manifest_sha256,
    decisions_manifest_sha256: model.decisions_manifest_sha256,
    reviewed: model.decisions_reviewed,
    items: model.counts.items,
    open: model.counts.open,
    recorded: model.counts.recorded,
    html: htmlPath ?? null,
    contains_memory_content: false,
    text: htmlPath === undefined ? renderText(model) : null,
  };
}

/** What the terminal prints: the full rendering, or (with --html) one line about the file; the values go only to the file. */
export function humanReviewDecisionsResult(result) {
  if (result.text !== null) return result.text;
  return `review-decisions: wrote ${result.html}; items=${result.items} (${result.open} open, ${result.recorded} with a recorded choice). The file shows memory content in the clear: open it yourself, do not share it, and delete it when you have decided.\n`;
}

/** The structured (--json) form: counts and the output path, never the rendering. */
export function jsonReviewDecisionsResult(result) {
  const { text: _text, ...summary } = result;
  return summary;
}
