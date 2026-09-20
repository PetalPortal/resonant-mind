import { canonicalSha256 } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

const VECTOR_KEYS = new Set(['embedding', 'vector', 'values', 'embedding_vector']);
const SEARCHABLE_TABLES = new Set(['observations', 'observation_versions', 'threads', 'context_entries', 'identity', 'journals', 'consolidation_groups', 'tensions', 'archive', 'search_text']);
function withoutVectors(value) {
  if (Array.isArray(value)) return value.map(withoutVectors);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !VECTOR_KEYS.has(key)).map(([key, child]) => [key, withoutVectors(child)]));
  return value;
}
function rowId(row, index) { return row.id ?? row.key ?? row.uuid ?? index; }
function contentFor(table, row) { return withoutVectors({ table, row }); }
function jobFor(table, row, index, modality, migrationId, extra = {}) {
  const targetId = rowId(row, index); const content = contentFor(table, row); const contentHash = canonicalSha256(content);
  const base = { migration_id: migrationId, target_locator: { table, id: targetId }, modality, content_hash: contentHash, ...extra };
  return { job_id: canonicalSha256(base), ...base };
}
export function buildReembedPlan({ rows, members, relational, images = [], migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  if (typeof migrationId !== 'string' || migrationId.length === 0) throw new TypeError('buildReembedPlan requires migrationId.');
  const source = members ?? relational?.members ?? rows ?? {}; const jobs = [];
  for (const [table, values] of Object.entries(source)) if (SEARCHABLE_TABLES.has(table) && Array.isArray(values)) values.forEach((row, index) => jobs.push(jobFor(table, row, index, 'text', migrationId)));
  const imageRows = Array.isArray(images) ? images : images?.entries; if (Array.isArray(imageRows)) for (const entry of imageRows) {
    const id = entry.linked_target_ids?.image_id ?? entry.target_id ?? entry.target_key; const imageContent = { source_logical_path: entry.source_logical_path, target_key: entry.target_key, ...(entry.expected_sha256 === undefined ? {} : { expected_sha256: entry.expected_sha256 }), ...(entry.expected_size === undefined ? {} : { expected_size: entry.expected_size }) };
    jobs.push(jobFor('images', { id, ...imageContent }, 0, 'image', migrationId, { source_logical_path: entry.source_logical_path, target_key: entry.target_key }));
  }
  jobs.sort((a, b) => a.job_id.localeCompare(b.job_id));
  const plan = { format_version: FORMAT_VERSION, plan_type: 'reembed-job-plan', migration_id: migrationId, legacy_vectors_imported: false, searchable_job_count: jobs.length, jobs }; if (bundleManifestSha256 !== undefined) plan.bundle_manifest_sha256 = bundleManifestSha256; if (compiledPolicySha256 !== undefined) plan.compiled_policy_sha256 = compiledPolicySha256;
  plan.plan_sha256 = canonicalSha256(plan); return plan;
}

function refuse(summary, details = {}) { return new MigrationRefusal({ code: 'RMIG-E-REEMBED-INCOMPLETE', phase: 'plan-reembed', summary, safe_details: details, report_path: null }); }
function receiptRows(receipts) { return Array.isArray(receipts) ? receipts : receipts?.receipts ?? receipts?.entries ?? []; }
function locatorKey(locator) { return `${locator?.table}:${String(locator?.id)}`; }
function targetHashFor(job, targetRows) {
  if (!targetRows) return job.content_hash;
  const row = targetRows[locatorKey(job.target_locator)] ?? targetRows[job.target_locator?.table]?.find?.((candidate) => String(rowId(candidate, 0)) === String(job.target_locator.id));
  return row === undefined ? null : canonicalSha256(contentFor(job.target_locator.table, row));
}
export function validateReembedReceipts({ plan, receipts, targetRows, expectedModel, expectedDimension, allowReviewedDefer = false } = {}) {
  if (!plan || plan.legacy_vectors_imported === true) throw refuse('Legacy vectors are present in the re-embedding plan.');
  const jobs = Array.isArray(plan.jobs) ? plan.jobs : []; const rows = receiptRows(receipts); const byId = new Map();
  for (const receipt of rows) {
    if (!receipt || typeof receipt.job_id !== 'string' || byId.has(receipt.job_id)) throw refuse('Re-embedding receipts contain a duplicate job receipt.');
    byId.set(receipt.job_id, receipt);
  }
  const problems = []; const completed = [];
  for (const job of jobs) {
    const receipt = byId.get(job.job_id); if (!receipt) { problems.push({ job_id: job.job_id, reason: 'missing' }); continue; }
    if (receipt.status !== 'complete') { problems.push({ job_id: job.job_id, reason: receipt.status ?? 'invalid-status' }); continue; }
    if (receipt.content_hash !== job.content_hash) problems.push({ job_id: job.job_id, reason: 'content-hash-mismatch' });
    const model = receipt.model ?? receipt.model_id; const dimension = receipt.dimension ?? receipt.vector_dimension; if (typeof model !== 'string' || model.length === 0) problems.push({ job_id: job.job_id, reason: 'model-missing' }); if (!Number.isSafeInteger(dimension) || dimension < 1) problems.push({ job_id: job.job_id, reason: 'dimension-missing' });
    if (expectedModel !== undefined && model !== expectedModel) problems.push({ job_id: job.job_id, reason: 'model-mismatch' });
    if (expectedDimension !== undefined && dimension !== expectedDimension) problems.push({ job_id: job.job_id, reason: 'dimension-mismatch' });
    const targetHash = targetHashFor(job, targetRows); if (targetHash !== null && targetHash !== job.content_hash) problems.push({ job_id: job.job_id, reason: 'target-content-changed' });
    completed.push(job.job_id);
  }
  for (const receipt of rows) if (!jobs.some((job) => job.job_id === receipt.job_id)) problems.push({ job_id: receipt.job_id, reason: 'duplicate-or-unknown' });
  const result = { complete: problems.length === 0, status: problems.length === 0 ? 'complete' : 'incomplete', expected_jobs: jobs.length, completed_jobs: completed.length, problems, receipts_sha256: canonicalSha256(rows) };
  if (!result.complete) throw refuse('Re-embedding receipts do not prove complete, unchanged target content.', { problems: problems.map(({ reason }) => reason) });
  return result;
}
export { SEARCHABLE_TABLES, contentFor };
export const planReembed = buildReembedPlan;
