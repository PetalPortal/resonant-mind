import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { sourceKey } from './id-map.mjs';
import { buildImageInventory } from '../external/images.mjs';
import { buildReembedPlan } from '../external/reembed.mjs';

const MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
const REF_TABLES = {
  entity_id: 'entities', linked_observation_id: 'observations', superseded_by: 'observations', supersedes: 'observations', observation_id: 'observations',
  consolidated_observation_id: 'observations', obs_a_id: 'observations', obs_b_id: 'observations', from_obs_id: 'observations', to_obs_id: 'observations',
  from_entity_id: 'entities', to_entity_id: 'entities', person: 'entities',
};
function rowsOf(bundle) { return bundle?.tables ?? bundle?.rows ?? bundle?.data ?? bundle ?? {}; }
function sourceId(row, index) { return row.id ?? row.key ?? index; }
function targetMap(compiled, table, id) { return compiled?.id_maps?.byKey?.get(sourceKey(table, id)) ?? compiled?.id_map?.[sourceKey(table, id)] ?? compiled?.idMap?.[sourceKey(table, id)]; }
function mappedRef(compiled, field, value, row = {}) {
  const table = REF_TABLES[field];
  if (field === 'from_entity' || field === 'to_entity') {
    const context = field === 'from_entity' ? row.from_context : row.to_context;
    const name = compiled?.name_map?.[`${context ?? 'default'}:${String(value)}`] ?? compiled?.name_map?.[String(value)];
    return name?.target_id ?? value;
  }
  if (!table || value === null || value === undefined) return value ?? null;
  const mapped = targetMap(compiled, table, value); return mapped?.excluded ? null : mapped?.target_id ?? value;
}
function targetFor(compiled, table, row, index) { return targetMap(compiled, table, sourceId(row, index)) ?? {}; }
function valueFor(compiled, table, row, field, value) {
  const rowHash = canonicalSha256(row); const timestamp = compiled?.value_map?.timestamps?.[`${table}:${rowHash}:${field}`]; if (timestamp !== undefined) return timestamp;
  const context = compiled?.value_map?.contexts?.[`${table}:${rowHash}:${field}`]; if (context !== undefined) return context;
  const json = compiled?.value_map?.json?.[`${table}:${rowHash}:${field}`]; if (json !== undefined) return json;
  if (table === 'entities' && field === 'entity_type') return compiled?.value_map?.entity_kinds?.[`${table}:${rowHash}`] ?? value;
  if (['status', 'salience', 'certainty', 'weight'].includes(field)) return compiled?.value_map?.enums?.[`${table}:${rowHash}:${field}`] ?? value;
  return value;
}
function mapOne(mapping, row, index, compiled) {
  const rowHash = canonicalSha256(row);
  const mapped = targetFor(compiled, mapping.source_table, row, index); if (mapped?.excluded || mapped?.merged || compiled?.excluded_rows?.includes(`${mapping.source_table}:${rowHash}`)) return null;
  const targetTable = mapping.source_table === 'entities' ? mapped?.target_table ?? 'nodes' : mapping.target_tables[0];
  const target = {};
  for (const [sourceField, targetField] of Object.entries(mapping.column_map ?? {})) {
    if (!Object.hasOwn(row, sourceField)) continue;
    let value = valueFor(compiled, mapping.source_table, row, sourceField, row[sourceField]);
    const linked = compiled?.link_map?.[`${mapping.source_table}:${rowHash}:${sourceField}`]; if (linked !== undefined) value = linked;
    if (sourceField === 'id' && (targetField === 'id' || targetField === 'legacy_id')) value = mapped?.target_id ?? value;
    if (REF_TABLES[targetField] || targetField === 'from_entity' || targetField === 'to_entity') value = mappedRef(compiled, targetField, value, row);
    if (mapping.source_table === 'entities' && sourceField === 'entity_type' && targetField === 'kind') value = compiled?.value_map?.entity_kinds?.[`entities:${canonicalSha256(row)}`] ?? value;
    if (mapping.source_table === 'entities' && sourceField === 'name' && mapped?.target_name !== undefined) value = mapped.target_name;
    target[targetField] = value;
  }
  if (mapping.source_table === 'entities') target.target_kind = target.target_kind ?? (mapped?.target_table === 'people' ? 'person' : 'node');
  if (mapping.source_table === 'observation_versions') target.version_num = compiled?.version_numbers?.[canonicalSha256(row)];
  if (mapping.source_table === 'tensions') {
    const selected = compiled?.semantic_choices?.[`tensions:${canonicalSha256(row)}`];
    const action = typeof selected === 'string' ? selected : selected?.action ?? selected?.type ?? selected?.kind ?? selected?.choice;
    target.visit_resolution_shape = action === 'preserve-visits-and-resolve' ? 'resolved' : action === 'preserve-visits-and-open' ? 'open' : 'reviewed';
    if (selected?.resolved_at !== undefined) target.resolved_at = selected.resolved_at;
  }
  if (mapping.source_table === 'dormant_observations') target.semantic_name_translation = 'dormant_observation→orphan_observation';
  return target;
}
export function transformRelational({ bundle, tables: inputTables, compiledPolicy, policy, migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  const tables = inputTables ?? rowsOf(bundle);
  const compiled = compiledPolicy ?? policy;
  if (!compiled) throw new TypeError('transformRelational requires a compiled policy.');
  const members = {}; const staging = {}; const coverage = {};
  for (const mapping of MAP) {
    const rows = Array.isArray(tables[mapping.source_table]) ? tables[mapping.source_table] : [];
    coverage[mapping.source_table] = { source_rows: rows.length, transformed_rows: 0, excluded_rows: 0, target_tables: mapping.target_tables };
    if (mapping.source_table === 'embeddings') {
      staging.legacy_embeddings = rows.map((row, index) => ({ inventory_id: row.id ?? index, source_type: row.source_type, source_id: row.source_id, content: row.content ?? null, metadata: row.metadata ?? null, legacy_vector_present: row.embedding !== null && row.embedding !== undefined }));
      coverage[mapping.source_table].transformed_rows = rows.length; continue;
    }
    for (const [index, row] of rows.entries()) {
      const mapped = mapOne(mapping, row, index, compiled);
      if (mapped === null) { coverage[mapping.source_table].excluded_rows += 1; continue; }
      const targetTable = mapping.source_table === 'entities' ? (targetMap(compiled, 'entities', sourceId(row, index))?.target_table ?? 'nodes') : mapping.target_tables[0];
      (members[targetTable] ??= []).push(mapped); coverage[mapping.source_table].transformed_rows += 1;
    }
  }
  for (const rows of Object.values(members)) rows.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  for (const [table, value] of Object.entries(coverage)) value.losses = (compiled.losses ?? []).filter((loss) => loss.source_table === table).length;
  const imagePlan = buildImageInventory({ tables, idMaps: { idMap: compiled.id_map }, migrationId: migrationId ?? compiled.migration_id, bundleManifestSha256: bundleManifestSha256 ?? compiled.bundle_manifest_sha256, compiledPolicySha256: compiledPolicySha256 ?? compiled.plan_sha256 });
  const reembedPlan = buildReembedPlan({ members, images: imagePlan, migrationId: migrationId ?? compiled.migration_id, bundleManifestSha256: bundleManifestSha256 ?? compiled.bundle_manifest_sha256, compiledPolicySha256: compiledPolicySha256 ?? compiled.plan_sha256 });
  const result = { format_version: FORMAT_VERSION, plan_type: 'relational-staging', migration_id: migrationId ?? compiled.migration_id, bundle_manifest_sha256: bundleManifestSha256 ?? compiled.bundle_manifest_sha256, compiled_policy_sha256: compiledPolicySha256 ?? compiled.plan_sha256, members, staging, coverage, image_inventory: imagePlan, reembed_jobs: reembedPlan, legacy_vectors_imported: false };
  result.plan_sha256 = canonicalSha256(result); return result;
}
export async function* streamRelational(input) { const result = transformRelational(input); for (const [table, rows] of Object.entries(result.members)) for (const row of rows) yield { table, row }; }
export const transformAll = transformRelational;
