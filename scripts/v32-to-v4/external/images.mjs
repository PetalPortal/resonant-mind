import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

function refuse(summary, details = {}) {
  return new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary, safe_details: details, report_path: null });
}
function rowsOf(input) { return Array.isArray(input) ? input : input?.images ?? input?.tables?.images ?? input?.rows?.images ?? input?.data?.images ?? []; }
function sourceId(row, index) { return row.id ?? row.key ?? index; }
function entryFor(idMaps, table, id) { return idMaps?.byKey?.get(`${table}:${canonicalJson(id).trim()}`) ?? idMaps?.idMap?.[`${table}:${canonicalJson(id).trim()}`]; }
function withoutHash(value, field) { const copy = { ...value }; delete copy[field]; return copy; }
function planHash(plan) { return canonicalSha256(withoutHash(plan, 'plan_sha256')); }
function receiptHash(receipt) { return canonicalSha256(withoutHash(receipt, 'receipt_sha256')); }
function digest(value, label) { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw refuse(`${label} must be a lowercase SHA-256 digest.`); return value; }
function expectedSize(value) { if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) throw refuse('Image receipt is missing an exact object size.'); return Number(value); }
function expectedMime(value) { if (typeof value !== 'string' || !/^image\/[a-z0-9.+-]+$/iu.test(value)) throw refuse('Image receipt is missing an exact image MIME type.'); return value.toLowerCase(); }

function sniffMime(bytes) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString() === 'ftyp' && /(?:avif|avis)/u.test(bytes.subarray(8, 12).toString())) return 'image/avif';
  return 'application/octet-stream';
}

function sourceMapping(entry, expected) {
  if (entry.source_logical_path !== expected.source_logical_path || entry.target_key !== expected.target_key) return false;
  if (entry.source_path !== undefined && entry.source_path !== expected.source_logical_path) return false;
  return true;
}

export function buildImageInventory({ rows, images, tables, idMaps, linkMap = {}, excludedRows = new Set(), migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  const input = rows ?? images ?? tables ?? [];
  const excluded = excludedRows instanceof Set ? excludedRows : new Set(excludedRows ?? []);
  const entries = rowsOf(input).flatMap((row, index) => {
    const sourceIdValue = sourceId(row, index); const rowHash = canonicalSha256(row); if (excluded.has(`images:${rowHash}`)) return [];
    const mapped = entryFor(idMaps, 'images', sourceIdValue); if (mapped?.excluded || mapped?.merged) return [];
    const path = row.path ?? row.logical_path ?? row.object_path ?? row.key; if (typeof path !== 'string' || path.length === 0) throw new TypeError('Image inventory requires a source logical path.');
    const expectedHash = row.sha256 ?? row.content_sha256 ?? row.expected_sha256 ?? row.hash ?? null;
    const expectedSize = row.size ?? row.byte_size ?? row.expected_size ?? null;
    const expectedMimeValue = row.mime ?? row.content_type ?? row.expected_mime ?? null;
    const targetId = mapped?.target_id ?? sourceIdValue;
    const suffix = expectedHash && /^[0-9a-f]{64}$/u.test(String(expectedHash)) ? String(expectedHash).slice(0, 16) : sha256Hex(path).slice(0, 16);
    const linked = { image_id: targetId };
    for (const [field, table] of [['entity_id','entities'], ['observation_id','observations']]) if (row[field] !== null && row[field] !== undefined) { const decisionKey = `images:${rowHash}:${field}`; if (Object.hasOwn(linkMap, decisionKey) && linkMap[decisionKey] === null) continue; const decided = Object.hasOwn(linkMap, decisionKey) ? linkMap[decisionKey] : row[field]; const reference = entryFor(idMaps, table, decided); if (reference?.excluded) continue; linked[field] = reference?.target_id ?? decided; }
    const targetKey = `images/${String(targetId)}-${suffix}`;
    return [{ source_table:'images', source_id:sourceIdValue, source_logical_path:path, expected_sha256:expectedHash, expected_size:expectedSize, expected_mime:expectedMimeValue, target_key:targetKey, target_locator:{ store:'object', key:targetKey }, linked_target_ids:linked }];
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const plan = { format_version:FORMAT_VERSION, plan_type:'image-inventory', migration_id:migrationId, entries };
  if (bundleManifestSha256 !== undefined) plan.bundle_manifest_sha256 = bundleManifestSha256;
  if (compiledPolicySha256 !== undefined) plan.compiled_policy_sha256 = compiledPolicySha256;
  plan.plan_sha256 = canonicalSha256(plan); return plan;
}

function trustedKey(input) {
  const value = input?.public_key ?? input?.publicKey ?? input;
  if (!value) return null;
  if (value?.type === 'public' && typeof value?.export === 'function') return value;
  try { return createPublicKey(value); } catch { throw refuse('The trusted external receipt public key is invalid.'); }
}
function verifyOfflineSignature(receipt, trustedPublicKey) {
  const signature = receipt?.signature;
  if (!signature || signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature.value)) throw refuse('External image receipts require an Ed25519 offline signature.');
  if (typeof signature.key_id !== 'string' || signature.key_id.length === 0) throw refuse('External image receipts require a trusted signature key ID.');
  const key = trustedKey(trustedPublicKey); if (!key) throw refuse('External image receipts require a configured trusted public key.');
  let bytes; try { bytes = Buffer.from(signature.value, 'base64'); } catch { throw refuse('External image receipt signature is not valid base64.'); }
  const { signature: _signature, receipt_sha256: _receiptHash, ...signedBody } = receipt;
  if (!verifySignature(null, Buffer.from(canonicalJson(signedBody)), key, bytes)) throw refuse('External image receipt signature verification failed.');
  return true;
}

export function validateImageReceipt({ plan, receipt, migrationId = plan?.migration_id, requireSignature = receipt?.external_handoff === true, trustedPublicKey, trustedKey: configuredKey } = {}) {
  if (!plan || plan.plan_type !== 'image-inventory' || typeof plan.plan_sha256 !== 'string' || planHash(plan) !== plan.plan_sha256) throw refuse('Image inventory plan hash is missing or invalid.');
  if (migrationId !== undefined && receipt?.migration_id !== migrationId) throw refuse('Image receipt migration identity does not match the requested migration.');
  if (receipt?.format_version !== FORMAT_VERSION || receipt?.receipt_type !== 'image-copy' || receipt?.status !== 'complete') throw refuse('External image receipt is not a complete versioned image-copy receipt.');
  if (receipt.plan_sha256 !== plan.plan_sha256) throw refuse('Image receipt is not bound to the exact image inventory plan.');
  if (plan.bundle_manifest_sha256 !== undefined && receipt.bundle_manifest_sha256 !== plan.bundle_manifest_sha256) throw refuse('Image receipt bundle binding does not match the image plan.');
  if (plan.compiled_policy_sha256 !== undefined && receipt.compiled_policy_sha256 !== plan.compiled_policy_sha256) throw refuse('Image receipt policy binding does not match the image plan.');
  if (receipt.receipt_sha256 !== undefined && receipt.receipt_sha256 !== receiptHash(receipt)) throw refuse('Image receipt hash is invalid.');
  if (requireSignature) verifyOfflineSignature(receipt, trustedPublicKey ?? configuredKey);
  const expected = plan.entries ?? []; const entries = receipt.entries ?? receipt.objects;
  if (!Array.isArray(entries) || entries.length !== expected.length) throw refuse('External image receipt does not contain the complete planned object set.', { expected: expected.length });
  const byTarget = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.target_key !== 'string' || byTarget.has(entry.target_key)) throw refuse('Image receipt contains a duplicate or invalid target object.');
    byTarget.set(entry.target_key, entry);
  }
  const missing = [];
  for (const item of expected) {
    const actual = byTarget.get(item.target_key);
    try {
      if (!actual || !sourceMapping(actual, item) || actual.verified !== true || actual.target_locator?.store !== item.target_locator?.store || actual.target_locator?.key !== item.target_locator?.key || digest(item.expected_sha256, 'Image plan expected SHA-256') !== actual.sha256 || actual.source_sha256 !== actual.sha256 || expectedSize(item.expected_size) !== expectedSize(actual.size) || expectedMime(item.expected_mime) !== expectedMime(actual.mime)) missing.push(item.target_key);
    } catch { missing.push(item.target_key); }
  }
  if (missing.length || [...byTarget.keys()].some((key) => !expected.some((item) => item.target_key === key))) throw refuse('External image receipt does not cover every planned object with exact source and target bindings.', { missing: missing.length });
  return { complete: true, covered: expected.length, receipt_sha256: receipt.receipt_sha256 ?? receiptHash(receipt), signature_verified: requireSignature };
}
export const planImages = buildImageInventory;
export { sniffMime as mimeFor, planHash, receiptHash, verifyOfflineSignature };
