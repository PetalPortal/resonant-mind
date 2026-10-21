import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { validateImageReceipt } from '../external/images.mjs';
import { validateReembedReceipts } from '../external/reembed.mjs';

function tables(value) { return Array.isArray(value) ? { rows: value } : value && typeof value === 'object' ? value : {}; }
function tableCounts(value) { return Object.fromEntries(Object.entries(tables(value)).filter(([, list]) => Array.isArray(list)).sort(([a], [b]) => a.localeCompare(b)).map(([table, list]) => [table, { count: list.length, sha256: canonicalSha256(list) }])); }
function rowKey(row, index) { return row?.id ?? row?.key ?? row?.uuid ?? `row-${index}`; }
function rowHashes(value) { const output = {}; for (const [table, list] of Object.entries(tables(value))) if (Array.isArray(list)) for (const [index, row] of list.entries()) output[`${table}:${String(rowKey(row, index))}`] = canonicalSha256(row); return output; }
function refusal(summary, details = {}) { return new MigrationRefusal({ code: 'RMIG-E-VALIDATION', phase: 'validate', summary, safe_details: details, report_path: null }); }
function adjustmentKeys(decisions = [], losses = []) {
  const keys = new Set();
  for (const item of [...decisions, ...losses]) {
    if (!item || typeof item !== 'object') continue;
    const table = item.source_table ?? item.table; const value = item.source_id ?? item.id ?? item.source_key ?? item.key;
    if (typeof table === 'string' && value !== undefined) keys.add(`${table}:${String(value)}`);
  }
  return keys;
}
function boundaryDiff(source, boundary, label, allowed) {
  const findings = []; if (boundary === undefined) return [{ check: 'missing-input', boundary: label }];
  const left = rowHashes(source); const right = rowHashes(boundary); const tablesSeen = new Set([...Object.keys(tableCounts(source)), ...Object.keys(tableCounts(boundary))]);
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (left[key] === undefined) findings.push({ check: 'extra-row', boundary: label, key_sha256: canonicalSha256(key) });
    else if (right[key] === undefined && !allowed.has(key)) findings.push({ check: 'missing-row', boundary: label, key_sha256: canonicalSha256(key) });
    else if (right[key] !== undefined && left[key] !== right[key]) findings.push({ check: 'row-hash-mismatch', boundary: label, key_sha256: canonicalSha256(key) });
  }
  for (const table of [...tablesSeen].sort()) { const leftCount = tableCounts(source)[table]?.count ?? 0; const rightCount = tableCounts(boundary)[table]?.count ?? 0; const allowedMissing = [...allowed].filter((key) => key.startsWith(`${table}:`)).length; if (rightCount + allowedMissing !== leftCount || rightCount > leftCount) findings.push({ check: 'count-mismatch', boundary: label, table_sha256: canonicalSha256(table) }); }
  return findings;
}
function successfulReceipt(receipt, statuses, { migrationId, kind, dryRunReceipt } = {}) {
  if (!receipt || typeof receipt !== 'object' || !statuses.includes(receipt.status) || typeof receipt.receipt_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.receipt_sha256)) return false;
  if (receipt.receipt_sha256 !== hashBody(receipt, 'receipt_sha256')) return false;
  if (receipt.migration_id !== migrationId || receipt.format_version !== 1 || receipt.receipt_type !== kind) return false;
  const required = ['bundle_manifest_sha256', 'compiled_policy_sha256', 'plan_sha256', 'target_identity_sha256', 'target_state_sha256', 'stage_content_sha256', 'migration_set_sha256', 'migrator_version'];
  if (required.some((field) => typeof receipt[field] !== 'string' || (field.endsWith('_sha256') && !/^[0-9a-f]{64}$/u.test(receipt[field])))) return false;
  if (kind === 'fresh-v4-import') {
    if (!dryRunReceipt || receipt.dry_run_receipt_sha256 !== dryRunReceipt.receipt_sha256) return false;
    for (const field of ['migration_id', 'bundle_manifest_sha256', 'compiled_policy_sha256', 'plan_sha256', 'target_identity_sha256', 'target_state_sha256', 'stage_content_sha256', 'migration_set_sha256', 'migrator_version']) if (receipt[field] !== dryRunReceipt[field]) return false;
  }
  return true;
}
function receiptHash(value) { return value ? canonicalSha256(value) : null; }
function hashBody(value, field) { const copy = { ...value }; delete copy[field]; return canonicalSha256(copy); }
// The hash of a validation report covers everything except itself and its keyed seal (the seal is made over the hash).
export function reportBodyHash(report) { const copy = { ...report }; delete copy.report_sha256; delete copy.report_seal; return canonicalSha256(copy); }
/**
 * Operator cutover evidence is the operator's own statement that the cutover was made and read back. This
 * tool cannot observe a deployment, so it checks what it can (the evidence is for this migration and this
 * exact report, its hash holds, and it states the action and the readback) and calls the result
 * operator-attested, never verified.
 */
export function validateOperatorCutoverEvidence({ report, evidence } = {}) {
  if (!report || !evidence || evidence.format_version !== 1 || evidence.evidence_type !== 'operator-cutover' || evidence.migration_id !== report.migration_id || evidence.report_sha256 !== report.report_sha256 || evidence.evidence_sha256 !== hashBody(evidence, 'evidence_sha256')) throw refusal('Operator cutover evidence is missing, stale, or not hash-bound to the validation report.');
  const action = evidence.operator_action; const readback = evidence.readback;
  if (!action || action.performed !== true || typeof action.actor !== 'string' || action.actor.length === 0 || typeof action.performed_at !== 'string' || typeof action.change_id !== 'string' || action.change_id.length === 0 || !readback || readback.verified !== true || typeof readback.verified_at !== 'string' || typeof readback.observed_version !== 'string' || readback.observed_version.length === 0) throw refusal('Operator cutover evidence must contain explicit action and deployment readback fields.');
  return true;
}
/**
 * What each part of a state rests on, in plain terms: what the tool verified itself and what it is relying on
 * someone else's word for. Re-embedding and the cutover are always attested (the tool cannot observe either).
 * Images rest on one of:
 *  - `tool-rehashed-source-and-target`: the tool re-read the source objects and the copied objects now, and they
 *    are the same, and what the receipt recorded (the strongest basis; the copy is checked against the original);
 *  - `tool-rehashed-target-against-plan`: the tool re-read the copied objects and they match values the plan
 *    itself states for every object (a source that stores them); the original is not read;
 *  - `signed-receipt-rehashed-target`: a receipt signed by a key the operator trusts, and the tool re-read the
 *    copied objects and they match it;
 *  - `signed-receipt-attested`: only a signature the operator trusts says they were copied (nothing was observed).
 * `images_fingerprint` says what the objects were held to: `source-now` (the source, re-read), `plan` (the
 * values the plan states), `copy-time-receipt` (only the fingerprint a copy receipt recorded; the receipt is
 * itself sealed or signed, but it is the copy's own word), or `plan-and-copy-time-receipt`.
 */
const IMAGE_BASES = new Set(['tool-rehashed-source-and-target', 'tool-rehashed-target-against-plan', 'signed-receipt-rehashed-target', 'signed-receipt-attested', 'nothing-planned']);
export function stateBasis(report, { cutoverEvidenceAccepted = false } = {}) {
  const relational = report?.relational_reconciliation_complete === true && report?.dry_run_receipt_complete === true && report?.import_receipt_complete === true ? 'verified-by-tool' : 'not-established';
  const imageBasis = report?.images_complete !== true ? 'pending' : IMAGE_BASES.has(report?.images?.basis) ? report.images.basis : 'complete-basis-not-recorded';
  const reembed = report?.reembed_complete !== true ? 'pending' : report?.reembed?.basis === 'nothing-planned' ? 'nothing-planned' : report?.reembed?.basis === 'receipts-attested' ? 'attested-by-receipts' : 'complete-basis-not-recorded';
  const values = report?.images?.expected_values;
  const imagesFingerprint = report?.images_complete !== true || imageBasis === 'nothing-planned' ? 'none' : imageBasis === 'tool-rehashed-source-and-target' ? 'source-now' : values === undefined || values === null ? 'not-recorded' : values.from_receipt_fingerprint === 0 ? 'plan' : values.from_plan === 0 ? 'copy-time-receipt' : 'plan-and-copy-time-receipt';
  return { relational, images: imageBasis, images_fingerprint: imagesFingerprint, reembed, cutover: cutoverEvidenceAccepted ? 'attested-by-operator' : 'none' };
}
export function determineMigrationStatus(report, { operatorCutoverEvidence, requireReportHash = true } = {}) {
  if (report?.refusal || report?.violations?.length || !report || requireReportHash && report.report_sha256 !== reportBodyHash(report)) return 'refused';
  // Evidence that was supplied but does not validate is never quietly set aside: the answer is refused, not a milder state.
  if (operatorCutoverEvidence !== undefined && operatorCutoverEvidence !== null) { try { validateOperatorCutoverEvidence({ report, evidence: operatorCutoverEvidence }); } catch { return 'refused'; } }
  if (!report?.relational_reconciliation_complete || !report?.dry_run_receipt_complete || !report?.import_receipt_complete) return report?.target_present ? 'review-required' : report?.exported ? 'exported' : 'review-required';
  if (!report?.target_present) return report?.exported ? 'exported' : 'review-required';
  if (!report?.imported) return 'review-required';
  if (!report?.images_complete) return 'data-imported-images-pending';
  if (!report?.reembed_complete) return 'data-imported-not-search-ready';
  // an offline comparison of snapshots (reconcileMigration) never reads as ready or complete, whatever its booleans say
  if (report?.validation_mode === 'offline-snapshots') return 'review-required';
  if (operatorCutoverEvidence !== undefined && operatorCutoverEvidence !== null) return 'complete-operator-attested';
  return 'ready-for-cutover';
}
/**
 * An offline comparison of caller-supplied snapshots. It is NOT a validation and can never reach a ready or
 * complete state: it reads no live source and no live target, it does not check that the plans it is handed are
 * the ones `validate` derives from the bundle and the reviewed decisions, and it takes no caller assertion
 * that images were observed (an image receipt must carry a trusted signature here). The most it reports is
 * `review-required`, with `status_capped` naming the state it would otherwise have claimed. Only
 * `validateCommand` (the `validate` command) can report ready-for-cutover.
 */
export function reconcileMigration({ source, exported, staged, target, decisions = [], losses = [], imagePlan, imageReceipt, reembedPlan, reembedReceipts, dryRunReceipt, importReceipt, trustedPublicKey, expectedModel, expectedDimension, dryRunAccepted, imported, migrationId = source?.migration_id ?? imagePlan?.migration_id ?? reembedPlan?.migration_id } = {}) {
  if (source === undefined) throw refusal('Relational reconciliation requires a source snapshot.');
  const allowed = adjustmentKeys(decisions, losses); const sourceCounts = tableCounts(source); const exportCounts = tableCounts(exported); const stageCounts = tableCounts(staged); const targetCounts = tableCounts(target);
  const violations = [...boundaryDiff(source, exported, 'exported', allowed), ...boundaryDiff(source, staged, 'staged', allowed), ...boundaryDiff(source, target, 'target', allowed)];
  let imageOk = false; let reembedOk = false; let imageFingerprints;
  if (!imagePlan || !imageReceipt) violations.push({ check: 'external-image-receipt-missing' }); else { try { imageFingerprints = validateImageReceipt({ plan: imagePlan, receipt: imageReceipt, migrationId, trustedPublicKey, requireSignature: true }).fingerprints; imageOk = true; } catch { violations.push({ check: 'external-image-receipt-invalid' }); } }
  if (!reembedPlan || !reembedReceipts) violations.push({ check: 'external-reembed-receipt-missing' }); else { try { validateReembedReceipts({ plan: reembedPlan, receipts: reembedReceipts, migrationId, expectedModel, expectedDimension, imageFingerprints }); reembedOk = true; } catch { violations.push({ check: 'external-reembed-receipt-invalid' }); } }
  const dryRunOk = successfulReceipt(dryRunReceipt, ['validated', 'complete'], { migrationId, kind: 'fresh-v4-dry-run' }); const importOk = successfulReceipt(importReceipt, ['complete', 'imported'], { migrationId, kind: 'fresh-v4-import', dryRunReceipt }); if (!dryRunOk) violations.push({ check: 'dry-run-receipt-invalid' }); if (!importOk) violations.push({ check: 'import-receipt-invalid' });
  const report = { format_version: 1, report_type: 'migration-reconciliation', migration_id: migrationId ?? null, counts: { source: sourceCounts, exported: exportCounts, staged: stageCounts, target: targetCounts }, row_hashes: { source: canonicalSha256(rowHashes(source)), exported: exported === undefined ? null : canonicalSha256(rowHashes(exported)), staged: staged === undefined ? null : canonicalSha256(rowHashes(staged)), target: target === undefined ? null : canonicalSha256(rowHashes(target)) }, decisions: { count: decisions.length, sha256: canonicalSha256(decisions) }, losses: { count: losses.length, sha256: canonicalSha256(losses) }, target_present: target !== undefined, exported: exported !== undefined, dry_run_accepted: dryRunOk, imported: importOk, dry_run_receipt_complete: dryRunOk, import_receipt_complete: importOk, relational_reconciliation_complete: violations.filter(({ check }) => ['missing-input', 'extra-row', 'missing-row', 'row-hash-mismatch', 'count-mismatch'].includes(check)).length === 0 && dryRunOk && importOk, images: { planned: imagePlan?.entries?.length ?? 0, receipt_sha256: receiptHash(imageReceipt) }, reembed: { planned: reembedPlan?.jobs?.length ?? 0, receipt_sha256: receiptHash(reembedReceipts) }, images_complete: imageOk, reembed_complete: reembedOk, violations };
  const uncapped = determineMigrationStatus(report, { requireReportHash: false });
  report.validation_mode = 'offline-snapshots';
  report.status = OFFLINE_STATES.has(uncapped) ? uncapped : 'review-required';
  if (report.status !== uncapped) report.status_capped = uncapped;
  report.report_sha256 = canonicalSha256(report); return report;
}
// The states an offline comparison may report: everything below a ready or complete state.
const OFFLINE_STATES = new Set(['refused', 'exported', 'review-required', 'data-imported-images-pending', 'data-imported-not-search-ready']);
export { tableCounts, rowHashes, boundaryDiff, successfulReceipt, hashBody };
