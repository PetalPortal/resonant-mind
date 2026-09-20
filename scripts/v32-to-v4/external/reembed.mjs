import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';

const VECTOR_KEYS = new Set(['embedding', 'vector', 'values', 'embedding_vector']);
function textFor(row) { return Object.entries(row).filter(([key, value]) => !VECTOR_KEYS.has(key) && typeof value === 'string' && ['content', 'summary', 'description', 'reason', 'resolution', 'text', 'path'].some((part) => key.toLowerCase().includes(part))).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}`).join('\n'); }
function rowId(row, index) { return row.id ?? row.legacy_id ?? row.key ?? index; }
function job(table, row, index, modality, migrationId) {
  const targetId = rowId(row, index); const content = textFor(row); const contentHash = canonicalSha256({ table, target_id: targetId, content });
  const locator = { table, id: targetId };
  const base = { target_locator: locator, content_hash: contentHash, modality, model_policy: 'pending-reviewed-model-policy', migration_id: migrationId };
  return { job_id: canonicalSha256(base), ...base };
}
export function buildReembedPlan({ rows, members, relational, images = [], migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  const source = members ?? relational?.members ?? rows ?? {};
  const jobs = [];
  const searchableTables = new Set(['observations', 'observation_versions', 'threads', 'context_entries', 'identity', 'journals', 'consolidation_groups', 'tensions']);
  for (const [table, values] of Object.entries(source)) if (searchableTables.has(table) && Array.isArray(values)) values.forEach((row, index) => jobs.push(job(table, row, index, 'text', migrationId)));
  const imageRows = images?.entries ?? images;
  if (Array.isArray(imageRows)) for (const entry of imageRows) jobs.push({ ...job('images', { id: entry.linked_target_ids?.image_id ?? entry.target_key, description: entry.source_logical_path }, 0, 'image', migrationId), target_locator: { table: 'images', id: entry.linked_target_ids?.image_id ?? entry.target_key }, source_logical_path: entry.source_logical_path });
  jobs.sort((a, b) => a.job_id.localeCompare(b.job_id));
  const plan = { format_version: FORMAT_VERSION, plan_type: 'reembed-job-plan', migration_id: migrationId, bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256, legacy_vectors_imported: false, jobs };
  plan.plan_sha256 = canonicalSha256(plan); return plan;
}
export const planReembed = buildReembedPlan;
