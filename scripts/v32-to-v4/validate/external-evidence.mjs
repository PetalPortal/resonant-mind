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
//  - Images. With a trusted public key the receipt must carry a valid signature by it. Without one the receipt is
//    a plain file (anyone able to write the target directory could write one to match it), so it completes
//    images only when the tool saw both ends: it re-reads the copied objects (--image-target-dir), the receipt
//    carries the keyed seal the copy made with the migration passphrase, and the objects are held to something
//    other than the receipt: the values the plan itself states for every object, or the source objects re-read
//    now (--image-source-dir). Anything less leaves the images pending, with the reason recorded. The basis is
//    reported: 'tool-rehashed-source-and-target', 'tool-rehashed-target-against-plan',
//    'signed-receipt-rehashed-target' or 'signed-receipt-attested' (a key the operator trusts says the copy was
//    made; the tool checked the signature, not the objects).
//  - Re-embedding. Receipts are bound to the embedding model the operator states and the dimension of the
//    target's own embeddings.embedding column, but they remain the embedder's word: the basis is always
//    'receipts-attested' and the report says the tool did not observe the vectors.

import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { validateImageReceipt } from '../external/images.mjs';
import { validateReembedReceipts } from '../external/reembed.mjs';
import { planCellMismatch, targetColumns, unstatedCellState } from './compare.mjs';

const supplied = (a, b) => (a === undefined ? 0 : 1) + (b === undefined ? 0 : 1);
const idOf = (row) => String(row?.id);

/** The columns in which a stored row differs from the planned row: those the plan states and those it does not (see unstatedCellState). Names only, never values. */
function rowDrift({ table, planned, stored, columnTypes, columnDefaults, importedAt, sequences }) {
  const drift = [];
  for (const [column, value] of Object.entries(planned)) {
    if (value === undefined) continue;
    const mismatch = planCellMismatch({ table, column, value, dbValue: stored[column], columnType: columnTypes?.[table]?.[column], importedAt });
    if (mismatch !== null) drift.push({ column, mismatch });
  }
  for (const column of targetColumns(columnTypes, table, stored)) {
    if (planned[column] !== undefined) continue;
    const state = unstatedCellState({ table, column, row: stored, columnInfo: columnDefaults?.[table]?.[column], importedAt, sequences });
    if (state === 'unplanned-value' || state === 'default-differs' || state === 'derived-value-differs' || state === 'default-expression-not-evaluated') drift.push({ column, mismatch: state });
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
export function reembedTargetRows({ jobs, members, images, targetTables, columnTypes, columnDefaults, importedAt, sequences }) {
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
      const drift = planned === undefined ? [{ column: '*', mismatch: 'row-not-in-plan' }] : rowDrift({ table: 'images', planned, stored, columnTypes, columnDefaults, importedAt, sequences });
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
      const state = unstatedCellState({ table, column, row: stored, columnInfo: columnDefaults?.[table]?.[column], importedAt, sequences });
      if (state === 'unplanned-value' || state === 'default-differs' || state === 'derived-value-differs' || state === 'default-expression-not-evaluated') projected[column] = { target_differs_from_plan: state, target_value: stored[column] };
    }
    rows[key] = projected;
  }
  return rows;
}

const known = (value) => value !== null && value !== undefined;

/**
 * Whether the objects the tool re-read are the ones that were copied; findings name a key only by its hash.
 * The tool can look at both ends: the copied objects (`observed`, from --image-target-dir) and, when the operator
 * names it, the directory they were copied from (`sourceObserved`, from --image-source-dir, read by each entry's
 * source path). Each object is held to the plan's value where the plan states one, and otherwise to the
 * fingerprint the copy receipt records for it (`fingerprints`, from a receipt that has already passed its own
 * checks; undefined when it did not, in which case an object that cannot be compared is not complete and the
 * receipt is already a finding). A v3.2 source stores no hash, so there the receipt is all the plan offers, and
 * a receipt is only a file: what makes the check more than circular is the source, re-hashed now. With it the
 * source must be an image and equal the target, the receipt's recorded fingerprint, and any plan value.
 */
function checkObservedObjects({ inventory, observed, sourceObserved, fingerprints, findings }) {
  let ok = true;
  for (const entry of inventory.entries) {
    const seen = observed?.[entry.target_key];
    const keyHash = canonicalSha256(entry.target_key);
    if (seen === undefined || seen === null || seen.missing === true) { ok = false; findings.add('image-object-missing-in-target-dir', { key_sha256: keyHash }); continue; }
    const recorded = fingerprints?.[entry.target_key];
    const actualOf = (object, field) => (field === 'size' ? Number(object.size) : field === 'mime' ? String(object.mime).toLowerCase() : object.sha256);
    const plannedOf = (planned, field) => (field === 'size' ? Number(planned) : field === 'mime' ? String(planned).toLowerCase() : planned);
    let differsFromPlan = false; let differsFromReceipt = false; let comparable = true;
    for (const [field, planned] of [['sha256', entry.expected_sha256], ['size', entry.expected_size], ['mime', entry.expected_mime]]) {
      if (known(planned)) { if (plannedOf(planned, field) !== actualOf(seen, field)) differsFromPlan = true; }
      else if (recorded === undefined) comparable = false;
      else if (recorded[field] !== actualOf(seen, field)) differsFromReceipt = true;
    }
    if (differsFromPlan) findings.add('image-object-differs-from-plan', { key_sha256: keyHash });
    if (differsFromReceipt) findings.add('image-object-differs-from-copy-fingerprint', { key_sha256: keyHash });
    if (differsFromPlan || differsFromReceipt || !comparable) ok = false;
    if (sourceObserved !== undefined) {
      const source = sourceObserved?.[entry.target_key];
      if (source === undefined || source === null || source.missing === true) { ok = false; findings.add('image-object-missing-in-source-dir', { key_sha256: keyHash }); continue; }
      if (!/^image\/[a-z0-9.+-]+$/u.test(String(source.mime).toLowerCase())) { ok = false; findings.add('image-source-not-an-image', { key_sha256: keyHash }); }
      const fields = ['sha256', 'size', 'mime'];
      if (fields.some((field) => actualOf(source, field) !== actualOf(seen, field))) { ok = false; findings.add('image-source-differs-from-target', { key_sha256: keyHash }); }
      if (recorded !== undefined && fields.some((field) => actualOf(source, field) !== recorded[field])) { ok = false; findings.add('image-source-differs-from-copy-fingerprint', { key_sha256: keyHash }); }
      if (fields.some((field) => { const planned = field === 'sha256' ? entry.expected_sha256 : field === 'size' ? entry.expected_size : entry.expected_mime; return known(planned) && plannedOf(planned, field) !== actualOf(source, field); })) { ok = false; findings.add('image-source-differs-from-plan', { key_sha256: keyHash }); }
    }
  }
  return ok;
}

/** How the expected values of the planned objects are pinned: by the plan itself, or only by the fingerprint a receipt records. */
function expectedValueSources(inventory, fingerprints) {
  let fromPlan = 0; let fromReceipt = 0;
  for (const entry of inventory.entries) { if (known(entry.expected_sha256) && known(entry.expected_size) && known(entry.expected_mime)) fromPlan += 1; else if (fingerprints?.[entry.target_key] !== undefined) fromReceipt += 1; }
  return { from_plan: fromPlan, from_receipt_fingerprint: fromReceipt };
}

const statesEveryValue = (entry) => known(entry.expected_sha256) && known(entry.expected_size) && known(entry.expected_mime);

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
    images: { planned: inventory.entries.length, evidence_supplied: false, complete: false, receipt_sha256: null, basis: 'not-complete', pending_reason: null, objects_rehashed_by_tool: false, source_objects_rehashed_by_tool: false, receipt_seal: null, receipt_signature_verified: false, signature_required: null, expected_values: null },
    reembed: { planned: derived.reembedPlan.jobs.length, evidence_supplied: false, complete: false, receipt_sha256: null, basis: 'not-complete', observed_by_tool: false, held_to_model: null, held_to_dimension: null },
  };

  // Images.
  let imageFingerprints;
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
    // What a receipt may prove is decided by how the operator invoked validate, never by a field of the receipt.
    //  - A trusted public key: the receipt must carry a valid signature by it.
    //  - No key: the receipt is a plain file, which anyone able to write the target directory could write to match
    //    it. It can complete images only if (1) the tool re-read the copied objects (--image-target-dir), (2) the
    //    receipt carries the keyed seal the copy made with the migration passphrase, and (3) the objects are held
    //    to something other than the receipt: the values the plan itself states for every object, or the source
    //    objects re-hashed now (--image-source-dir). Otherwise the images stay pending, and say why.
    const targetObserved = files.imageObjects !== undefined;
    const sourceObserved = files.imageSourceObjects !== undefined;
    const trusted = files.trustedPublicKey !== undefined && files.trustedPublicKey !== null && files.trustedPublicKey !== '';
    const requireSignature = trusted || !targetObserved;
    result.images.signature_required = requireSignature;
    const planStatesEverything = inventory.entries.every(statesEveryValue);
    const seal = files.imageReceiptSeal ?? 'absent'; // 'valid' | 'invalid' | 'absent' | 'unverifiable'
    result.images.receipt_seal = requireSignature ? 'not-needed' : seal;
    result.images.source_objects_rehashed_by_tool = false;
    let checked = null;
    try {
      checked = validateImageReceipt({ plan: files.imagePlan, receipt: files.imageReceipt, migrationId, requireSignature, trustedPublicKey: files.trustedPublicKey });
    } catch (error) { findings.add('external-image-receipt-invalid', { code: error instanceof MigrationRefusal ? error.code : 'invalid', signature_required: requireSignature, trusted_key_configured: files.trustedPublicKey !== undefined, ...(error instanceof MigrationRefusal && error.safe_details?.problems !== undefined ? { reasons: Object.keys(error.safe_details.problems).sort().join(',') } : {}) }); }
    // what the tool saw of the objects themselves, when the operator let it look
    if (targetObserved && !checkObservedObjects({ inventory, observed: files.imageObjects.observed, sourceObserved: sourceObserved ? files.imageSourceObjects.observed : undefined, fingerprints: checked?.fingerprints, findings })) bound = false;
    let pendingReason = null;
    if (!requireSignature) {
      if (seal === 'invalid') { bound = false; findings.add('image-receipt-seal-invalid', {}); }
      else if (seal === 'absent') pendingReason = 'receipt-not-sealed';
      else if (seal === 'unverifiable') pendingReason = 'receipt-seal-needs-the-passphrase-file';
      else if (!planStatesEverything && !sourceObserved) pendingReason = 'source-dir-required-to-check-an-unsigned-receipt';
    }
    if (checked !== null) {
      const complete = bound && pendingReason === null;
      if (complete) imageFingerprints = checked.fingerprints;
      result.images.complete = complete;
      result.images.pending_reason = pendingReason;
      result.images.receipt_sha256 = checked.receipt_sha256;
      result.images.receipt_signature_verified = checked.signature_verified === true;
      result.images.objects_rehashed_by_tool = targetObserved && complete;
      result.images.source_objects_rehashed_by_tool = sourceObserved && complete;
      result.images.expected_values = expectedValueSources(inventory, checked.fingerprints);
      if (complete) result.images.basis = sourceObserved ? 'tool-rehashed-source-and-target' : targetObserved ? (trusted ? 'signed-receipt-rehashed-target' : 'tool-rehashed-target-against-plan') : 'signed-receipt-attested';
    }
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
          imageFingerprints,
          targetRows: reembedTargetRows({ jobs: files.reembedPlan?.jobs ?? [], members: derived.members, images: inventory, targetTables: live.tables, columnTypes: live.columnTypes, columnDefaults: live.columnDefaults, importedAt: live.importedAt, sequences: live.sequenceRanges }),
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
