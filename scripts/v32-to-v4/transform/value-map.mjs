import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { KIND_NORMALIZATIONS, ISO_WITH_OFFSET, SQLITE_UTC, choiceForItem } from '../policy/generate.mjs';
import { choiceAction } from './id-map.mjs';

const ENUMS = {
  status: new Set(['active', 'resolved']),
  salience: new Set(['active', 'high', 'background', 'foundational', 'medium', 'heavy']),
  certainty: new Set(['believed', 'known', 'tentative']),
  weight: new Set(['light', 'medium', 'heavy']),
  charge: new Set(['fresh', 'active', 'processing', 'metabolized']),
  source: new Set(['conversation', 'realization', 'external', 'consolidated', 'inferred', 'journal']),
  thread_type: new Set(['intention', 'task', 'handoff', 'explore', 'idea', 'project', 'creative', 'relational']),
  priority: new Set(['low', 'medium', 'high', 'urgent', 'critical']),
  intensity: new Set(['whisper', 'present', 'strong', 'overwhelming']),
};
const ALIASES = {
  weight: { low:'light', high:'heavy' }, certainty: { certain:'known', uncertain:'tentative', speculative:'tentative' }, charge: { dormant:'metabolized', archived:'metabolized' },
  status: { pending:'active', open:'active', closed:'resolved' }, intensity: { high:'strong' },
  thread_type: { 'urgent-task':'task', build:'task', maintenance:'task', pickup:'task', deadline:'task', morning_handoff:'handoff', 'morning-handoff':'handoff', question:'explore', research:'explore', project_seed:'idea', work:'project', infrastructure:'project', anniversary:'relational', personal:'relational' },
};
const CONTEXTS = new Set(['default', 'primary', 'private', 'public', 'personal', 'relationship', 'work', 'inner', 'dream', 'archive', 'archived', 'system', 'global', 'emotional-processing', 'interests-curiosities', 'creative-space', 'relational-models', 'episodic', 'values-ethics', 'research']);
const TIMESTAMP_FIELDS = new Set(['entities.created_at','entities.updated_at','observations.added_at','observations.last_surfaced_at','observations.resolved_at','observations.valid_from','observations.valid_until','observation_versions.changed_at','relations.created_at','threads.created_at','threads.updated_at','threads.resolved_at','context_entries.updated_at','relational_state.timestamp','identity.timestamp','journals.created_at','consolidation_groups.created_at','images.created_at','images.last_accessed_at','images.last_surfaced_at','images.archived_at','subconscious.updated_at','daemon_proposals.proposed_at','daemon_proposals.resolved_at','tensions.created_at','tensions.resolved_at','dormant_observations.first_marked','dormant_observations.last_rescue_attempt','co_surfacing.first_co_surfaced','co_surfacing.last_co_surfaced']);
const DATE_FIELDS = new Set(['observations.source_date']);
const ENUM_FIELDS = new Set(['observations.salience', 'observations.weight', 'observations.certainty', 'observations.charge', 'observations.source', 'threads.thread_type', 'threads.status', 'threads.priority', 'relational_state.intensity']);
function action(choice) { return choiceAction(choice); }
function missing(value) { return value === null || value === undefined || value === ''; }
function policyChoice(policy, row, table, type, field) { const rowHash = canonicalSha256(row); return (policy?.items ?? []).find((item) => item.source_table === table && item.source_row_sha256 === rowHash && item.type === type && (!item.field || item.field === field)); }
// A JavaScript Date counts milliseconds, PostgreSQL timestamptz counts microseconds, and the v4
// columns are timestamptz. toISOString() alone would drop the last three digits of a v3.2 value such
// as 2026-01-02T03:04:05.987654Z, which changes the stored instant. The digits the source text had
// are kept (up to six); a value with three or fewer significant digits keeps the usual
// toISOString() form, so SQLite and millisecond sources are unchanged. Finer than a microsecond
// cannot come from PostgreSQL and is refused rather than rounded.
function utcIso(date, text) {
  const iso = date.toISOString();
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/u.exec(text)?.[1] ?? '';
  if (fraction.length <= 3) return iso;
  if (/[1-9]/u.test(fraction.slice(6))) throw new Error('Timestamp has more than microsecond precision and would be rounded.');
  const micro = fraction.slice(0, 6).padEnd(6, '0');
  return micro.endsWith('000') ? iso : `${iso.slice(0, 19)}.${micro}Z`;
}
export function normalizeTimestamp(value, { choice, table, field } = {}) {
  if (missing(value)) return value ?? null;
  if (typeof value !== 'string') throw new Error(`Timestamp ${table ?? 'row'}.${field ?? 'value'} requires a reviewed choice.`);
  if (ISO_WITH_OFFSET.test(value)) { const date = new Date(value); if (!Number.isNaN(date.valueOf())) return utcIso(date, value); }
  if (SQLITE_UTC.test(value)) { const date = new Date(`${value.replace(' ', 'T')}Z`); if (!Number.isNaN(date.valueOf())) return utcIso(date, value); }
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'normalize-utc') throw new Error(`Timestamp ${table ?? 'row'}.${field ?? 'value'} is ambiguous.`);
  const timezone = selected?.timezone ?? selected?.timezone_offset;
  if (typeof timezone !== 'string' || !/^(?:UTC|Z|[+-]\d{2}:?\d{2})$/u.test(timezone)) throw new Error('Naive timestamps require an explicit reviewed timezone.');
  const date = new Date(`${value}${timezone === 'UTC' || timezone === 'Z' ? 'Z' : timezone}`); if (Number.isNaN(date.valueOf())) throw new Error('Reviewed timestamp choice does not produce a valid timestamp.');
  return utcIso(date, value);
}
export function normalizeDate(value, { choice, table, field } = {}) {
  if (missing(value)) return value ?? null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`); if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value) return value;
  }
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'normalize-date') throw new Error(`Date ${table ?? 'row'}.${field ?? 'value'} is ambiguous.`);
  if (typeof selected.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(selected.value)) throw new Error('Reviewed date choice must provide an ISO date.');
  return normalizeDate(selected.value, { table, field });
}
export function normalizeJson(value, expectedShape, { choice } = {}) {
  if (missing(value)) return value ?? null;
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = undefined; } }
  const valid = expectedShape === 'array' ? Array.isArray(parsed) : expectedShape === 'integer-array' ? Array.isArray(parsed) && parsed.every((item) => Number.isSafeInteger(typeof item === 'number' ? item : Number(item))) : expectedShape === 'object' ? parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) : Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object');
  if (valid) return parsed;
  const selected = choice?.choice ?? choice;
  if (action(selected) !== 'map-json' || !Object.hasOwn(selected, 'value')) throw new Error('Malformed JSON requires a reviewed shape-preserving choice.');
  const mapped = selected.value; const mappedValid = expectedShape === 'array' ? Array.isArray(mapped) : expectedShape === 'integer-array' ? Array.isArray(mapped) && mapped.every((item) => Number.isSafeInteger(typeof item === 'number' ? item : Number(item))) : expectedShape === 'object' ? mapped !== null && typeof mapped === 'object' && !Array.isArray(mapped) : true;
  if (!mappedValid) throw new Error('Reviewed JSON choice has the wrong shape.');
  return mapped;
}
export function normalizeEnum(value, field, { choice } = {}) {
  if (missing(value)) return value ?? null;
  const normalized = String(value).toLowerCase();
  if (ENUMS[field]?.has(normalized)) return normalized;
  if (ALIASES[field]?.[normalized] !== undefined) return ALIASES[field][normalized];
  const selected = choice?.choice ?? choice; const selectedAction = action(selected);
  if (selectedAction !== 'map' && selectedAction !== 'map-status' && selectedAction !== 'map-context') throw new Error(`Unknown ${field} value requires a reviewed mapping.`);
  const mapped = selected.value ?? selected.mapped_value ?? selected.target;
  if (typeof mapped !== 'string' || (ENUMS[field] && !ENUMS[field].has(mapped))) throw new Error(`Reviewed mapping for ${field} is unsupported.`);
  return mapped;
}
export function normalizeEntityKind(value, { choice } = {}) {
  if (missing(value)) return value ?? null;
  const normalized = KIND_NORMALIZATIONS.get(String(value).toLowerCase());
  if (normalized) return normalized;
  const selected = choice?.choice ?? choice; const selectedAction = action(selected); const mapped = selected?.kind ?? selected?.value ?? selected?.mapped_value;
  if (selectedAction === 'map-to-person' && ['self', 'person', 'peer_ai'].includes(String(mapped).toLowerCase())) return String(mapped).toLowerCase();
  if (selectedAction === 'map-to-node' && ['concept', 'project', 'infrastructure', 'artifact', 'moment', 'session_log', 'practice', 'research', 'journal', 'community', 'emotional_pattern', 'relationship', 'self', 'place', 'object'].includes(String(mapped).toLowerCase())) return String(mapped).toLowerCase();
  throw new Error('Unknown entity kind requires a reviewed final kind allowed by v4 checks.');
}
export function normalizeContext(value, { choice } = {}) {
  if (missing(value)) return value ?? null;
  const normalized = String(value).toLowerCase(); if (CONTEXTS.has(normalized)) return normalized;
  const selected = choice?.choice ?? choice; if (action(selected) !== 'map-context') throw new Error('Unknown context requires a reviewed mapping.');
  const mapped = selected.value ?? selected.mapped_value ?? selected.target;
  if (typeof mapped !== 'string' || !CONTEXTS.has(mapped.toLowerCase())) throw new Error('Reviewed context mapping is unsupported.');
  return mapped.toLowerCase();
}
export function buildValueMaps({ tables = {}, policy, skipRows = new Set() } = {}) {
  const output = { timestamps: {}, dates: {}, enums: {}, contexts: {}, json: {}, entity_kinds: {} }; const losses = [];
  for (const [table, rows] of Object.entries(tables)) for (const row of rows ?? []) {
    const rowHash = canonicalSha256(row); if (skipRows.has(`${table}:${rowHash}`)) continue;
    for (const [field, value] of Object.entries(row)) {
      if (DATE_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'date', field); try { output.dates[`${table}:${rowHash}:${field}`] = normalizeDate(value, { choice: item, table, field }); } catch (error) { losses.push({ kind: 'unresolved-date', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (TIMESTAMP_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'timestamp', field); try { output.timestamps[`${table}:${rowHash}:${field}`] = normalizeTimestamp(value, { choice: item, table, field }); } catch (error) { losses.push({ kind: 'unresolved-timestamp', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (ENUM_FIELDS.has(`${table}.${field}`) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'unknown-value', field); try { output.enums[`${table}:${rowHash}:${field}`] = normalizeEnum(value, field, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-enum', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (['context', 'scope', 'primary_context'].includes(field) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'unknown-value', field); try { output.contexts[`${table}:${rowHash}:${field}`] = normalizeContext(value, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-context', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
      if (['links', 'connections', 'tags', 'source_observation_ids', 'data', 'sit_notes'].includes(field) && value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'malformed-json', field); try { output.json[`${table}:${rowHash}:${field}`] = normalizeJson(value, field === 'data' ? 'object' : field === 'sit_notes' ? 'array-or-object' : field === 'source_observation_ids' ? 'integer-array' : 'array', { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-json', source_table: table, source_row_sha256: rowHash, field, reason: error.message }); } }
    }
    if (table === 'entities') { const value = row.entity_type ?? row.kind; if (value !== null && value !== undefined) { const item = policyChoice(policy, row, table, 'entity-kind', 'entity_type'); try { output.entity_kinds[`${table}:${rowHash}`] = normalizeEntityKind(value, { choice: item }); } catch (error) { losses.push({ kind: 'unresolved-entity-kind', source_table: table, source_row_sha256: rowHash, reason: error.message }); } } }
  }
  losses.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))); return { ...output, losses, hash: canonicalSha256({ ...output, losses }) };
}
export const compileValueMap = buildValueMaps;
export { ENUMS };
