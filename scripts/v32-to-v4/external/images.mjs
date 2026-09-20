import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';

function rowsOf(input) { if (Array.isArray(input)) return input; return input?.images ?? input?.tables?.images ?? input?.rows?.images ?? input?.data?.images ?? []; }
function sourceId(row, index) { return row.id ?? row.key ?? index; }
function idEntry(idMaps, id) { return idMaps?.byKey?.get(`images:${canonicalJson(id).trim()}`) ?? idMaps?.idMap?.[`images:${canonicalJson(id).trim()}`]; }
export function buildImageInventory({ rows, images, tables, idMaps, migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  const input = rows ?? images ?? tables ?? [];
  const entries = rowsOf(input).map((row, index) => {
    const sourceIdValue = sourceId(row, index); const mapped = idEntry(idMaps, sourceIdValue); const targetId = mapped?.target_id ?? sourceIdValue;
    const path = row.path ?? row.logical_path ?? row.object_path;
    if (typeof path !== 'string' || path.length === 0) throw new TypeError('Image inventory requires a source logical path.');
    const expectedHash = row.sha256 ?? row.content_sha256 ?? row.expected_sha256 ?? row.hash ?? null;
    const expectedSize = row.size ?? row.byte_size ?? row.expected_size ?? null;
    const suffix = expectedHash && /^[0-9a-f]{64}$/u.test(String(expectedHash)) ? String(expectedHash).slice(0, 16) : sha256Hex(path).slice(0, 16);
    return {
      source_table: 'images', source_id: sourceIdValue, source_logical_path: path,
      expected_sha256: expectedHash, expected_size: expectedSize,
      target_key: `images/${String(targetId)}-${suffix}`,
      linked_target_ids: { image_id: targetId, ...(row.entity_id === null || row.entity_id === undefined ? {} : { entity_id: idMaps ? (idMaps.byKey?.get(`entities:${canonicalJson(row.entity_id).trim()}`)?.target_id ?? row.entity_id) : row.entity_id }), ...(row.observation_id === null || row.observation_id === undefined ? {} : { observation_id: idMaps ? (idMaps.byKey?.get(`observations:${canonicalJson(row.observation_id).trim()}`)?.target_id ?? row.observation_id) : row.observation_id }) },
    };
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const plan = { format_version: FORMAT_VERSION, plan_type: 'image-inventory', migration_id: migrationId, bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256, entries };
  plan.plan_sha256 = canonicalSha256(plan); return plan;
}
export const planImages = buildImageInventory;
