import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { extractBundleRows, choiceForItem, generateDecisionItems } from '../policy/generate.mjs';

function scalar(value) { return value === null || value === undefined ? null : value; }
function key(table, id) { return `${table}:${canonicalJson(scalar(id)).trim()}`; }
function rowsOf(input) { return input?.tables ?? input?.rows ?? input?.data ?? input ?? {}; }
function idOf(row, index) { return Object.hasOwn(row, 'id') ? row.id : Object.hasOwn(row, 'key') ? row.key : index; }
function choiceAction(choice) { return typeof choice === 'string' ? choice : choice?.action ?? choice?.type ?? choice?.kind ?? choice?.choice; }
function decisionFor(policy, item) { return choiceForItem(policy, item); }
function stableRows(tables) { return Object.entries(tables).flatMap(([table, rows]) => (Array.isArray(rows) ? rows.map((row, index) => ({ table, row, index })) : [])).sort((a, b) => a.table.localeCompare(b.table) || String(idOf(a.row, a.index)).localeCompare(String(idOf(b.row, b.index)))); }

export function buildIdMaps(input, policy = input?.policy ?? input?.decisions) {
  const tables = rowsOf(input);
  const entries = [];
  const byKey = new Map();
  const nameMap = new Map();
  const excluded = new Set();
  const entityItems = (policy?.items ?? []).filter((item) => item.type === 'duplicate-entity-name');
  const entityChoices = new Map();
  for (const item of entityItems) {
    const choice = decisionFor(policy, item);
    const action = choiceAction(choice);
    if (action === 'merge' && Array.isArray(choice.merged_ids)) for (const id of choice.merged_ids) entityChoices.set(String(id), choice);
    if (action === 'rename' && choice.names && typeof choice.names === 'object') for (const [id, name] of Object.entries(choice.names)) entityChoices.set(String(id), choice);
    if (action === 'exclude-row') for (const id of item.collision_ids ?? []) excluded.add(key('entities', id));
  }
  for (const { table, row, index } of stableRows(tables)) {
    const sourceId = idOf(row, index);
    const sourceKey = key(table, sourceId);
    let targetId = scalar(sourceId);
    let targetTable = table;
    let targetName;
    let excludedRow = excluded.has(sourceKey);
    let merged = false;
    if (table === 'entities') {
      const choice = entityChoices.get(String(sourceId));
      const action = choiceAction(choice);
      if (action === 'merge') {
        targetId = scalar(choice.survivor_id);
        const survivor = (tables.entities ?? []).find((candidate) => String(candidate.id) === String(choice.survivor_id));
        targetTable = choice.target_table ?? (['person', 'human', 'kin'].includes(String(survivor?.entity_type ?? '').toLowerCase()) ? 'people' : 'nodes');
        merged = String(sourceId) !== String(choice.survivor_id);
      } else if (action === 'rename') {
        targetName = choice.names?.[String(sourceId)] ?? choice.name;
        if (typeof targetName !== 'string' || targetName.length === 0) throw new TypeError('Renamed entities require a name for every source ID.');
      } else if (action === 'exclude-row') excludedRow = true;
      else targetTable = ['person', 'human', 'kin'].includes(String(row.entity_type ?? '').toLowerCase()) ? 'people' : 'nodes';
    }
    const entry = { source_table: table, source_id: sourceId, source_key: sourceKey, target_table: targetTable, target_id: targetId, excluded: excludedRow, merged };
    if (table === 'entities') entry.target_name = targetName ?? row.name;
    entries.push(entry); byKey.set(sourceKey, entry);
    if (table === 'entities' && typeof row.name === 'string' && !excludedRow) {
      nameMap.set(`${row.primary_context ?? 'default'}:${row.name}`, { target_id: targetId, target_table: targetTable });
      nameMap.set(row.name, { target_id: targetId, target_table: targetTable });
    }
  }
  const targetKeys = new Map();
  for (const entry of entries) if (!entry.excluded) {
    const unique = `${entry.target_table}:${canonicalJson(entry.target_id).trim()}`;
    const prior = targetKeys.get(unique);
    if (prior && prior.source_key !== entry.source_key) {
      const merged = entries.filter((candidate) => candidate.source_table === 'entities' && candidate.target_table === entry.target_table && candidate.target_id === entry.target_id).every((candidate) => candidate.excluded === false);
      if (!merged) throw new TypeError(`Target ID collision between ${prior.source_key} and ${entry.source_key}.`);
    }
    targetKeys.set(unique, entry);
  }
  entries.sort((a, b) => a.source_key.localeCompare(b.source_key));
  const idMap = {};
  for (const entry of entries) {
    idMap[entry.source_key] = { target_table: entry.target_table, target_id: entry.target_id, excluded: entry.excluded, merged: entry.merged, ...(entry.target_name === undefined ? {} : { target_name: entry.target_name }) };
  }
  const serializedNames = Object.fromEntries([...nameMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const uniqueNames = new Map();
  for (const entry of entries) if (entry.source_table === 'entities' && !entry.excluded) {
    const name = entry.target_name;
    const prior = uniqueNames.get(name);
    if (prior && prior.target_id !== entry.target_id) throw new TypeError(`Target entity name collision for ${name}.`);
    uniqueNames.set(name, entry);
  }
  return { entries, idMap, byKey, nameMap, serializedNames, excluded: [...excluded].sort(), hash: canonicalSha256({ entries, names: serializedNames, excluded: [...excluded].sort() }) };
}
export const compileIdMap = buildIdMaps;
export function mapId(idMaps, sourceTable, sourceId) {
  const entry = idMaps?.byKey?.get(key(sourceTable, sourceId)) ?? idMaps?.idMap?.[key(sourceTable, sourceId)];
  if (!entry) return { found: false, target_id: null, excluded: false };
  return { found: true, ...entry };
}
export function sourceKey(table, id) { return key(table, id); }
export { choiceAction };
