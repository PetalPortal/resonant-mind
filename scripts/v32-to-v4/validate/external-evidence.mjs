// What validate accepts as proof of the two pieces of external work: the image copy and the re-embedding.
//
// Evidence is never judged against the files the operator supplies alone. The image plan and the
// re-embedding plan must be, byte for byte in canonical form, the ones that `validate` derives itself from
// the verified bundle and the reviewed decisions (the same derivation that built the relational plan); a
// plan that is smaller, empty or different, however well a receipt matches it, is a finding. The image rows
// the target holds must be exactly the rows the image plan lists, and the re-embedding receipts are checked
// against the content the target holds now, not only against the plan.

import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { validateImageReceipt } from '../external/images.mjs';
import { validateReembedReceipts } from '../external/reembed.mjs';
import { planCellMismatch } from './compare.mjs';

const supplied = (a, b) => (a === undefined ? 0 : 1) + (b === undefined ? 0 : 1);
const idOf = (row) => String(row?.id);

/**
 * The target rows the re-embedding jobs refer to, projected onto the planned content: each planned column
 * keeps its planned value if the target holds it (by the same column-type comparison the plan-to-target
 * check uses) and otherwise carries the target's differing value, so the content hash of a job only
 * matches when the target still holds the planned content. A row the target lacks is absent.
 */
export function reembedTargetRows({ jobs, members, images, targetTables, columnTypes, importedAt }) {
  const rows = {};
  const live = (table) => new Map((targetTables[table] ?? []).map((row) => [idOf(row), row]));
  const cache = new Map();
  const liveRows = (table) => { if (!cache.has(table)) cache.set(table, live(table)); return cache.get(table); };
  for (const job of jobs) {
    const { table, id } = job.target_locator ?? {};
    const key = `${table}:${String(id)}`;
    const stored = liveRows(table).get(String(id));
    if (stored === undefined) continue;
    if (job.modality === 'image') {
      const entry = (images?.entries ?? []).find((candidate) => String(candidate.linked_target_ids?.image_id) === String(id));
      if (entry !== undefined) rows[key] = { id, source_logical_path: entry.source_logical_path, target_key: entry.target_key, ...(entry.expected_sha256 === undefined ? {} : { expected_sha256: entry.expected_sha256 }), ...(entry.expected_size === undefined ? {} : { expected_size: entry.expected_size }), ...(entry.expected_mime === undefined ? {} : { expected_mime: entry.expected_mime }) };
      continue;
    }
    const planned = (members[table] ?? []).find((candidate) => String(candidate.id) === String(id));
    if (planned === undefined) continue;
    const projected = {};
    for (const [column, value] of Object.entries(planned)) {
      if (value === undefined) continue;
      const mismatch = planCellMismatch({ table, column, value, dbValue: stored[column], columnType: columnTypes?.[table]?.[column], importedAt });
      projected[column] = mismatch === null ? value : { target_differs_from_plan: mismatch, target_value: stored[column] ?? null };
    }
    rows[key] = projected;
  }
  return rows;
}

/**
 * @param derived  what validate rebuilt itself: { members, imageInventory, reembedPlan }
 * @param files    the operator's { imagePlan, imageReceipt, reembedPlan, reembedReceipts, trustedPublicKey }
 * @param live     what the target holds: { tables, columnTypes, importedAt }
 */
export function checkExternalEvidence({ derived, files, migrationId, live, findings }) {
  const inventory = derived.imageInventory;
  const result = { images: { planned: inventory.entries.length, evidence_supplied: false, complete: false, receipt_sha256: null }, reembed: { planned: derived.reembedPlan.jobs.length, evidence_supplied: false, complete: false, receipt_sha256: null } };

  // Images.
  const imageCount = supplied(files.imagePlan, files.imageReceipt);
  if (imageCount === 0) result.images.complete = result.images.planned === 0;
  else if (imageCount === 1) findings.add('external-image-evidence-incomplete', { detail: 'both --image-plan and --image-receipt are needed' });
  else {
    result.images.evidence_supplied = true;
    let bound = true;
    if (canonicalJson(files.imagePlan) !== canonicalJson(inventory)) {
      bound = false;
      findings.add('external-image-plan-not-the-planned-inventory', { supplied_entries: Array.isArray(files.imagePlan?.entries) ? files.imagePlan.entries.length : null, planned_entries: inventory.entries.length });
    }
    // every image row the target holds is accounted for by the supplied plan, and every entry has its row
    const stored = new Set((live.tables.images ?? []).map(idOf));
    const listed = new Set((Array.isArray(files.imagePlan?.entries) ? files.imagePlan.entries : []).map((entry) => String(entry?.linked_target_ids?.image_id)));
    for (const id of stored) if (!listed.has(id)) { bound = false; findings.add('image-row-not-in-image-plan', {}); }
    for (const id of listed) if (!stored.has(id)) { bound = false; findings.add('image-plan-entry-without-row', {}); }
    try {
      const checked = validateImageReceipt({ plan: files.imagePlan, receipt: files.imageReceipt, migrationId, trustedPublicKey: files.trustedPublicKey });
      result.images.complete = bound;
      result.images.receipt_sha256 = checked.receipt_sha256;
    } catch (error) { findings.add('external-image-receipt-invalid', { code: error instanceof MigrationRefusal ? error.code : 'invalid' }); }
  }

  // Re-embedding.
  const reembedCount = supplied(files.reembedPlan, files.reembedReceipts);
  if (reembedCount === 0) result.reembed.complete = result.reembed.planned === 0;
  else if (reembedCount === 1) findings.add('external-reembed-evidence-incomplete', { detail: 'both --reembed-plan and --reembed-receipts are needed' });
  else {
    result.reembed.evidence_supplied = true;
    let bound = true;
    if (canonicalJson(files.reembedPlan) !== canonicalJson(derived.reembedPlan)) { bound = false; findings.add('reembed-plan-not-derived-from-imported-rows', {}); }
    try {
      validateReembedReceipts({
        plan: files.reembedPlan,
        receipts: files.reembedReceipts,
        migrationId,
        targetRows: reembedTargetRows({ jobs: files.reembedPlan?.jobs ?? [], members: derived.members, images: inventory, targetTables: live.tables, columnTypes: live.columnTypes, importedAt: live.importedAt }),
      });
      result.reembed.complete = bound;
      result.reembed.receipt_sha256 = canonicalSha256(files.reembedReceipts);
    } catch (error) {
      findings.add('external-reembed-receipt-invalid', { code: error instanceof MigrationRefusal ? error.code : 'invalid', ...(error instanceof MigrationRefusal && Array.isArray(error.safe_details?.problems) ? { reasons: [...new Set(error.safe_details.problems)].sort().join(',') } : {}) });
    }
  }
  return result;
}
