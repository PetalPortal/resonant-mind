import { canonicalSha256 } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { extractBundleRows, bundleHash, generateDecisionItems, choiceForItem } from './generate.mjs';
import { validateDecisionManifest } from './validate.mjs';
import { buildIdMaps } from '../transform/id-map.mjs';
import { buildValueMaps } from '../transform/value-map.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { readFileSync } from 'node:fs';

const MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
function refuse(summary, details = {}, code = 'RMIG-E-POLICY-UNRESOLVED') { throw new MigrationRefusal({ code, phase: 'compile-policy', summary, safe_details: details, report_path: null }); }
function rowsOf(bundle) { return extractBundleRows(bundle); }
function choiceAction(choice) { return typeof choice === 'string' ? choice : choice?.action ?? choice?.type ?? choice?.kind ?? choice?.choice; }
function decisionFor(policy, item) { return choiceForItem(policy, item); }
function itemFor(items, table, row, type, field) { const hash = canonicalSha256(row); return items.find((item) => item.source_table === table && item.source_row_sha256 === hash && item.type === type && (!field || item.field === field)); }
function mapChoice(policy, items, table, row, type, field) { const item = itemFor(items, table, row, type, field); return item ? decisionFor(policy, item) : undefined; }
function idFor(idMaps, table, value) { if (value === null || value === undefined) return value ?? null; const entry = idMaps.byKey.get(`${table}:${canonicalJson(value).trim()}`); if (!entry) return value; if (entry.excluded) return null; return entry.target_id; }
function validatePolicyInput(bundle, decisions) {
  const hash = bundleHash(bundle);
  const expected = generateDecisionItems(bundle);
  try { validateDecisionManifest(decisions, { bundleManifestSha256: hash, expectedItems: expected }); }
  catch (error) { refuse(error.message, { bundle_manifest_sha256: hash }, /stale|source row|missing or extra decisions/iu.test(error.message) ? 'RMIG-E-POLICY-MISMATCH' : 'RMIG-E-POLICY-UNRESOLVED'); }
  if (!decisions.reviewed) refuse('A reviewed decision manifest is required; unresolved policy choices are not accepted.');
  for (const item of expected) if (choiceForItem(decisions, item) === undefined) refuse('Every generated ambiguity must have an explicit reviewed choice.', { decision_id: item.decision_id });
}
function collectCoverage(tables) {
  const coverage = {};
  for (const mapping of MAP) coverage[mapping.source_table] = { source_rows: (tables[mapping.source_table] ?? []).length, mapped_rows: 0, excluded_rows: 0, losses: 0, target_tables: mapping.target_tables };
  return coverage;
}
function sortedEntries(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }

export function compilePolicy({ bundle, decisions, migrationId, bundleManifestSha256 } = {}) {
  if (!bundle || !decisions) throw new TypeError('compilePolicy requires verified bundle data and decisions.');
  const actualHash = bundleHash(bundle);
  if (bundleManifestSha256 !== undefined && bundleManifestSha256 !== actualHash) refuse('The supplied bundle hash does not match the verified bundle.');
  validatePolicyInput(bundle, decisions);
  const tables = rowsOf(bundle);
  const mappedTables = new Set(MAP.map((mapping) => mapping.source_table));
  const extraTables = Object.keys(tables).filter((table) => !mappedTables.has(table));
  if (extraTables.length > 0) refuse('Verified bundle contains a source table without a mapping specification.', { tables: extraTables.sort() });
  const idMaps = buildIdMaps(tables, decisions);
  const valueMaps = buildValueMaps({ tables, policy: decisions });
  if (valueMaps.losses.some((loss) => String(loss.kind).startsWith('unresolved-'))) refuse('Reviewed policy choices did not resolve every semantic value.', { unresolved: valueMaps.losses.map(({ source_table, source_row_sha256, field, kind }) => ({ source_table, source_row_sha256, field, kind })) });
  const losses = [...valueMaps.losses];
  const audit = [];
  const coverage = collectCoverage(tables);
  const linkMap = {};
  const excludedRows = new Set();
  const versionNumbers = {};
  const semanticChoices = {};
  for (const item of generateDecisionItems(bundle)) {
    const choice = choiceForItem(decisions, item); const action = choiceAction(choice);
    const rowKey = `${item.source_table}:${item.source_row_sha256}`;
    if (item.type === 'tension-state' || item.type === 'dormancy-translation') semanticChoices[rowKey] = choice;
    if (action === 'exclude-row') excludedRows.add(rowKey);
    if (item.type === 'broken-foreign-key' || item.type === 'broken-name-reference' || item.type === 'ambiguous-name-reference') {
      const selected = choice?.action === 'link-by-reviewed-id' ? choice.target_id : action === 'null-if-allowed' ? null : undefined;
      if (selected !== undefined) linkMap[`${rowKey}:${item.field}`] = selected;
    }
  }
  const versions = (tables.observation_versions ?? []).map((row, index) => ({ row, hash: canonicalSha256(row), observationId: row.observation_id, changedAt: valueMaps.timestamps[`observation_versions:${canonicalSha256(row)}:changed_at`] ?? row.changed_at ?? null, id: row.id ?? index })).sort((a, b) => String(a.observationId).localeCompare(String(b.observationId)) || (a.changedAt === null ? -1 : b.changedAt === null ? 1 : String(a.changedAt).localeCompare(String(b.changedAt))) || String(a.id).localeCompare(String(b.id)));
  let previousObservation = null; let version = 0;
  for (const entry of versions) { if (String(entry.observationId) !== String(previousObservation)) { previousObservation = entry.observationId; version = 0; } version += 1; versionNumbers[entry.hash] = version; }
  for (const mapping of MAP) {
    const rows = tables[mapping.source_table] ?? [];
    for (const row of rows) {
      const rowHash = canonicalSha256(row);
      if (excludedRows.has(`${mapping.source_table}:${rowHash}`)) { coverage[mapping.source_table].excluded_rows += 1; losses.push({ kind: 'excluded-row', source_table: mapping.source_table, source_row_sha256: rowHash, rationale: 'explicit reviewed policy choice excluded this row' }); continue; }
      const idEntry = idMaps.byKey.get(`${mapping.source_table}:${canonicalJson(row.id ?? row.key ?? rows.indexOf(row)).trim()}`);
      if (idEntry?.excluded) { coverage[mapping.source_table].excluded_rows += 1; continue; }
      if (idEntry?.merged) {
        coverage[mapping.source_table].excluded_rows += 1;
        losses.push({ kind: 'merged-source-row', source_table: mapping.source_table, source_row_sha256: rowHash, target_id: idEntry.target_id, rationale: 'source row is represented by the reviewed merge survivor' });
        continue;
      }
      coverage[mapping.source_table].mapped_rows += 1;
      for (const dropped of mapping.dropped_fields ?? []) if (row[dropped.field] !== null && row[dropped.field] !== undefined) {
        losses.push({ kind: 'dropped-field', source_table: mapping.source_table, source_row_sha256: rowHash, field: dropped.field, rationale: dropped.rationale });
      }
      if (mapping.source_table === 'embeddings' && row.embedding !== null && row.embedding !== undefined) losses.push({ kind: 'legacy-vector-inventory-only', source_table: mapping.source_table, source_row_sha256: rowHash, field: 'embedding', rationale: 'legacy vectors are never copied into v4' });
      audit.push({ source_table: mapping.source_table, source_row_sha256: rowHash, target_tables: mapping.target_tables, status: idEntry?.excluded ? 'excluded' : 'mapped' });
    }
  }
  if (losses.some((loss) => !loss.source_row_sha256)) refuse('Every loss entry must cite a source row hash.');
  losses.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))); audit.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

  const lossCounts = Object.fromEntries(Object.keys(coverage).map((table) => [table, losses.filter((loss) => loss.source_table === table).length]));
  for (const [table, count] of Object.entries(lossCounts)) coverage[table].losses = count;
  const plan = {
    format_version: FORMAT_VERSION,
    plan_type: 'deterministic-v3-to-v4-policy',
    migration_id: migrationId ?? bundle.migration_id,
    bundle_manifest_sha256: actualHash,
    decision_manifest_sha256: decisions.manifest_sha256,
    id_map: sortedEntries(Object.fromEntries(Object.entries(idMaps.idMap).sort(([a], [b]) => a.localeCompare(b)))),
    name_map: idMaps.serializedNames,
    value_map: valueMaps,
    link_map: sortedEntries(linkMap),
    excluded_rows: [...excludedRows].sort(),
    version_numbers: sortedEntries(versionNumbers),
    semantic_choices: sortedEntries(semanticChoices),
    losses,
    audit,
    coverage,
    mapping_tables: MAP.map((mapping) => mapping.source_table),
  };
  plan.plan_sha256 = canonicalSha256(plan);
  return plan;
}
export const compile = compilePolicy;
export const compileDeterministicPolicy = compilePolicy;
