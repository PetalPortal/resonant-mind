// Column-by-column comparison of what the source held with what the target holds.
//
// This is the strongest evidence the migrator produces, and it is deliberately not derived from the
// transform it checks. The transform decides what each v4 row should be; this module goes back to the
// verified source rows and the live target rows and asks, for every mapped column of every row, whether
// the target holds the source's value. A cell may differ from the source only for a reason the reviewed
// policy records for that exact cell (a remapped id, a normalized timestamp, an enum alias, a reviewed
// choice, a v4 default for a NULL), and each such difference is counted by kind, so the report shows
// what changed and why, never just "matched". Timestamps are compared as exact microsecond instants, not
// as text; ids, JSON, numbers and text follow the same exact-text rules the source adapter read with.
//
// Nothing here prints a value. Findings carry the table, the column, the kind of difference and an
// integer id or a hash of the key, never row content.

import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { parseInstantMicros } from '../lib/instant.mjs';
import { sourceKey } from '../transform/id-map.mjs';
import { KIND_NORMALIZATIONS, SQLITE_UTC, DATE_FIELDS, TIMESTAMP_FIELDS } from '../policy/generate.mjs';
import { ALIASES, CONTEXTS, ENUMS, ENUM_FIELDS } from '../transform/value-map.mjs';
import { TARGET_SCHEMAS } from '../transform/target-schema.mjs';

const MAP = JSON.parse(readFileSync(new URL('../spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
const JSON_FIELDS = new Set(['links', 'connections', 'tags', 'source_observation_ids', 'data', 'sit_notes']);
const FK_COLUMNS = Object.freeze({ entity_id: 'entities', linked_observation_id: 'observations', superseded_by: 'observations', supersedes: 'observations', observation_id: 'observations', consolidated_observation_id: 'observations', obs_a_id: 'observations', obs_b_id: 'observations', from_obs_id: 'observations', to_obs_id: 'observations', from_entity_id: 'entities', to_entity_id: 'entities' });
const ROUTED = new Set(['observations', 'images', 'consolidation_groups']);
const NULL_DEFAULTS = Object.freeze({ salience: 'active', primary_context: 'default' });
const CONTEXT_FIELDS = new Set(['context', 'scope', 'primary_context']);
export const COMPARED_TARGET_TABLES = Object.freeze([...new Set(['entities', ...MAP.flatMap((entry) => entry.target_tables)])].sort());

/** Collects findings with a bounded sample per kind and exact counts, so a report stays readable. */
export class Findings {
  constructor(limit = 25) { this.limit = limit; this.counts = {}; this.samples = []; }
  add(check, details = {}) {
    this.counts[check] = (this.counts[check] ?? 0) + 1;
    if (this.counts[check] <= this.limit) this.samples.push({ check, ...details });
  }
  get total() { return Object.values(this.counts).reduce((sum, value) => sum + value, 0); }
}

function lower(value) { return String(value).toLowerCase(); }
function rowIdOf(row, index) { return row.id ?? row.key ?? index; }
function lookup(table, id) { return sourceKey(table, id); }
function safeId(value) { return Number.isSafeInteger(value) ? { source_id: value } : { key_sha256: canonicalSha256(String(value)) }; }
function choiceAction(choice) { return typeof choice === 'string' ? choice : choice?.action ?? choice?.type ?? choice?.kind ?? choice?.choice; }
function reviewedChoice(decisions, table, rowHash, type, field) {
  return (decisions?.items ?? []).find((item) => item.source_table === table && item.source_row_sha256 === rowHash && item.type === type && (!item.field || item.field === field))?.choice;
}

/**
 * The instant a source timestamp means. An offset in the text, or SQLite's exact UTC form, speaks for
 * itself; a naive value means whatever timezone the reviewer chose for that exact cell.
 */
function sourceInstant(value, { decisions, table, field, rowHash }) {
  if (typeof value !== 'string') throw new Error('not text');
  if (SQLITE_UTC.test(value)) return { micros: parseInstantMicros(value, { naiveOffset: 'UTC' }), how: 'sqlite-utc' };
  try { return { micros: parseInstantMicros(value), how: 'offset' }; } catch (error) {
    if (!/no offset/u.test(error.message)) throw error;
    const choice = reviewedChoice(decisions, table, rowHash, 'timestamp', field);
    if (choiceAction(choice) !== 'normalize-utc') throw new Error('naive timestamp has no reviewed timezone');
    return { micros: parseInstantMicros(value, { naiveOffset: choice.timezone ?? choice.timezone_offset }), how: 'reviewed-timezone' };
  }
}

function sameJson(left, right) {
  try { return canonicalJson(typeof left === 'string' ? JSON.parse(left) : left) === canonicalJson(typeof right === 'string' ? JSON.parse(right) : right); } catch { return false; }
}

/** What the reviewed policy and the v4 vocabulary allow an enum value to become. */
function expectedEnum(column, value, { decisions, table, rowHash }) {
  const text = lower(value);
  if (ENUMS[column]?.has(text)) return { value: text, how: text === value ? null : 'enum-case-folded' };
  if (ALIASES[column]?.[text] !== undefined) return { value: ALIASES[column][text], how: 'enum-alias' };
  const choice = reviewedChoice(decisions, table, rowHash, 'unknown-value', column);
  const mapped = choice?.value ?? choice?.mapped_value ?? choice?.target;
  if (['map', 'map-status', 'map-context'].includes(choiceAction(choice)) && typeof mapped === 'string') return { value: mapped, how: 'enum-reviewed-map' };
  return null;
}
function expectedContext(value, { decisions, table, rowHash, column }) {
  const text = lower(value);
  if (CONTEXTS.has(text)) return { value: text, how: text === value ? null : 'context-case-folded' };
  const choice = reviewedChoice(decisions, table, rowHash, 'unknown-value', column);
  const mapped = choice?.value ?? choice?.mapped_value ?? choice?.target;
  if (choiceAction(choice) === 'map-context' && typeof mapped === 'string') return { value: lower(mapped), how: 'context-reviewed-map' };
  return null;
}

/**
 * Compares the source rows with the target rows.
 *
 *  - sourceTables     table -> rows, exactly as the verified bundle holds them
 *  - targetTables     table -> rows, as the live target holds them (timestamps as RFC 3339 text)
 *  - compiled         the compiled policy recomputed from the bundle and the reviewed decisions
 *  - decisions        the reviewed decision manifest
 *  - importedAt       the import transaction's time in microseconds (what v4's own NOW() defaults give)
 *  - family           'postgres' or 'sqlite'
 */
export function compareSourceToTarget({ sourceTables, targetTables, compiled, decisions, importedAt, family }) {
  const findings = new Findings();
  const sanctioned = {};
  const bump = (kind) => { sanctioned[kind] = (sanctioned[kind] ?? 0) + 1; };
  const tables = {};
  const claimed = Object.fromEntries(COMPARED_TARGET_TABLES.map((table) => [table, new Set()]));
  const index = Object.fromEntries(COMPARED_TARGET_TABLES.map((table) => {
    const byId = new Map();
    for (const row of targetTables[table] ?? []) {
      const key = String(row.id);
      if (byId.has(key)) findings.add('duplicate-target-id', { table, ...safeId(row.id) });
      byId.set(key, row);
    }
    return [table, byId];
  }));
  const excludedRows = new Set(compiled.excluded_rows ?? []);
  const nullLosses = new Set((compiled.losses ?? []).filter((loss) => loss.kind === 'null-replaced-by-v4-default').map((loss) => `${loss.source_row_sha256}:${loss.field}`));
  const nullObserved = new Set();
  const entityTarget = (id) => compiled.id_map?.[lookup('entities', id)];

  // Version numbers, worked out here from the source rows: per observation, ordered by the instant of
  // changed_at and then by integer id. The policy's own numbering is not consulted.
  const versionRows = (sourceTables.observation_versions ?? []).map((row, position) => ({ row, hash: canonicalSha256(row), id: rowIdOf(row, position) }));
  const expectedVersion = new Map();
  {
    const groups = new Map();
    for (const item of versionRows) {
      if (excludedRows.has(`observation_versions:${item.hash}`) || compiled.id_map?.[lookup('observation_versions', item.id)]?.excluded) continue;
      const observation = compiled.id_map?.[lookup('observations', item.row.observation_id)];
      const owner = observation?.target_id ?? item.row.observation_id;
      let micros = null;
      if (item.row.changed_at !== null && item.row.changed_at !== undefined) {
        try { micros = sourceInstant(item.row.changed_at, { decisions, table: 'observation_versions', field: 'changed_at', rowHash: item.hash }).micros; } catch { micros = null; }
      }
      const bucket = groups.get(String(owner)) ?? [];
      bucket.push({ ...item, micros });
      groups.set(String(owner), bucket);
    }
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => (a.micros === b.micros ? 0 : a.micros === null ? -1 : b.micros === null ? 1 : a.micros < b.micros ? -1 : 1) || (Number.isSafeInteger(Number(a.id)) && Number.isSafeInteger(Number(b.id)) ? Number(a.id) - Number(b.id) : String(a.id).localeCompare(String(b.id))));
      bucket.forEach((item, position) => expectedVersion.set(item.hash, position + 1));
    }
  }

  const mappings = MAP.filter((entry) => entry.target_tables.length > 0 && entry.source_families.includes(family) && Array.isArray(sourceTables[entry.source_table]));
  let cells = 0;

  for (const mapping of mappings) {
    const sourceTable = mapping.source_table;
    const summary = { source_rows: 0, compared_rows: 0, excluded_by_review: 0, merged_by_review: 0, cells_compared: 0, target_table: mapping.target_tables.join(',') };
    tables[sourceTable] = summary;
    for (const [position, row] of (sourceTables[sourceTable] ?? []).entries()) {
      summary.source_rows += 1;
      const rowHash = canonicalSha256(row);
      const id = rowIdOf(row, position);
      const idEntry = compiled.id_map?.[lookup(sourceTable, id)];
      const where = { table: sourceTable, ...safeId(id) };
      if (excludedRows.has(`${sourceTable}:${rowHash}`) || idEntry?.excluded) { summary.excluded_by_review += 1; continue; }
      if (idEntry?.merged) { summary.merged_by_review += 1; continue; }
      const targetTableName = sourceTable === 'entities' ? idEntry?.target_table : mapping.target_tables[0];
      if (!targetTableName || !index[targetTableName]) { findings.add('source-row-has-no-target-table', where); continue; }
      const targetId = idEntry?.target_id ?? id;
      const target = index[targetTableName].get(String(targetId));
      if (!target) { findings.add('source-row-missing-in-target', { ...where, target_table: targetTableName }); continue; }
      claimed[targetTableName].add(String(targetId));
      summary.compared_rows += 1;
      if (sourceTable === 'entities') {
        const other = targetTableName === 'people' ? 'nodes' : 'people';
        if (index[other].has(String(targetId))) findings.add('entity-routed-to-both', where);
      }

      const fail = (column, kind) => findings.add('cell-mismatch', { ...where, target_table: targetTableName, column, difference: kind });
      const compareCell = (sc, tc, rawValue, options = {}) => {
        let sv = rawValue;
        const tv = target[tc];
        cells += 1; summary.cells_compared += 1;
        const qualified = `${sourceTable}.${sc}`;
        if (options.expected !== undefined) { // computed by the caller (ids, names, routing)
          if (options.expected === tv || (options.expected !== null && tv !== null && String(options.expected) === String(tv))) { if (options.sanction) bump(options.sanction); return; }
          fail(tc, options.kind ?? 'value'); return;
        }
        if (TIMESTAMP_FIELDS.has(qualified)) {
          if (sv === null || sv === undefined) {
            if (tv === null || tv === undefined) return;
            if (sourceTable === 'entities' && (sc === 'created_at' || sc === 'updated_at') && importedAt !== null) {
              let micros = null; try { micros = parseInstantMicros(tv); } catch { /* fails below */ }
              if (micros === importedAt && nullLosses.has(`${rowHash}:${sc}`)) { nullObserved.add(`${rowHash}:${sc}`); bump('null-replaced-by-v4-default'); return; }
            }
            fail(tc, 'null-became-a-value'); return;
          }
          let expected;
          try { expected = sourceInstant(sv, { decisions, table: sourceTable, field: sc, rowHash }); } catch { fail(tc, 'source-timestamp-unreadable'); return; }
          let actual = null;
          if (typeof tv === 'string') { try { actual = parseInstantMicros(tv); } catch { actual = null; } }
          if (actual !== expected.micros) { fail(tc, 'instant'); return; }
          if (expected.how === 'reviewed-timezone') bump('timestamp-reviewed-timezone');
          else if (tv !== sv) bump('timestamp-reformatted-same-instant');
          return;
        }
        if (DATE_FIELDS.has(qualified)) {
          if (sv === null || sv === undefined) { if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value'); return; }
          const choice = reviewedChoice(decisions, sourceTable, rowHash, 'date', sc);
          const expected = /^\d{4}-\d{2}-\d{2}$/u.test(sv) ? sv : (choiceAction(choice) === 'normalize-date' ? choice.value : null);
          if (expected === null || tv !== expected) fail(tc, 'date'); else if (expected !== sv) bump('date-reviewed-replacement');
          return;
        }
        if (ENUM_FIELDS.has(qualified)) {
          if (sv === null || sv === undefined) { if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value'); return; }
          const expected = expectedEnum(sc, sv, { decisions, table: sourceTable, rowHash });
          if (expected === null || tv !== expected.value) fail(tc, 'enum'); else if (expected.how) bump(expected.how);
          return;
        }
        if (CONTEXT_FIELDS.has(sc)) {
          if (sv === null || sv === undefined) {
            if (sourceTable === 'entities' && sc === 'primary_context' && tv === NULL_DEFAULTS.primary_context && nullLosses.has(`${rowHash}:${sc}`)) { nullObserved.add(`${rowHash}:${sc}`); bump('null-replaced-by-v4-default'); return; }
            if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value');
            return;
          }
          const expected = expectedContext(sv, { decisions, table: sourceTable, rowHash, column: sc });
          if (expected === null || tv !== expected.value) fail(tc, 'context'); else if (expected.how) bump(expected.how);
          return;
        }
        if (sourceTable === 'entities' && sc === 'salience' && (sv === null || sv === undefined)) {
          if (tv === NULL_DEFAULTS.salience && nullLosses.has(`${rowHash}:${sc}`)) { nullObserved.add(`${rowHash}:${sc}`); bump('null-replaced-by-v4-default'); } else fail(tc, 'null-became-a-value');
          return;
        }
        if (JSON_FIELDS.has(sc)) {
          if (sv === null || sv === undefined) { if (tv !== null && tv !== undefined) fail(tc, 'null-became-a-value'); return; }
          let expected = sv;
          let parsed;
          try { parsed = typeof sv === 'string' ? JSON.parse(sv) : sv; } catch { parsed = undefined; }
          if (parsed === undefined) {
            const choice = reviewedChoice(decisions, sourceTable, rowHash, 'malformed-json', sc);
            if (choiceAction(choice) !== 'map-json' || !Object.hasOwn(choice, 'value')) { fail(tc, 'json-unreviewed'); return; }
            expected = choice.value; bump('json-reviewed-replacement');
          }
          if (!sameJson(expected, tv)) fail(tc, 'json'); else if (typeof tv === 'string' && tv !== sv) bump('json-reformatted-same-value');
          return;
        }
        if (sv === tv) return;
        if (typeof sv === 'number' && typeof tv === 'number' && Object.is(sv, tv)) return;
        fail(tc, typeof sv === 'string' ? 'text' : 'value');
      };

      // A reviewed tension decision states resolved_at / resolution itself; those cells are checked against it below.
      const tensionChoice = sourceTable === 'tensions' ? compiled.semantic_choices?.[`tensions:${rowHash}`] : undefined;
      const tensionAction = choiceAction(tensionChoice);
      const reviewedTensionColumns = new Set(tensionAction === 'preserve-visits-and-open' ? ['resolved_at', 'resolution'] : tensionAction === 'preserve-visits-and-resolve' ? [...(tensionChoice.resolved_at !== null && tensionChoice.resolved_at !== undefined ? ['resolved_at'] : []), ...(tensionChoice.resolution !== undefined ? ['resolution'] : [])] : []);
      for (const [sc, tc] of Object.entries(mapping.column_map)) {
        if (!Object.hasOwn(row, sc)) continue;
        if (reviewedTensionColumns.has(sc)) continue;
        const value = row[sc];
        if (sourceTable === 'entities') {
          const override = idEntry?.field_values?.[sc];
          if (sc === 'id') { compareCell(sc, tc, value, { expected: idEntry?.target_id ?? value, kind: 'id' }); continue; }
          if (sc === 'name') { compareCell(sc, tc, value, { expected: idEntry?.target_name ?? value, kind: 'name', sanction: idEntry?.target_name !== undefined && idEntry.target_name !== value ? 'entity-renamed-or-merged-by-review' : undefined }); continue; }
          if (sc === 'entity_type') {
            const derived = KIND_NORMALIZATIONS.get(lower(override ?? value)) ?? (() => { const choice = reviewedChoice(decisions, 'entities', rowHash, 'entity-kind', 'entity_type'); return choice?.kind ?? choice?.value; })();
            if (idEntry?.final_kind !== undefined && !idEntry.merged && idEntry.field_values === undefined && derived !== undefined && derived !== idEntry.final_kind) { findings.add('entity-kind-not-derivable', where); cells += 1; summary.cells_compared += 1; continue; }
            compareCell(sc, tc, value, { expected: idEntry?.final_kind, kind: 'entity-kind' });
            continue;
          }
          if (override !== undefined) { compareCell(sc, tc, override); continue; }
        }
        if (sc === 'source_observation_ids') {
          let ids; try { ids = typeof value === 'string' ? JSON.parse(value) : value; } catch { ids = null; }
          const expectedIds = Array.isArray(ids) ? ids.map((item) => { const entry = compiled.id_map?.[lookup('observations', Number(item))]; return entry === undefined ? Number(item) : entry.excluded ? null : entry.target_id; }).filter((item) => item !== null) : null;
          cells += 1; summary.cells_compared += 1;
          const actual = Array.isArray(target[tc]) ? target[tc].map(Number) : (typeof target[tc] === 'string' ? (() => { try { return JSON.parse(target[tc]).map(Number); } catch { return null; } })() : null);
          if (expectedIds === null || actual === null || canonicalJson(expectedIds) !== canonicalJson(actual)) fail(tc, 'id-list');
          else if (canonicalJson(expectedIds) !== canonicalJson((ids ?? []).map(Number))) bump('id-list-remapped');
          continue;
        }
        if (FK_COLUMNS[sc] !== undefined) {
          let expected;
          const link = compiled.link_map?.[`${sourceTable}:${rowHash}:${sc}`];
          if (link !== undefined) {
            const entry = link === null ? null : compiled.id_map?.[lookup(FK_COLUMNS[sc], link)];
            expected = link === null ? null : (entry?.excluded ? null : entry?.target_id ?? link);
          } else if (value === null || value === undefined) expected = null;
          else { const entry = compiled.id_map?.[lookup(FK_COLUMNS[sc], value)]; expected = entry === undefined ? value : entry.excluded ? null : entry.target_id; }
          compareCell(sc, tc, value, { expected, kind: 'reference', sanction: link !== undefined ? (link === null ? 'reference-nullified-by-review' : 'reference-relinked-by-review') : (expected !== value ? 'reference-remapped' : undefined) });
          continue;
        }
        if (sourceTable === 'relations' && (sc === 'from_entity' || sc === 'to_entity')) {
          const link = compiled.link_map?.[`relations:${rowHash}:${sc}`];
          let expected = value;
          if (link !== undefined) { const entry = compiled.id_map?.[lookup('entities', link)]; expected = entry?.excluded ? null : (entry?.target_name ?? String(value)); }
          else if (value !== null && value !== undefined) { const context = sc === 'from_entity' ? row.from_context : row.to_context; const mapped = compiled.name_map?.[`${context ?? 'default'}:${String(value)}`] ?? compiled.name_map?.[String(value)]; expected = mapped?.target_name ?? String(value); }
          compareCell(sc, tc, value, { expected, kind: 'endpoint-name', sanction: expected !== value ? 'endpoint-renamed-by-review' : undefined });
          continue;
        }
        compareCell(sc, tc, value);
      }

      if (ROUTED.has(sourceTable)) {
        const entityColumn = compiled.link_map?.[`${sourceTable}:${rowHash}:entity_id`];
        const mappedEntity = entityColumn !== undefined ? entityColumn : (row.entity_id === null || row.entity_id === undefined ? null : (compiled.id_map?.[lookup('entities', row.entity_id)]?.target_id ?? row.entity_id));
        const entry = mappedEntity === null ? undefined : compiled.id_map?.[lookup('entities', mappedEntity)];
        const route = entry && !entry.excluded ? (entry.target_table === 'people' ? { person_id: entry.target_id, node_id: null } : { person_id: null, node_id: entry.target_id }) : { person_id: null, node_id: null };
        for (const column of ['person_id', 'node_id']) { cells += 1; summary.cells_compared += 1; if ((target[column] ?? null) !== route[column]) fail(column, 'routing'); }
      }
      if (sourceTable === 'observation_versions') {
        cells += 1; summary.cells_compared += 1;
        if (target.version_num !== expectedVersion.get(rowHash)) fail('version_num', 'version-order');
      }
      if (sourceTable === 'tensions') {
        const choice = compiled.semantic_choices?.[`tensions:${rowHash}`];
        const action = choiceAction(choice);
        const compareExtra = (column, expected, kind = 'value') => { cells += 1; summary.cells_compared += 1; if ((target[column] ?? null) !== expected) fail(column, kind); };
        const instantEquals = (column, text, how) => {
          cells += 1; summary.cells_compared += 1;
          if (text === null || text === undefined) { if (target[column] !== null && target[column] !== undefined) fail(column, 'null-became-a-value'); return; }
          let expected; try { expected = parseInstantMicros(text, { naiveOffset: how?.timezone ?? how?.timezone_offset }); } catch { fail(column, 'reviewed-timestamp-unreadable'); return; }
          let actual = null; try { actual = typeof target[column] === 'string' ? parseInstantMicros(target[column]) : null; } catch { actual = null; }
          if (actual !== expected) fail(column, 'instant'); else bump('tension-state-from-review');
        };
        if (action === 'preserve-visits-and-open') { compareExtra('resolved_at', null); compareExtra('resolution', null); bump('tension-state-from-review'); }
        else if (action === 'preserve-visits-and-resolve') {
          if (choice.resolved_at !== null && choice.resolved_at !== undefined) instantEquals('resolved_at', choice.resolved_at, choice.resolved_at_choice);
          if (choice.resolution !== undefined) compareExtra('resolution', choice.resolution);
        }
        if (choice?.last_visited !== undefined) instantEquals('last_visited', choice.last_visited, choice.last_visited_choice);
        else if (Number(row.sit_count ?? 0) > 0) {
          cells += 1; summary.cells_compared += 1;
          let created = null; try { created = sourceInstant(row.created_at, { decisions, table: 'tensions', field: 'created_at', rowHash }).micros; } catch { created = null; }
          let actual = null; try { actual = typeof target.last_visited === 'string' ? parseInstantMicros(target.last_visited) : null; } catch { actual = null; }
          if (created === null || actual !== created) fail('last_visited', 'instant'); else bump('last-visited-defaulted-to-created-at');
        }
      }
    }
  }

  // Every target row in a compared table must belong to a source row (or be the trigger's routed copy).
  for (const table of COMPARED_TARGET_TABLES) {
    if (table === 'entities') continue; // the compatibility surface is checked against the plan, row for row
    const total = index[table].size;
    if (claimed[table].size !== total) {
      for (const [key, row] of index[table]) if (!claimed[table].has(key)) findings.add('target-row-without-source', { table, ...safeId(row.id) });
    }
  }
  // A recorded 'null-replaced-by-v4-default' loss must be visible in the target, and the other way round.
  for (const key of nullLosses) if (!nullObserved.has(key)) findings.add('recorded-default-not-observed', { key_sha256: canonicalSha256(key) });
  return { findings, sanctioned, tables, cells_compared: cells };
}

/**
 * The plan the target was imported from, against the rows the target holds. Every column the plan row
 * states is compared by its v4 column type; a plan NULL in a column v4's routing trigger fills in must be
 * exactly that default. Rows may not be missing, extra or duplicated.
 */
export function comparePlanToTarget({ plan, targetTables, columnTypes = {}, importedAt }) {
  const findings = new Findings();
  const tables = {};
  let cells = 0;
  for (const table of COMPARED_TARGET_TABLES) {
    const expectedRows = plan.members?.[table] ?? [];
    const actualRows = targetTables[table] ?? [];
    const schema = TARGET_SCHEMAS[table];
    const summary = { plan_rows: expectedRows.length, target_rows: actualRows.length, cells_compared: 0 };
    tables[table] = summary;
    if (!schema) { findings.add('plan-table-unknown', { table }); continue; }
    const byId = new Map();
    for (const row of actualRows) { if (byId.has(String(row.id))) findings.add('duplicate-target-id', { table, ...safeId(row.id) }); byId.set(String(row.id), row); }
    const seen = new Set();
    for (const planned of expectedRows) {
      const key = String(planned.id);
      if (seen.has(key)) findings.add('duplicate-plan-id', { table, ...safeId(planned.id) });
      seen.add(key);
      const actual = byId.get(key);
      if (!actual) { findings.add('plan-row-missing-in-target', { table, ...safeId(planned.id) }); continue; }
      for (const [column, value] of Object.entries(planned)) {
        const type = schema.columns[column];
        const dbValue = actual[column];
        cells += 1; summary.cells_compared += 1;
        const mismatch = (kind) => findings.add('plan-cell-mismatch', { table, ...safeId(planned.id), column, difference: kind });
        if (value === undefined) continue;
        if (value === null) {
          const routed = (table === 'people' || table === 'nodes');
          if (routed && (column === 'created_at' || column === 'updated_at')) {
            let micros = null; try { micros = parseInstantMicros(dbValue); } catch { micros = null; }
            if (importedAt === null || micros !== importedAt) mismatch('default-not-import-time');
          } else if (routed && column in NULL_DEFAULTS) { if (dbValue !== NULL_DEFAULTS[column]) mismatch('default'); }
          else if (dbValue !== null && dbValue !== undefined) mismatch('null-became-a-value');
          continue;
        }
        if (type === 'timestamptz') {
          let expected = null; let actualMicros = null;
          try { expected = parseInstantMicros(value); actualMicros = typeof dbValue === 'string' ? parseInstantMicros(dbValue) : null; } catch { /* fails below */ }
          if (expected === null || actualMicros !== expected) mismatch('instant');
        } else if (type === 'integer') { if (String(value) !== String(dbValue)) mismatch('integer'); }
        else if (type === 'double' || type === 'real') { if (!(typeof dbValue === 'number' && Object.is(value, dbValue))) mismatch('number'); }
        else if (type === 'boolean') { if (value !== dbValue) mismatch('boolean'); }
        else if (type === 'integer_array') { if (!Array.isArray(dbValue) || canonicalJson(value.map(Number)) !== canonicalJson(dbValue.map(Number))) mismatch('id-list'); }
        else if (type === 'date') { if (value !== dbValue) mismatch('date'); }
        else if (type === 'jsonb' || /^jsonb?$/u.test(columnTypes[table]?.[column] ?? '')) { if (!sameJson(value, dbValue)) mismatch('json'); }
        else if (value !== dbValue) mismatch('text');
      }
    }
    for (const [key, row] of byId) if (!seen.has(key)) findings.add('target-row-not-in-plan', { table, ...safeId(row.id) });
  }
  return { findings, tables, cells_compared: cells };
}
