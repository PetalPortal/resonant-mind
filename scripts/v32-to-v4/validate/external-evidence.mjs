// What validate accepts as proof of the two pieces of external work: the image copy and the re-embedding.
//
// Evidence is never judged against the files the operator supplies alone. The image plan and the
// re-embedding plan must be, byte for byte in canonical form, the ones that `validate` derives itself from
// the verified bundle and the reviewed decisions (the same derivation that built the relational plan); a
// plan that is smaller, empty or different, however well a receipt matches it, is a finding. The image rows
// the target holds must be exactly the rows the image plan lists, and the re-embedding receipts are checked
// against the content the target holds now, not only against the plan.
//
// The tool cannot watch either piece of work happen, so what each one is allowed to prove is decided here,
// by how the operator invoked validate, and never by a field inside the evidence:
//  - Images. A signature is required unless the operator named the directory the objects were copied to, in
//    which case the tool re-reads and re-hashes every object itself and a signature is not needed (see
//    imageSignatureRequired). The basis is reported: 'tool-rehashed-objects' (the tool saw the bytes) or
//    'signed-receipt-attested' (a key the operator trusts says the copy was made; the tool checked the
//    signature, not the objects).
//  - Re-embedding. Receipts are bound to the embedding model the operator states and the dimension of the
//    target's own embeddings.embedding column, but they remain the embedder's word: the basis is always
//    'receipts-attested' and the report says the tool did not observe the vectors.

import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { imageSignatureRequired, validateImageReceipt } from '../external/images.mjs';
import { validateReembedReceipts } from '../external/reembed.mjs';
import { planCellMismatch, targetColumns, unstatedCellState } from './compare.mjs';

const supplied = (a, b) => (a === undefined ? 0 : 1) + (b === undefined ? 0 : 1);
const idOf = (row) => String(row?.id);

/** The columns in which a stored row differs from the planned row: those the plan states and those it does not (see unstatedCellState). Names only, never values. */
function rowDrift({ table, planned, stored, columnTypes, columnDefaults, importedAt }) {
  const drift = [];
  for (const [column, value] of Object.entries(planned)) {
    if (value === undefined) continue;
    const mismatch = planCellMismatch({ table, column, value, dbValue: stored[column], columnType: columnTypes?.[table]?.[column], importedAt });
    if (mismatch !== null) drift.push({ column, mismatch });
  }
  for (const column of targetColumns(columnTypes, table, stored)) {
    if (planned[column] !== undefined) continue;
    const state = unstatedCellState({ table, column, row: stored, columnInfo: columnDefaults?.[table]?.[column] });
    if (state === 'unplanned-value' || state === 'default-differs' || state === 'derived-value-differs') drift.push({ column, mismatch: state });
  }
  return drift;
}

/**
 * The target rows the re-embedding jobs refer to, projected onto the planned content, so that the content
 * hash of a job only matches when the target still holds exactly the planned row.
 *  - A text row keeps each planned column's planned value if the target holds it (by the column-type
 *    comparison the plan-to-target check uses) and otherwise carries the target's differing value. A column
 *    the plan does not state that holds anything but NULL or the database's own default is carried too, so
 *    a value added to the stored row changes the hash. A row the target lacks is absent.
 *  - An image job's content is its planned inventory entry. The stored images row is held to the planned
 *    images row, column by column and with the same unstated-column rule, and the projection names the
 *    columns that drifted. The bytes of the object are not read here; they are covered only by the image
 *    copy evidence (the tool's re-hash of the target directory, or the signed receipt).
 */
export function reembedTargetRows({ jobs, members, images, targetTables, columnTypes, columnDefaults, importedAt }) {
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
      if (entry === undefined) continue;
      const content = { id, source_logical_path: entry.source_logical_path, target_key: entry.target_key, ...(entry.expected_sha256 === undefined ? {} : { expected_sha256: entry.expected_sha256 }), ...(entry.expected_size === undefined ? {} : { expected_size: entry.expected_size }), ...(entry.expected_mime === undefined ? {} : { expected_mime: entry.expected_mime }) };
      const planned = (members?.images ?? []).find((candidate) => String(candidate.id) === String(id));
      const drift = planned === undefined ? [{ column: '*', mismatch: 'row-not-in-plan' }] : rowDrift({ table: 'images', planned, stored, columnTypes, columnDefaults, importedAt });
      rows[key] = drift.length === 0 ? content : { ...content, target_differs_from_plan: drift };
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
    for (const column of targetColumns(columnTypes, table, stored)) {
      if (planned[column] !== undefined) continue;
      const state = unstatedCellState({ table, column, row: stored, columnInfo: columnDefaults?.[table]?.[column] });
      if (state === 'unplanned-value' || state === 'default-differs' || state === 'derived-value-differs') projected[column] = { target_differs_from_plan: state, target_value: stored[column] };
    }
    rows[key] = projected;
  }
  return rows;
}

/** Whether the objects the tool re-read from the operator's image directory are exactly the planned ones; findings name a key only by its hash. */
function checkObservedObjects({ inventory, observed, findings }) {
  let ok = true;
  for (const entry of inventory.entries) {
    const seen = observed?.[entry.target_key];
    const keyHash = canonicalSha256(entry.target_key);
    if (seen === undefined || seen === null || seen.missing === true) { ok = false; findings.add('image-object-missing-in-target-dir', { key_sha256: keyHash }); continue; }
    if (seen.sha256 !== entry.expected_sha256 || Number(seen.size) !== Number(entry.expected_size) || String(seen.mime).toLowerCase() !== String(entry.expected_mime).toLowerCase()) { ok = false; findings.add('image-object-differs-from-plan', { key_sha256: keyHash }); }
  }
  return ok;
}

/**
 * @param derived  what validate rebuilt itself: { members, imageInventory, reembedPlan }
 * @param files    the operator's { imagePlan, imageReceipt, reembedPlan, reembedReceipts, trustedPublicKey,
 *                 imageObjects, embeddingModel }. `imageObjects` ({ observed: { target_key: { sha256, size, mime } |
 *                 { missing: true } } }) exists only when the operator named the directory the objects were
 *                 copied to and the tool read them; `embeddingModel` is the model the operator states the v4
 *                 deployment is configured for.
 * @param live     what the target holds: { tables, columnTypes, columnDefaults, embeddingDimension, importedAt }
 */
export function checkExternalEvidence({ derived, files, migrationId, live, findings }) {
  const inventory = derived.imageInventory;
  const result = {
    images: { planned: inventory.entries.length, evidence_supplied: false, complete: false, receipt_sha256: null, basis: 'not-complete', objects_rehashed_by_tool: false, receipt_signature_verified: false, signature_required: null },
    reembed: { planned: derived.reembedPlan.jobs.length, evidence_supplied: false, complete: false, receipt_sha256: null, basis: 'not-complete', observed_by_tool: false, held_to_model: null, held_to_dimension: null },
  };

  // Images.
  const imageCount = supplied(files.imagePlan, files.imageReceipt);
  if (imageCount === 0) { result.images.complete = result.images.planned === 0; if (result.images.complete) result.images.basis = 'nothing-planned'; }
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
    // what the tool saw of the objects themselves, when the operator let it look
    const toolObservedObjects = files.imageObjects !== undefined;
    if (toolObservedObjects && !checkObservedObjects({ inventory, observed: files.imageObjects.observed, findings })) bound = false;
    // whether a signature is needed is the operator's invocation, never a field of the receipt
    const requireSignature = imageSignatureRequired({ trustedPublicKey: files.trustedPublicKey, toolObservedObjects });
    result.images.signature_required = requireSignature;
    try {
      const checked = validateImageReceipt({ plan: files.imagePlan, receipt: files.imageReceipt, migrationId, requireSignature, trustedPublicKey: files.trustedPublicKey });
      result.images.complete = bound;
      result.images.receipt_sha256 = checked.receipt_sha256;
      result.images.receipt_signature_verified = checked.signature_verified === true;
      result.images.objects_rehashed_by_tool = toolObservedObjects && bound;
      if (bound) result.images.basis = toolObservedObjects ? 'tool-rehashed-objects' : 'signed-receipt-attested';
    } catch (error) { findings.add('external-image-receipt-invalid', { code: error instanceof MigrationRefusal ? error.code : 'invalid', signature_required: requireSignature, trusted_key_configured: files.trustedPublicKey !== undefined }); }
  }

  // Re-embedding.
  const reembedCount = supplied(files.reembedPlan, files.reembedReceipts);
  if (reembedCount === 0) { result.reembed.complete = result.reembed.planned === 0; if (result.reembed.complete) result.reembed.basis = 'nothing-planned'; }
  else if (reembedCount === 1) findings.add('external-reembed-evidence-incomplete', { detail: 'both --reembed-plan and --reembed-receipts are needed' });
  else {
    result.reembed.evidence_supplied = true;
    let bound = true;
    if (canonicalJson(files.reembedPlan) !== canonicalJson(derived.reembedPlan)) { bound = false; findings.add('reembed-plan-not-derived-from-imported-rows', {}); }
    // receipts are held to the model the operator states and the dimension the target's own embeddings column has
    const expectedModel = files.embeddingModel;
    const expectedDimension = live.embeddingDimension;
    const modelStated = typeof expectedModel === 'string' && expectedModel.length > 0;
    const dimensionKnown = Number.isSafeInteger(expectedDimension) && expectedDimension > 0;
    if (!modelStated) findings.add('external-reembed-model-not-stated', {});
    if (!dimensionKnown) findings.add('target-embedding-dimension-unknown', {});
    if (modelStated && dimensionKnown) {
      result.reembed.held_to_model = expectedModel;
      result.reembed.held_to_dimension = expectedDimension;
      try {
        validateReembedReceipts({
          plan: files.reembedPlan,
          receipts: files.reembedReceipts,
          migrationId,
          expectedModel,
          expectedDimension,
          targetRows: reembedTargetRows({ jobs: files.reembedPlan?.jobs ?? [], members: derived.members, images: inventory, targetTables: live.tables, columnTypes: live.columnTypes, columnDefaults: live.columnDefaults, importedAt: live.importedAt }),
        });
        result.reembed.complete = bound;
        result.reembed.receipt_sha256 = canonicalSha256(files.reembedReceipts);
        if (bound) result.reembed.basis = 'receipts-attested';
      } catch (error) {
        findings.add('external-reembed-receipt-invalid', { code: error instanceof MigrationRefusal ? error.code : 'invalid', ...(error instanceof MigrationRefusal && Array.isArray(error.safe_details?.problems) ? { reasons: [...new Set(error.safe_details.problems)].sort().join(',') } : {}) });
      }
    }
  }
  return result;
}
