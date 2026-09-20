import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

function rowsOf(input) { if (Array.isArray(input)) return input; return input?.images ?? input?.tables?.images ?? input?.rows?.images ?? input?.data?.images ?? []; }
function sourceId(row, index) { return row.id ?? row.key ?? index; }
function entryFor(idMaps, table, id) { return idMaps?.byKey?.get(`${table}:${canonicalJson(id).trim()}`) ?? idMaps?.idMap?.[`${table}:${canonicalJson(id).trim()}`]; }
export function buildImageInventory({ rows, images, tables, idMaps, linkMap = {}, excludedRows = new Set(), migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  const input = rows ?? images ?? tables ?? []; const excluded = excludedRows instanceof Set ? excludedRows : new Set(excludedRows ?? []);
  const entries = rowsOf(input).flatMap((row, index) => {
    const sourceIdValue = sourceId(row, index); const rowHash = canonicalSha256(row); if (excluded.has(`images:${rowHash}`)) return [];
    const mapped = entryFor(idMaps, 'images', sourceIdValue); if (mapped?.excluded || mapped?.merged) return [];
    const path = row.path ?? row.logical_path ?? row.object_path; if (typeof path !== 'string' || path.length === 0) throw new TypeError('Image inventory requires a source logical path.');
    const expectedHash = row.sha256 ?? row.content_sha256 ?? row.expected_sha256 ?? row.hash ?? null; const expectedSize = row.size ?? row.byte_size ?? row.expected_size ?? null; const targetId = mapped?.target_id ?? sourceIdValue; const suffix = expectedHash && /^[0-9a-f]{64}$/u.test(String(expectedHash)) ? String(expectedHash).slice(0, 16) : sha256Hex(path).slice(0, 16);
    const linked = { image_id: targetId };
    for (const [field, table] of [['entity_id','entities'], ['observation_id','observations']]) if (row[field] !== null && row[field] !== undefined) { const decisionKey = `images:${rowHash}:${field}`; if (Object.hasOwn(linkMap, decisionKey) && linkMap[decisionKey] === null) continue; const decided = Object.hasOwn(linkMap, decisionKey) ? linkMap[decisionKey] : row[field]; const reference = entryFor(idMaps, table, decided); if (reference?.excluded) continue; linked[field] = reference?.target_id ?? decided; }
    return [{ source_table:'images', source_id:sourceIdValue, source_logical_path:path, expected_sha256:expectedHash, expected_size:expectedSize, target_key:`images/${String(targetId)}-${suffix}`, linked_target_ids:linked }];
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const plan = { format_version:FORMAT_VERSION, plan_type:'image-inventory', migration_id:migrationId, entries }; if (bundleManifestSha256 !== undefined) plan.bundle_manifest_sha256 = bundleManifestSha256; if (compiledPolicySha256 !== undefined) plan.compiled_policy_sha256 = compiledPolicySha256; plan.plan_sha256 = canonicalSha256(plan); return plan;
}
export function validateImageReceipt({ plan, receipt } = {}) {
  const expected = plan?.entries ?? []; const entries = receipt?.entries ?? receipt?.objects ?? []; const byTarget = new Map(); for (const entry of entries) { if (byTarget.has(entry.target_key)) throw new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary: 'Image receipt contains duplicate target objects.', safe_details: {}, report_path: null }); byTarget.set(entry.target_key, entry); }
  const missing = expected.filter((entry) => { const actual = byTarget.get(entry.target_key); return !actual || actual.verified !== true || entry.expected_sha256 !== null && entry.expected_sha256 !== undefined && actual.sha256 !== entry.expected_sha256 || entry.expected_size !== null && entry.expected_size !== undefined && Number(actual.size) !== Number(entry.expected_size); });
  if (receipt?.status !== 'complete' || missing.length > 0) throw new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary: 'External image receipt does not cover every planned object.', safe_details: { missing: missing.length }, report_path: null });
  return { complete: true, covered: expected.length, receipt_sha256: canonicalSha256(receipt) };
}
export const planImages = buildImageInventory;
