import { readFileSync } from 'node:fs';
import { passphraseBytes } from '../lib/bundle.mjs';
import { verifyReportSeal } from '../lib/report-seal.mjs';
import { determineMigrationStatus, reportBodyHash } from '../validate/reconcile.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { parseOptions, refuseArgument } from './shared.mjs';

const PHASE = 'status';

export function parseStatusArgs(argv) {
  const values = parseOptions(PHASE, argv, { required: ['--report'], optional: ['--cutover-evidence', '--passphrase-file'], switches: ['--operator-cutover-ack'] });
  return { reportPath: values['--report'], evidencePath: values['--cutover-evidence'], passphraseFile: values['--passphrase-file'], ack: values['--operator-cutover-ack'] === true };
}

function refusal(summary, safeDetails = {}) { return new MigrationRefusal({ code: 'RMIG-E-VALIDATION', phase: PHASE, summary, safe_details: safeDetails, report_path: null }); }

/**
 * Reads the state a validation report records. status never proves anything itself: it reports a state only
 * for a report whose hash is its own and whose keyed seal (made by `validate` with the migration passphrase
 * file) verifies. A report that carries no seal is read for what it says but is labelled unverified and is
 * never reported as a state; a report whose seal fails is refused.
 */
export function statusCommand({ report, reportPath, evidence, evidencePath, passphraseFile, operatorCutoverAcknowledged = false, ack = false } = {}) {
  let value = report;
  if (!value && reportPath) { try { value = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { throw refuseArgument(PHASE, 'Status report is missing or invalid JSON.'); } }
  if (!value || typeof value !== 'object') throw refuseArgument(PHASE, 'status requires a validation report.');
  let cutover = evidence;
  if (cutover === undefined && evidencePath) { try { cutover = JSON.parse(readFileSync(evidencePath, 'utf8')); } catch { throw refuseArgument(PHASE, 'Cutover evidence is missing or invalid JSON.'); } }
  const acknowledged = operatorCutoverAcknowledged === true || ack === true;
  const summary = { report_sha256: value.report_sha256 ?? null, counts: value.counts ?? {}, images_complete: value.images_complete ?? false, reembed_complete: value.reembed_complete ?? false, operator_cutover_acknowledged: acknowledged, cutover_evidence_supplied: cutover !== undefined };

  if (value.report_sha256 !== reportBodyHash(value)) return { status: 'refused', report_verified: false, reason: 'The report does not match its own hash; it was changed after validate wrote it.', ...summary };
  if (value.report_seal === undefined) {
    return { status: 'unverified', claimed_status: typeof value.status === 'string' ? value.status : null, report_verified: false, reason: 'This report carries no seal, so nothing shows that validate produced it or that it is unchanged. It is not proof. Run validate with --passphrase-file and read the result with status --passphrase-file.', ...summary };
  }
  const path = passphraseFile ?? process.env.RM_MIGRATION_PASSPHRASE_FILE;
  if (typeof path !== 'string' || path.length === 0) throw refusal('This report is sealed; status needs the migration passphrase file (--passphrase-file) to verify it.');
  const passphrase = passphraseBytes({ phase: PHASE, passphraseFile: path });
  let sealed;
  try { sealed = verifyReportSeal(value, passphrase); } finally { passphrase.fill(0); }
  if (!sealed) throw refusal('The report seal does not verify: the report was changed, or it was not produced with this passphrase file. status will not report a state from it.');
  const status = determineMigrationStatus(value, { operatorCutoverEvidence: cutover });
  return { status, report_verified: true, ...summary };
}
export function humanStatusResult(result) {
  if (result.status === 'unverified') return `status: unverified (NOT proof; the report claimed ${result.claimed_status ?? 'nothing'}); report_sha256=${result.report_sha256 ?? 'none'}; ${result.reason}\n`;
  if (result.report_verified === false) return `status: ${result.status}; report_sha256=${result.report_sha256 ?? 'none'}; ${result.reason}\n`;
  return `status: ${result.status}; report_verified=true; report_sha256=${result.report_sha256 ?? 'none'}\n`;
}
