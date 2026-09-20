import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { KIND_NORMALIZATIONS, ISO_WITH_OFFSET, SQLITE_UTC, choiceForItem } from '../policy/generate.mjs';
import { choiceAction } from './id-map.mjs';

const ENUMS = {
  status: new Set(['pending', 'open', 'active', 'resolved', 'closed', 'accepted', 'rejected', 'dismissed', 'deferred', 'cancelled', 'canceled']),
  salience: new Set(['active', 'dormant', 'archived', 'low', 'medium', 'high']),
  certainty: new Set(['believed', 'certain', 'uncertain', 'speculative', 'unknown']),
  weight: new Set(['low', 'medium', 'high']),
};
const CONTEXTS = new Set(['default', 'primary', 'private', 'public', 'personal', 'relationship', 'work', 'inner', 'dream', 'archive', 'archived', 'system', 'global']);
function action(choice) { return choiceAction(choice); }
function missing(value) { return value === null || value === undefined || value === ''; }
function policyChoice(policy, row, table, type, field) {
  const rowHash = canonicalSha256(row);
  return (policy?.items ?? []).find((item) => item.source_table === table && item.source_row_sha256 === rowHash && item.type === type && (!item.field || item.field === field));
}
export function normalizeTimestamp(value, { choice, table, field } = {}) {
  if (missing(value)) return value ?? null;
  if (typeof value !== 'string') throw new Error(`Timestamp ${table ?? 'row'}.${field ?? 'value'} requires a reviewed choice.`);
  if (ISO_WITH_OFFSET.test(value)) {
    const date = new Date(value); if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (SQLITE_UTC.test(value)) {
    const date = new Date(`${value.replace(' ', 'T')}Z`); if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (action(choice?.choice ?? choice) !== 'normalize-utc') throw new Error(`Timestamp ${table ?? 'row'}.${field ?? 'value'} is ambiguous.`);
  const details = choice.choice ?? choice;
  const timezone = details?.timezone ?? details?.timezone_offset;
  if (typeof timezone !== 'string' || !/^(?:UTC|Z|[+-]\d{2}:?\d{2})$/u.test(timezone)) throw new Error('Naive timestamps require an explicit reviewed timezone.');
  const candidate = `${value}${timezone === 'UTC' || timezone === 'Z' ? 'Z' : timezone}`;
  const date = new Date(candidate); if (Number.isNaN(date.valueOf())) throw new Error('Reviewed timestamp choice does not produce a valid timestamp.');
  return date.toISOString();
}
export function normalizeJson(value, expectedShape, { choice } = {}) {
  if (missing(value)) return value ?? null;
  if (typeof value !== 'string') throw new Error('JSON value is not text.');
  let parsed;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  const valid = expectedShape === 'array' ? Array.isArray(parsed) : expectedShape === 'object' ? parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) : Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object');
  if (valid) return parsed;
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'map-json' || !Object.hasOwn(selected, 'value')) throw new Error('Malformed JSON requires a reviewed shape-preserving choice.');
  const mapped = selected.value;
  const mappedValid = expectedShape === 'array' ? Array.isArray(mapped) : expectedShape === 'object' ? mapped !== null && typeof mapped === 'object' && !Array.isArray(mapped) : true;
  if (!mappedValid) throw new Error('Reviewed JSON choice has the wrong shape.');
  return mapped;
}
export function normalizeEnum(value, field, { choice } = {}) {
  if (missing(value)) return value ?? null;
  const normalized = String(value).toLowerCase();
  if (ENUMS[field]?.has(normalized)) return normalized;
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'map' && action(selected) !== 'map-status' && action(selected) !== 'map-context') throw new Error(`Unknown ${field} value requires a reviewed mapping.`);
  const mapped = selected.value ?? selected.mapped_value ?? selected.target;
  if (typeof mapped !== 'string' || (ENUMS[field] && !ENUMS[field].has(mapped))) throw new Error(`Reviewed mapping for ${field} is unsupported.`);
  return mapped;
}
export function normalizeEntityKind(value, { choice } = {}) {
  if (missing(value)) return value ?? null;
  const normalized = String(value).toLowerCase();
  if (KIND_NORMALIZATIONS.has(normalized)) return KIND_NORMALIZATIONS.get(normalized);
  const selected = choice?.choice ?? choice;
  const selectedAction = action(selected);
  if (selectedAction === 'map-to-person') return 'person';
  if (selectedAction === 'map-to-node') return 'node';
  throw new Error('Unknown entity kind requires a reviewed mapping.');
}
export function normalizeContext(value, { choice } = {}) {
  if (missing(value)) return value ?? null;
  const normalized = String(value).toLowerCase();
  if (CONTEXTS.has(normalized)) return normalized;
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'map-context') throw new Error('Unknown context requires a reviewed mapping.');
  const mapped = selected.value ?? selected.mapped_value ?? selected.target;
  if (typeof mapped !== 'string' || !CONTEXTS.has(mapped.toLowerCase())) throw new Error('Reviewed context mapping is unsupported.');
  return mapped.toLowerCase();
}
export function buildValueMaps({ tables = {}, policy } = {}) {
  const output = { timestamps: {}, enums: {}, contexts: {}, json: {}, entity_kinds: {} };
  const losses = [];
  for (const [table, rows] of Object.entries(tables)) for (const row of rows ?? []) {
    const rowHash = canonicalSha256(row);
    for (const [field, value] of Object.entries(row)) {
      if (/(?:^|_)(?:at|date|timestamp|time|marked|surfaced|accessed|resolved|created|updated|changed|added)(?:$|_)/iu.test(field) && value !== null && value !== undefined) {
        const item = policyChoice(policy, row, table, 'timestamp', field);
        try { output.timestamps[`${table}:${rowHash}:${field}`] = normalizeTimestamp(value, { choice: item, table, field }); } catch (error) { losses.push({ kind: 'unresolved-timestamp', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); }
      }
      if (['status', 'salience', 'certainty', 'weight'].includes(field) && value !== null && value !== undefined) {
        const item = policyChoice(policy, row, table, 'unknown-value', field);
        try { output.enums[`${table}:${rowHash}:${field}`] = normalizeEnum(value, field, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-enum', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); }
      }
      if (['context', 'scope', 'primary_context'].includes(field) && value !== null && value !== undefined) {
        const item = policyChoice(policy, row, table, 'unknown-value', field);
        try { output.contexts[`${table}:${rowHash}:${field}`] = normalizeContext(value, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-context', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); }
      }
      if (['links', 'connections', 'tags', 'source_observation_ids', 'data', 'sit_notes'].includes(field) && value !== null && value !== undefined) {
        const item = policyChoice(policy, row, table, 'malformed-json', field);
        try { output.json[`${table}:${rowHash}:${field}`] = normalizeJson(value, field === 'data' ? 'object' : field === 'sit_notes' ? 'array-or-object' : 'array', { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-json', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); }
      }
    }
    if (table === 'entities') {
      const field = 'entity_type'; const value = row[field] ?? row.kind;
      if (value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'entity-kind', field); try { output.entity_kinds[`${table}:${rowHash}`] = normalizeEntityKind(value, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-entity-kind', source_table: table, source_row_sha256: rowHash, reason: error.message }); } }
    }
  }
  losses.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return { ...output, losses, hash: canonicalSha256({ ...output, losses }) };
}
export const compileValueMap = buildValueMaps;
export { ENUMS };
