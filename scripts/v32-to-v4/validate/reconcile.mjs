import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';

function rows(value) { return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).flatMap(([table, list]) => Array.isArray(list) ? list.map((row) => ({ ...row, __table: table })) : []) : []; }
function tables(value) { return Array.isArray(value) ? { rows: value } : value && typeof value === 'object' ? value : {}; }
function tableCounts(value) { const input = value ?? {}; return Object.fromEntries(Object.entries(tables(input)).filter(([, list]) => Array.isArray(list)).sort(([a], [b]) => a.localeCompare(b)).map(([table, list]) => [table, { count: list.length, sha256: canonicalSha256(list) }])); }
function rowKey(row, index) { return row.id ?? row.key ?? row.uuid ?? index; }
function rowHashes(value) { const input = value ?? {}; const output = {}; for (const [table, list] of Object.entries(tables(input))) if (Array.isArray(list)) for (const [index, row] of list.entries()) output[`${table}:${String(rowKey(row, index))}`] = canonicalSha256(row); return output; }
function externalComplete(receipt, expected = []) { if (expected.length === 0) return true; return receipt?.status === 'complete' && Array.isArray(receipt.entries) && receipt.entries.length === expected.length && receipt.entries.every((entry) => entry.verified === true); }
export function determineMigrationStatus(report, { operatorCutoverAcknowledged = false } = {}) {
  if (report?.refusal || report?.violations?.length) return 'refused';
  if (!report?.target_present) return report?.exported ? 'exported' : 'review-required';
  if (report?.dry_run_accepted && !report?.imported) return 'dry-run-accepted';
  if (!report?.imported) return 'review-required';
  if (!report?.images_complete) return 'data-imported-images-pending';
  if (!report?.reembed_complete) return 'data-imported-not-search-ready';
  if (operatorCutoverAcknowledged === true) return 'complete-after-operator-cutover-ack';
  return 'ready-for-cutover';
}
export function reconcileMigration({ source, exported, staged, target, decisions = [], losses = [], imagePlan, imageReceipt, reembedPlan, reembedReceipts, dryRunAccepted = true, imported = target !== undefined, operatorCutoverAcknowledged = false } = {}) {
  const sourceCounts = tableCounts(source); const exportCounts = tableCounts(exported); const stageCounts = tableCounts(staged); const targetCounts = tableCounts(target); const sourceHashes = rowHashes(source); const targetHashes = rowHashes(target); const mismatches = [];
  for (const [key, hash] of Object.entries(sourceHashes)) if (targetHashes[key] !== undefined && targetHashes[key] !== hash) mismatches.push({ key, reason: 'target-row-hash-mismatch', source_sha256: hash, target_sha256: targetHashes[key] });
  const imageEntries = imagePlan?.entries ?? []; const reembedJobs = reembedPlan?.jobs ?? []; const imageOk = externalComplete(imageReceipt, imageEntries); const reembedOk = reembedJobs.length === 0 || reembedReceipts?.status === 'complete' || (Array.isArray(reembedReceipts) && reembedReceipts.length === reembedJobs.length && reembedReceipts.every((receipt) => receipt.status === 'complete'));
  const violations = mismatches.map(({ key, reason }) => ({ check: reason, key_sha256: canonicalSha256(key) }));
  const report = { format_version: 1, report_type: 'migration-reconciliation', counts: { source: sourceCounts, exported: exportCounts, staged: stageCounts, target: targetCounts }, row_hashes: { source: canonicalSha256(sourceHashes), target: canonicalSha256(targetHashes) }, decisions: { count: decisions.length, sha256: canonicalSha256(decisions) }, losses: { count: losses.length, sha256: canonicalSha256(losses) }, target_present: target !== undefined, exported: exported !== undefined, dry_run_accepted: dryRunAccepted === true, imported: imported === true, images: { planned: imageEntries.length, receipt_sha256: imageReceipt ? canonicalSha256(imageReceipt) : null }, reembed: { planned: reembedJobs.length, receipt_sha256: reembedReceipts ? canonicalSha256(reembedReceipts) : null }, images_complete: imageOk, reembed_complete: reembedOk, violations };
  report.status = determineMigrationStatus(report, { operatorCutoverAcknowledged }); report.report_sha256 = canonicalSha256(report); return report;
}
export { tableCounts, rowHashes, rows };
