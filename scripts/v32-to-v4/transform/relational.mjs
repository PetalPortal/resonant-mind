import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { sourceKey } from './id-map.mjs';
import { buildImageInventory } from '../external/images.mjs';
import { buildReembedPlan } from '../external/reembed.mjs';
import { assertTargetRow, canonicalText, TARGET_SCHEMAS } from './target-schema.mjs';
import { normalizeTimestamp } from './value-map.mjs';

const MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
const REF_TABLES = { entity_id:'entities', linked_observation_id:'observations', superseded_by:'observations', supersedes:'observations', observation_id:'observations', consolidated_observation_id:'observations', obs_a_id:'observations', obs_b_id:'observations', from_obs_id:'observations', to_obs_id:'observations', from_entity_id:'entities', to_entity_id:'entities' };
function rowsOf(bundle) { return bundle?.tables ?? bundle?.rows ?? bundle?.data ?? bundle ?? {}; }
function sourceId(row, index) { return row.id ?? row.key ?? index; }
function targetMap(compiled, table, id) { return compiled?.id_map?.[sourceKey(table, id)] ?? compiled?.id_maps?.byKey?.get(sourceKey(table, id)); }
function nameForTarget(compiled, id, fallback) {
  for (const entry of Object.values(compiled?.name_map ?? {})) if (String(entry.target_id) === String(id) && typeof entry.target_name === 'string') return entry.target_name;
  return fallback;
}
function mappedRef(compiled, field, value, row, rowHash) {
  if (value === null || value === undefined) return null;
  if (field === 'from_entity' || field === 'to_entity') {
    const linked = compiled.link_map?.[`${rowHash}:${field}`];
    if (linked !== undefined) { const entry = targetMap(compiled, 'entities', linked); return entry?.excluded ? null : nameForTarget(compiled, entry?.target_id ?? linked, String(value)); }
    const context = field === 'from_entity' ? row.from_context : row.to_context;
    const mapped = compiled.name_map?.[`${context ?? 'default'}:${String(value)}`] ?? compiled.name_map?.[String(value)];
    return mapped?.target_name ?? String(value);
  }
  const table = REF_TABLES[field]; if (!table) return value;
  const mapped = targetMap(compiled, table, value); return mapped?.excluded ? null : mapped?.target_id ?? value;
}
function valueFor(compiled, table, row, field, value) {
  const hash = canonicalSha256(row); const timestamp = compiled.value_map?.timestamps?.[`${table}:${hash}:${field}`]; if (timestamp !== undefined) return timestamp;
 const date = compiled.value_map?.dates?.[`${table}:${hash}:${field}`]; if (date !== undefined) return date;
  const context = compiled.value_map?.contexts?.[`${table}:${hash}:${field}`]; if (context !== undefined) return context;
  const json = compiled.value_map?.json?.[`${table}:${hash}:${field}`]; if (json !== undefined) return json;
  const enumValue = compiled.value_map?.enums?.[`${table}:${hash}:${field}`]; if (enumValue !== undefined) return enumValue;
  if (table === 'entities' && field === 'entity_type') return compiled.value_map?.entity_kinds?.[`entities:${hash}`] ?? value;
  return value;
}
function sourceArray(value, label) {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = undefined; } }
  if (!Array.isArray(parsed)) throw new TypeError(`${label} must be an array after reviewed JSON conversion.`);
  return parsed.map((item) => { const number = typeof item === 'number' ? item : Number(item); if (!Number.isSafeInteger(number)) throw new TypeError(`${label} contains a non-integer observation ID.`); return number; });
}
function targetFieldValue(mapping, targetTable, sourceField, targetField, row, compiled, rowHash) {
  let value = valueFor(compiled, mapping.source_table, row, sourceField, row[sourceField]);
  const linked = compiled.link_map?.[`${mapping.source_table}:${rowHash}:${sourceField}`]; if (linked !== undefined) value = linked;
  if (sourceField === 'id' && targetField === 'id') value = targetMap(compiled, mapping.source_table, sourceId(row, 0))?.target_id ?? value;
  if (REF_TABLES[targetField]) value = mappedRef(compiled, targetField, value, row, `${mapping.source_table}:${rowHash}`);
  if (targetField === 'from_entity' || targetField === 'to_entity') value = mappedRef(compiled, targetField, value, row, `${mapping.source_table}:${rowHash}`);
  if (targetField === 'source_observation_ids') {
    const values = sourceArray(value, `${mapping.source_table}.${sourceField}`); value = values.map((id) => mappedRef(compiled, 'observation_id', id, row, `${mapping.source_table}:${rowHash}`)).filter((id) => id !== null);
  }
  const type = TARGET_SCHEMAS[targetTable]?.columns?.[targetField];
  if (type === 'text' && value !== null && typeof value !== 'string') value = canonicalText(value);
  return value;
}
function routeSubject(compiled, entityId) {
  const entry = targetMap(compiled, 'entities', entityId);
  if (!entry || entry.excluded) return null;
  return entry.target_table === 'people' ? { person_id: entry.target_id } : entry.target_table === 'nodes' ? { node_id: entry.target_id } : null;
}
function mapOne(mapping, row, index, compiled) {
  const rowHash = canonicalSha256(row); const mapped = targetMap(compiled, mapping.source_table, sourceId(row, index));
  if (mapped?.excluded || mapped?.merged || compiled.excluded_rows?.includes(`${mapping.source_table}:${rowHash}`)) return null;
  const targetTable = mapping.source_table === 'entities' ? (mapped?.target_table ?? 'nodes') : mapping.target_tables[0];
  if (!targetTable) return null;
  const target = {};
  for (const [sourceField, targetField] of Object.entries(mapping.column_map ?? {})) {
    if (!Object.hasOwn(row, sourceField)) continue;
    let value = targetFieldValue(mapping, targetTable, sourceField, targetField, row, compiled, rowHash);
    if (mapping.source_table === 'entities' && mapped?.field_values?.[sourceField] !== undefined) value = mapped.field_values[sourceField];
    if (mapping.source_table === 'entities' && sourceField === 'name') value = mapped?.target_name ?? value;
    target[targetField] = value;
  }
  if (mapping.source_table === 'entities') {
    target.kind = mapped?.final_kind ?? target.kind;
  }
  if (mapping.source_table === 'observations' || mapping.source_table === 'images' || mapping.source_table === 'consolidation_groups') {
    const entityId = target.entity_id ?? row.entity_id;
    const subject = routeSubject(compiled, entityId); if (!subject && mapping.source_table === 'observations') return null;
    if (subject) Object.assign(target, subject);
  }
  if (mapping.source_table === 'observation_versions') target.version_num = compiled.version_numbers?.[rowHash];
  if (mapping.source_table === 'tensions') {
    const requiresReview = Object.hasOwn(row, 'status') || Object.hasOwn(row, 'sit_notes');
    const selected = compiled.semantic_choices?.[`tensions:${rowHash}`]; const action = typeof selected === 'string' ? selected : selected?.action ?? selected?.type ?? selected?.kind ?? selected?.choice;
    if (requiresReview && (!action || action === 'exclude-row')) return null;
    if (action === 'exclude-row') return null;
    if (selected?.last_visited !== undefined) target.last_visited = normalizeTimestamp(selected.last_visited, { choice: selected.last_visited_choice, table:'tensions', field:'last_visited' });
    else if (Number(target.visits ?? 0) > 0) target.last_visited = target.created_at;
    if (action === 'preserve-visits-and-resolve') { target.resolved_at = selected.resolved_at === null || selected.resolved_at === undefined ? target.resolved_at : normalizeTimestamp(selected.resolved_at, { choice: selected.resolved_at_choice, table:'tensions', field:'resolved_at' }); if (selected.resolution !== undefined) target.resolution = selected.resolution; }
    else if (action === 'preserve-visits-and-open') { target.resolved_at = null; target.resolution = null; }
  }
  // A nullable reviewed link is omitted rather than emitting a stale source FK.
  for (const [field, value] of Object.entries(target)) if (value === null && !TARGET_SCHEMAS[targetTable].required.includes(field)) delete target[field];
  if ((TARGET_SCHEMAS[targetTable].required ?? []).some((field) => target[field] === null || target[field] === undefined)) return null;
  assertTargetRow(targetTable, target);
  return target;
}
function vectorInventory(rows, scanRows = rows) {
  let vectorPayloads = 0; let vectorComponents = 0;
  const visit = (value, key = '') => {
    if (value === null || value === undefined) return;
    if (key === 'embedding' || key === 'vector' || key === 'values' || key === 'embedding_vector') { vectorPayloads += 1; if (Array.isArray(value)) vectorComponents += value.length; return; }
    if (Array.isArray(value)) for (const item of value) visit(item, key);
    else if (typeof value === 'object') for (const [child, item] of Object.entries(value)) visit(item, child);
  };
  for (const row of scanRows) visit(row); return { rows: rows.length, vector_payloads: vectorPayloads, vector_components: vectorComponents };
}
function rowHasVector(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(rowHasVector);
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => ['embedding','vector','values','embedding_vector'].includes(key) || rowHasVector(child));
}
function assertNoLegacyVectors(value, path = 'artifact') {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoLegacyVectors(item, `${path}[${index}]`));
  if (typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['embedding','vector','values','embedding_vector'].includes(key)) throw new TypeError(`Legacy vector payload survived at ${path}.${key}.`); assertNoLegacyVectors(child, `${path}.${key}`); }
}
export function transformRelational({ bundle, tables: inputTables, compiledPolicy, policy, migrationId, bundleManifestSha256, compiledPolicySha256 } = {}) {
  const tables = inputTables ?? rowsOf(bundle); const compiled = compiledPolicy ?? policy; if (!compiled) throw new TypeError('transformRelational requires a compiled policy.');
  const mappings = MAP.filter((mapping) => (compiled.mapping_tables ?? MAP.map(({ source_table }) => source_table)).includes(mapping.source_table) && Array.isArray(tables[mapping.source_table]));
  const members = {}; const coverage = {}; const embeddings = tables.embeddings ?? [];
  for (const mapping of mappings) {
    const rows = tables[mapping.source_table] ?? []; coverage[mapping.source_table] = { source_rows: rows.length, transformed_rows: 0, excluded_rows: 0, target_tables: mapping.target_tables };
    if (mapping.source_table === 'embeddings') continue;
    for (const [index, row] of rows.entries()) { const mapped = mapOne(mapping, row, index, compiled); if (mapped === null) { coverage[mapping.source_table].excluded_rows += 1; continue; } const targetTable = mapping.source_table === 'entities' ? (targetMap(compiled, 'entities', sourceId(row, index))?.target_table ?? 'nodes') : mapping.target_tables[0]; (members[targetTable] ??= []).push(mapped); coverage[mapping.source_table].transformed_rows += 1; }
  }
  for (const rows of Object.values(members)) rows.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  for (const [table, value] of Object.entries(coverage)) value.losses = (compiled.losses ?? []).filter((loss) => loss.source_table === table).length;
  const imagePlan = buildImageInventory({ tables, idMaps: { idMap: compiled.id_map }, linkMap: compiled.link_map, excludedRows: compiled.excluded_rows, migrationId: migrationId ?? compiled.migration_id, bundleManifestSha256: bundleManifestSha256 ?? compiled.bundle_manifest_sha256, compiledPolicySha256: compiledPolicySha256 ?? compiled.plan_sha256 });
  const reembedPlan = buildReembedPlan({ members, images: imagePlan, migrationId: migrationId ?? compiled.migration_id, bundleManifestSha256: bundleManifestSha256 ?? compiled.bundle_manifest_sha256, compiledPolicySha256: compiledPolicySha256 ?? compiled.plan_sha256 });
  const inventory = vectorInventory(embeddings, Object.values(tables).flatMap((rows) => Array.isArray(rows) ? rows : [])); const staging = { legacy_embedding_inventory: embeddings.map((row, index) => ({ inventory_id: row.id ?? index, source_type: row.source_type, source_id: row.source_id, has_legacy_vector: rowHasVector(row) })) };
  const result = { format_version: FORMAT_VERSION, plan_type: 'relational-staging', migration_id: migrationId ?? compiled.migration_id, bundle_manifest_sha256: bundleManifestSha256 ?? compiled.bundle_manifest_sha256, compiled_policy_sha256: compiledPolicySha256 ?? compiled.plan_sha256, members, staging, legacy_vector_inventory: inventory, coverage, audit: compiled.audit ?? [], losses: compiled.losses ?? [], merge_audit: compiled.merge_audit ?? [], image_inventory: imagePlan, reembed_jobs: reembedPlan, legacy_vectors_imported: false };
  assertNoLegacyVectors(result); result.plan_sha256 = canonicalSha256(result); return result;
}
export async function* streamRelational(input) { const result = transformRelational(input); for (const [table, rows] of Object.entries(result.members)) for (const row of rows) yield { table, row }; }
export const transformAll = transformRelational;
