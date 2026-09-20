import { canonicalJson } from '../lib/canonical-json.mjs';

// Final columns and checks are copied from migrations/postgres/*.sql. Output rows
// are insert-shaped partial rows: omitted columns are supplied by v4 defaults.
export const TARGET_SCHEMAS = Object.freeze({
  people: { columns: { id:'integer', name:'text', kind:'text', salience:'text', primary_context:'text', created_at:'timestamptz', updated_at:'timestamptz' }, required:['id','name','kind'], kind: new Set(['self','person','peer_ai']) },
  nodes: { columns: { id:'integer', name:'text', kind:'text', salience:'text', primary_context:'text', created_at:'timestamptz', updated_at:'timestamptz' }, required:['id','name','kind'], kind: new Set(['concept','project','infrastructure','artifact','moment','session_log','practice','research','journal','community','emotional_pattern','relationship','self','place','object']) },
  observations: { columns: { id:'integer', entity_id:'integer', person_id:'integer', node_id:'integer', content:'text', salience:'text', emotion:'text', added_at:'timestamptz', weight:'text', updated_at:'timestamptz', charge:'text', charge_note:'text', sit_count:'integer', last_sat_at:'timestamptz', resolution_note:'text', resolved_at:'timestamptz', linked_observation_id:'integer', last_surfaced_at:'timestamptz', surface_count:'integer', novelty_score:'double', certainty:'text', source:'text', archived_at:'timestamptz', source_date:'date', context:'text', access_count:'integer', last_accessed_at:'timestamptz', valid_from:'timestamptz', valid_until:'timestamptz', superseded_by:'integer', supersedes:'integer' }, required:['id','entity_id','content'], checks:{ weight:new Set(['light','medium','heavy']), certainty:new Set(['believed','known','tentative']), source:new Set(['conversation','realization','external','consolidated','inferred','journal']), salience:new Set(['active','high','background','foundational','medium','heavy']), charge:new Set(['fresh','active','processing','metabolized']), context:new Set(['default','emotional-processing','interests-curiosities','creative-space','relational-models','episodic','values-ethics','research']) } },
  observation_versions: { columns: { id:'integer', observation_id:'integer', version_num:'integer', content:'text', weight:'text', emotion:'text', edited_at:'timestamptz' }, required:['id','observation_id','version_num','content'] },
  relations: { columns: { id:'integer', from_entity:'text', to_entity:'text', relation_type:'text', from_context:'text', to_context:'text', store_in:'text', created_at:'timestamptz' }, required:['id','from_entity','to_entity','relation_type'] },
  threads: { columns: { id:'text', thread_type:'text', content:'text', context:'text', priority:'text', status:'text', source:'text', notes:'text', created_at:'timestamptz', updated_at:'timestamptz', resolved_at:'timestamptz', resolution:'text' }, required:['id','thread_type','content'], checks:{ thread_type:new Set(['intention','task','handoff','explore','idea','project','creative','relational']), status:new Set(['active','resolved']), priority:new Set(['low','medium','high','urgent','critical']) } },
  context_entries: { columns: { id:'text', scope:'text', content:'text', links:'text', updated_at:'timestamptz' }, required:['id','scope','content'] },
  relational_state: { columns: { id:'integer', person:'text', feeling:'text', intensity:'text', timestamp:'timestamptz' }, required:['id','person','feeling','intensity'], checks:{ intensity:new Set(['whisper','present','strong','overwhelming']) } },
  identity: { columns: { id:'integer', section:'text', content:'text', kind:'text', weight:'double', connections:'text', timestamp:'timestamptz', archived_at:'timestamptz' }, required:['id','section','content'] },
  journals: { columns: { id:'integer', entry_date:'text', content:'text', tags:'text', emotion:'text', journal_type:'text', created_at:'timestamptz' }, required:['id','content'] },
  consolidation_groups: { columns: { id:'integer', summary:'text', entity_id:'integer', person_id:'integer', node_id:'integer', source_observation_ids:'integer_array', consolidated_observation_id:'integer', created_at:'timestamptz' }, required:['id','summary','source_observation_ids'] },
  images: { columns: { id:'integer', path:'text', description:'text', context:'text', emotion:'text', weight:'text', entity_id:'integer', person_id:'integer', node_id:'integer', observation_id:'integer', charge:'text', created_at:'timestamptz', last_viewed_at:'timestamptz', view_count:'integer', novelty_score:'double', last_surfaced_at:'timestamptz', surface_count:'integer', archived_at:'timestamptz' }, required:['id','path','description'] },
  subconscious: { columns: { id:'integer', state_type:'text', data:'text', updated_at:'timestamptz' }, required:['id','state_type','data'] },
  daemon_proposals: { columns: { id:'integer', proposal_type:'text', from_obs_id:'integer', to_obs_id:'integer', from_entity_id:'integer', to_entity_id:'integer', reason:'text', confidence:'double', status:'text', proposed_at:'timestamptz', resolved_at:'timestamptz', co_count_at_resolution:'integer' }, required:['id','proposal_type','reason'] },
  tensions: { columns: { id:'text', pole_a:'text', pole_b:'text', context:'text', visits:'integer', created_at:'timestamptz', last_visited:'timestamptz', resolved_at:'timestamptz', resolution:'text' }, required:['id','pole_a','pole_b'] },
  orphan_observations: { columns: { id:'integer', observation_id:'integer', first_marked:'timestamptz', rescue_attempts:'integer', last_rescue_attempt:'timestamptz' }, required:['id','observation_id'] },
  co_surfacing: { columns: { id:'integer', obs_a_id:'integer', obs_b_id:'integer', co_count:'integer', first_co_surfaced:'timestamptz', last_co_surfaced:'timestamptz', relation_proposed:'integer', relation_created:'integer' }, required:['id','obs_a_id','obs_b_id'] },
});

export const TARGET_ENUM_ALIASES = Object.freeze({
  observations: { weight: { low:'light', high:'heavy' }, certainty: { certain:'known', uncertain:'tentative', speculative:'tentative' }, charge: { dormant:'metabolized', archived:'metabolized' } },
  threads: { thread_type: { 'urgent-task':'task', build:'task', maintenance:'task', pickup:'task', deadline:'task', morning_handoff:'handoff', 'morning-handoff':'handoff', question:'explore', research:'explore', project_seed:'idea', work:'project', infrastructure:'project', anniversary:'relational', personal:'relational' }, priority: { normal:'medium', urgent:'urgent', critical:'critical' }, status: { pending:'active', open:'active', closed:'resolved' } },
  relational_state: { intensity: { high:'strong' } },
});

export function targetKindAllowed(table, kind) { return TARGET_SCHEMAS[table]?.kind?.has(kind) === true; }
export function canonicalText(value) { return value === null || value === undefined ? value ?? null : typeof value === 'string' ? value : canonicalJson(value).trim(); }

function integer(value, label) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer.`);
  return value;
}
function scalarText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  return value;
}
function dateText(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`${label} must be an ISO date.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new TypeError(`${label} must be a valid ISO date.`);
  return value;
}
export function assertTargetRow(table, row, { allowMissingRequired = false } = {}) {
  const schema = TARGET_SCHEMAS[table];
  if (!schema) throw new TypeError(`Unknown v4 target table ${table}.`);
  for (const key of Object.keys(row)) if (!Object.hasOwn(schema.columns, key)) throw new TypeError(`${table}.${key} is not a v4 target column.`);
  if (!allowMissingRequired) for (const key of schema.required ?? []) if (row[key] === null || row[key] === undefined) throw new TypeError(`${table}.${key} is required by the v4 target schema.`);
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    const type = schema.columns[key];
    if (type === 'text' || type === 'timestamptz') scalarText(value, `${table}.${key}`);
    else if (type === 'date') dateText(value, `${table}.${key}`);
    else if (type === 'real' || type === 'double') { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${table}.${key} must be a finite number.`); }
    else if (type === 'integer') integer(value, `${table}.${key}`);
    else if (type === 'integer_array') { if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item))) throw new TypeError(`${table}.${key} must be an integer array.`); }
    const allowed = schema.checks?.[key];
    if (allowed && !allowed.has(value)) throw new TypeError(`${table}.${key} violates the v4 CHECK vocabulary.`);
  }
  if (schema.kind && !schema.kind.has(row.kind)) throw new TypeError(`${table}.kind violates the v4 CHECK vocabulary.`);
  if (table === 'observations' && ((row.person_id === null || row.person_id === undefined) === (row.node_id === null || row.node_id === undefined))) throw new TypeError('observations requires exactly one of person_id/node_id.');
  if (['images','consolidation_groups'].includes(table) && row.person_id !== undefined && row.node_id !== undefined && row.person_id !== null && row.node_id !== null) throw new TypeError(`${table} cannot set both person_id and node_id.`);
  return row;
}
