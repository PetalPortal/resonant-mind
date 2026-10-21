import { readFileSync } from 'node:fs';
import { passphraseBytes } from '../lib/bundle.mjs';
import { verifyReportSeal } from '../lib/report-seal.mjs';
import { determineMigrationStatus, reportBodyHash, stateBasis } from '../validate/reconcile.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { parseOptions, refuseArgument } from './shared.mjs';

const PHASE = 'status';

/**
 * Exit codes of `status`, so a script can gate on them: 0 only for a report whose hash and seal verify and
 * whose state is not a refusal; 2 for a refused state (the same code as every other refusal); 3 for a report
 * the command cannot verify (it carries no seal), which is read for what it claims and never proves anything.
 */
export const STATUS_EXIT_CODES = Object.freeze({ verified: 0, refused: 2, unverified: 3 });
export function statusExitCode(result) { return result?.status === 'refused' ? STATUS_EXIT_CODES.refused : result?.status === 'unverified' ? STATUS_EXIT_CODES.unverified : STATUS_EXIT_CODES.verified; }

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
 *
 * A state read here is a historical fact: what validate proved, at the time it ran, for the target it ran
 * against. status never connects to that target, so it cannot say what the target holds now; the result says
 * so (as_of_validation, current_target_checked: false) and only running validate again checks the target.
 * It also says what each part of the state rests on (stateBasis): what the tool verified, and what is only
 * attested by receipts, a signature or the operator.
 */
export function statusCommand({ report, reportPath, evidence, evidencePath, passphraseFile, operatorCutoverAcknowledged = false, ack = false } = {}) {
  let value = report;
  if (!value && reportPath) { try { value = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { throw refuseArgument(PHASE, 'Status report is missing or invalid JSON.'); } }
  if (!value || typeof value !== 'object') throw refuseArgument(PHASE, 'status requires a validation report.');
  let cutover = evidence;
  if (cutover === undefined && evidencePath) { try { cutover = JSON.parse(readFileSync(evidencePath, 'utf8')); } catch { throw refuseArgument(PHASE, 'Cutover evidence is missing or invalid JSON.'); } }
  const acknowledged = operatorCutoverAcknowledged === true || ack === true;
  const summary = { report_sha256: value.report_sha256 ?? null, counts: value.counts ?? {}, images_complete: value.images_complete ?? false, reembed_complete: value.reembed_complete ?? false, operator_cutover_acknowledged: acknowledged, cutover_evidence_supplied: cutover !== undefined, images_pending_reason: typeof value.images?.pending_reason === 'string' ? value.images.pending_reason : null, choices_stated_by: value.decisions?.stated_by ?? null, bulk_rules: Array.isArray(value.decisions?.bulk_rules) ? value.decisions.bulk_rules : [], suggestions_accepted: Array.isArray(value.decisions?.suggestions_accepted) ? value.decisions.suggestions_accepted.length : 0 };

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
  return {
    status,
    report_verified: true,
    as_of_validation: true,
    validated_at: typeof value.validated_at === 'string' ? value.validated_at : null,
    target_identity_sha256: typeof value.target?.identity_sha256 === 'string' ? value.target.identity_sha256 : null,
    current_target_checked: false,
    basis: stateBasis(value, { cutoverEvidenceAccepted: status === 'complete-operator-attested' }),
    ...summary,
  };
}
/** What the image state rests on, in words: the tool re-reading objects is not the tool seeing the original, and a signature is not the tool seeing anything. */
function imagesNote(basis) {
  if (basis.images === 'tool-rehashed-source-and-target') return ' (the tool re-hashed the source objects and the copied objects now: they are the same, and they match the copy receipt)';
  if (basis.images === 'tool-rehashed-target-against-plan') return ` (the tool re-hashed the copied objects and they match ${basis.images_fingerprint === 'plan' ? 'the values the plan states' : 'the plan and the fingerprint recorded when they were copied'}; the original sources were not read)`;
  if (basis.images === 'signed-receipt-rehashed-target') return ' (the tool re-hashed the copied objects and they match a receipt signed by a key the operator trusts; the original sources were not read)';
  if (basis.images === 'signed-receipt-attested') return ' (attested by a signed receipt, not observed by the tool)';
  return '';
}
/** Who stated the reviewed choices, in words: a choice that began as an agent's suggestion stays visible, and so does a bulk rule. */
function statementsNote(result) {
  const by = result.choices_stated_by;
  if (by === null || by === undefined) return '';
  const rules = (result.bulk_rules ?? []).map(({ rule, items }) => `${items} item(s) settled by the owner's rule ${JSON.stringify(rule)}`);
  return ` Reviewed choices: ${Object.entries(by).map(([name, count]) => `${name}=${count}`).join(', ')}${rules.length === 0 ? '' : `; ${rules.join('; ')}`}.`;
}
export function humanStatusResult(result) {
  if (result.status === 'unverified') return `status: unverified (NOT proof; the report claimed ${result.claimed_status ?? 'nothing'}); exit code ${STATUS_EXIT_CODES.unverified}; report_sha256=${result.report_sha256 ?? 'none'}; ${result.reason}\n`;
  if (result.report_verified === false) return `status: ${result.status}; report_sha256=${result.report_sha256 ?? 'none'}; ${result.reason}\n`;
  const basis = result.basis ?? {};
  const target = typeof result.target_identity_sha256 === 'string' ? `target ${result.target_identity_sha256.slice(0, 16)}` : 'a target the report does not identify';
  const when = typeof result.validated_at === 'string' ? result.validated_at : 'a time the report does not record';
  return `status: ${result.status}; report_verified=true; report_sha256=${result.report_sha256 ?? 'none'}; as_of_validation=true; validated_at=${result.validated_at ?? 'unknown'}; current_target_checked=false; `
    + `This is what validate proved at ${when} for ${target}; status does not look at the target, so it is not a check of the target now. Only running validate again checks the current target. `
    + `Rests on: relational=${basis.relational}; images=${basis.images}${imagesNote(basis)}${basis.images === 'pending' && result.images_pending_reason ? ` (not complete: ${result.images_pending_reason})` : ''}; reembedding=${basis.reembed}${basis.reembed === 'attested-by-receipts' ? ' (attested by receipts, not observed)' : ''}; cutover=${basis.cutover}${basis.cutover === 'attested-by-operator' ? ' (the operator\'s statement, not observed)' : ''}.${statementsNote(result)}\n`;
}
