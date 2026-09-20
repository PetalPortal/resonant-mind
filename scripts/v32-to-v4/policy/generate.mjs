import { readFileSync } from 'node:fs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { FORMAT_VERSION } from '../lib/contracts.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { verifyBundle, readBundleMember } from '../lib/bundle.mjs';

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const KNOWN_KINDS = new Set(['person', 'node', 'ai', 'human', 'place', 'thing', 'concept', 'organization', 'group', 'peer_ai', 'person_ai']);
const KIND_NORMALIZATIONS = new Map([
  ['peer_ai', 'peer_ai'], ['peer ai', 'peer_ai'], ['ai peer', 'peer_ai'], ['peer-AI', 'peer_ai'],
  ['kin', 'person'], ['human', 'person'], ['person', 'person'], ['people', 'person'],
  ['ai', 'ai'], ['node', 'node'], ['thing', 'node'], ['place', 'node'], ['concept', 'node'],
  ['organization', 'node'], ['group', 'node'],
]);
const KNOWN_CONTEXTS = new Set(['default', 'primary', 'private', 'public', 'personal', 'relationship', 'work', 'inner', 'dream', 'archive', 'archived', 'system', 'global']);
const KNOWN_STATUSES = new Set(['pending', 'open', 'active', 'resolved', 'closed', 'accepted', 'rejected', 'dismissed', 'deferred', 'cancelled', 'canceled']);
const JSON_SHAPES = new Map([
  ['links', 'array'], ['connections', 'array'], ['tags', 'array'], ['source_observation_ids', 'array'],
  ['data', 'object'], ['sit_notes', 'array-or-object'],
]);
const TIMESTAMP_KEY = /(?:^|_)(?:at|date|timestamp|time|marked|surfaced|accessed|resolved|created|updated|changed|added|valid_from|valid_until|superseded_by|supersedes)(?:$|_)/iu;
const FK_FIELDS = new Map([
  ['observations', new Map([['entity_id', 'entities'], ['linked_observation_id', 'observations'], ['superseded_by', 'observations'], ['supersedes', 'observations']])],
  ['observation_versions', new Map([['observation_id', 'observations']])],
  ['images', new Map([['entity_id', 'entities'], ['observation_id', 'observations']])],
  ['consolidation_groups', new Map([['entity_id', 'entities'], ['consolidated_observation_id', 'observations']])],
  ['dormant_observations', new Map([['observation_id', 'observations']])],
  ['co_surfacing', new Map([['obs_a_id', 'observations'], ['obs_b_id', 'observations']])],
  ['daemon_proposals', new Map([['from_obs_id', 'observations'], ['to_obs_id', 'observations'], ['from_entity_id', 'entities'], ['to_entity_id', 'entities']])],
]);

function fail(summary, details = {}) {
  throw new MigrationRefusal({ code: 'RMIG-E-POLICY-UNRESOLVED', phase: 'compile-policy', summary, safe_details: details, report_path: null });
}
function rowsFor(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new TypeError('Policy input must be a bundle object.');
  const source = bundle.tables ?? bundle.rows ?? bundle.data ?? {};
  if (Array.isArray(source)) {
    const out = Object.create(null);
    for (const entry of source) {
      if (!entry || typeof entry.table !== 'string' || !Array.isArray(entry.rows)) continue;
      out[entry.table] = entry.rows;
    }
    return out;
  }
  const out = Object.create(null);
  for (const [table, rows] of Object.entries(source)) if (Array.isArray(rows)) out[table] = rows;
  return out;
}
function sourceId(table, row, index) {
  if (row && Object.hasOwn(row, 'id')) return row.id;
  if (row && Object.hasOwn(row, 'key')) return row.key;
  return index;
}
function safeId(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' || typeof value === 'number' ? value : canonicalJson(value).trim();
}
function itemId(type, table, id, rowHash) {
  return sha256Hex(canonicalJson({ type, source_table: table, source_id: safeId(id), source_row_sha256: rowHash }).trim());
}
function makeItem(type, table, row, index, reason, allowedChoices, extra = {}) {
  const rowHash = canonicalSha256(row);
  return {
    decision_id: itemId(type, table, sourceId(table, row, index), rowHash),
    type,
    source_table: table,
    source_id: safeId(sourceId(table, row, index)),
    source_row_sha256: rowHash,
    reason,
    allowed_choices: [...allowedChoices],
    ...extra,
  };
}
function add(items, seen, item) {
  if (!seen.has(item.decision_id)) { seen.add(item.decision_id); items.push(item); }
}
function timestampAmbiguity(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'timestamp is not text';
  if (ISO_WITH_OFFSET.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf()) && date.toISOString() !== undefined) return null;
  }
  if (SQLITE_UTC.test(value)) {
    const date = new Date(`${value.replace(' ', 'T')}Z`);
    if (!Number.isNaN(date.valueOf())) return null;
  }
  if (/^\d{1,13}$/u.test(value) || typeof value === 'number') return 'epoch-like timestamp requires an explicit unit and timezone';
  if (!/[T ]/u.test(value)) return 'timestamp is not a supported timestamp form';
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/u.test(value)) return 'timestamp is naive and has no timezone offset';
  return 'timestamp is invalid';
}
function shapeOk(value, shape) {
  if (typeof value !== 'string') return false;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return false; }
  if (shape === 'array') return Array.isArray(parsed);
  if (shape === 'object') return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  return Array.isArray(parsed) || (parsed !== null && typeof parsed === 'object');
}
function itemForUnknown(table, row, index, field, value, reason, choices = ['map', 'exclude-row']) {
  return makeItem('unknown-value', table, row, index, reason, choices, { field, observed_value_sha256: sha256Hex(String(value)) });
}

export function extractBundleRows(bundle) { return rowsFor(bundle); }
export function bundleHash(bundle) {
  if (typeof bundle?.bundle_manifest_sha256 === 'string') return bundle.bundle_manifest_sha256;
  if (typeof bundle?.manifest_sha256 === 'string') return bundle.manifest_sha256;
  if (typeof bundle?.manifest?.manifest_sha256 === 'string') return bundle.manifest.manifest_sha256;
  if (typeof bundle?.manifest?.envelope?.manifest_sha256 === 'string') return bundle.manifest.envelope.manifest_sha256;
  throw new TypeError('Policy input must include bundle_manifest_sha256.');
}

export function generateDecisionItems(bundle) {
  const tables = rowsFor(bundle);
  const items = [];
  const seen = new Set();
  const entityRows = tables.entities ?? [];
  const entityGroups = new Map();
  entityRows.forEach((row, index) => {
    const name = row.name;
    if (typeof name === 'string') {
      const group = entityGroups.get(name) ?? [];
      group.push({ row, index });
      entityGroups.set(name, group);
    }
    const rawKind = row.entity_type ?? row.kind;
    if (typeof rawKind === 'string' && !KIND_NORMALIZATIONS.has(rawKind.toLowerCase()) && !KNOWN_KINDS.has(rawKind.toLowerCase())) {
      add(items, seen, makeItem('entity-kind', 'entities', row, index, 'entity kind is not covered by a deterministic v4 normalization', ['map-to-person', 'map-to-node', 'exclude-row'], { field: 'entity_type', observed_value_sha256: sha256Hex(rawKind) }));
    }
    for (const field of ['primary_context']) if (row[field] !== null && row[field] !== undefined && !KNOWN_CONTEXTS.has(String(row[field]).toLowerCase())) add(items, seen, itemForUnknown('entities', row, index, field, row[field], 'entity context is not a known deterministic context', ['map-context', 'exclude-row']));
  });
  for (const [name, group] of entityGroups) if (group.length > 1) {
    add(items, seen, makeItem('duplicate-entity-name', 'entities', group[0].row, group[0].index, 'entity name collides across source contexts and v4 requires a globally unambiguous legacy name', ['merge', 'rename', 'exclude-row'], {
      field: 'name',
      collision_ids: group.map(({ row }) => safeId(row.id)).sort((a, b) => String(a).localeCompare(String(b))),
      required_choice_fields: { merge: ['survivor_id', 'merged_ids', 'field_rules'], rename: ['names'] },
    }));
  }

  for (const [table, rows] of Object.entries(tables)) rows.forEach((row, index) => {
    for (const [field, value] of Object.entries(row)) {
      if (value !== null && value !== undefined && TIMESTAMP_KEY.test(field)) {
        const reason = timestampAmbiguity(value);
        if (reason) add(items, seen, makeItem('timestamp', table, row, index, reason, ['normalize-utc', 'exclude-row'], { field, observed_value_sha256: sha256Hex(String(value)) }));
      }
      const shape = JSON_SHAPES.get(field);
      if (shape && value !== null && value !== undefined && !shapeOk(value, shape)) add(items, seen, makeItem('malformed-json', table, row, index, `JSON field does not match the expected ${shape} shape`, ['map-json', 'exclude-row'], { field, expected_shape: shape, observed_value_sha256: sha256Hex(String(value)) }));
      if ((field === 'context' || field === 'scope' || field === 'primary_context') && value !== null && value !== undefined && !KNOWN_CONTEXTS.has(String(value).toLowerCase())) add(items, seen, itemForUnknown(table, row, index, field, value, 'context/scope value is not a known deterministic value', ['map-context', 'exclude-row']));
      if (field === 'status' && value !== null && value !== undefined && !KNOWN_STATUSES.has(String(value).toLowerCase())) add(items, seen, itemForUnknown(table, row, index, field, value, 'status value is not a known deterministic value', ['map-status', 'exclude-row']));
    }
    if (table === 'tensions' && ((row.status && ['resolved', 'closed'].includes(String(row.status).toLowerCase()) && row.resolved_at == null) || (Number(row.sit_count) > 0 && row.sit_notes == null))) add(items, seen, makeItem('tension-state', table, row, index, 'tension sit history and resolution status do not form an unambiguous v4 visit/resolution shape', ['preserve-visits-and-resolve', 'preserve-visits-and-open', 'exclude-row'], { required_choice_fields: { 'preserve-visits-and-resolve': ['resolved_at'], 'preserve-visits-and-open': [] } }));
    if (table === 'dormant_observations') add(items, seen, makeItem('dormancy-translation', table, row, index, 'dormant observation terminology must be explicitly translated to the v4 orphan-observation surface', ['translate-to-orphan', 'exclude-row'], { target_table: 'orphan_observations' }));
    const fks = FK_FIELDS.get(table);
    if (fks) for (const [field, target] of fks) if (row[field] !== null && row[field] !== undefined) {
      const ids = new Set((tables[target] ?? []).map((candidate) => String(candidate.id)));
      if (!ids.has(String(row[field]))) add(items, seen, makeItem('broken-foreign-key', table, row, index, 'foreign-key target does not exist in the verified source rows', ['null-if-allowed', 'exclude-row', 'link-by-reviewed-id'], { field, target_table: target, target_id: safeId(row[field]) }));
    }
    if (table === 'relations') for (const field of ['from_entity', 'to_entity']) if (row[field] !== null && row[field] !== undefined) {
      const matching = (tables.entities ?? []).filter((entity) => String(entity.name) === String(row[field]));
      if (matching.length === 0) add(items, seen, makeItem('broken-name-reference', table, row, index, 'name-based relation endpoint does not resolve to a verified entity', ['link-by-reviewed-id', 'exclude-row'], { field, target_table: 'entities', endpoint_sha256: sha256Hex(String(row[field])) }));
      if (matching.length > 1) add(items, seen, makeItem('ambiguous-name-reference', table, row, index, 'name-based relation endpoint resolves to multiple verified entities', ['link-by-reviewed-id', 'exclude-row'], { field, target_table: 'entities', endpoint_sha256: sha256Hex(String(row[field])) }));
    }
  });
  const secretItems = bundle.secret_review_items ?? bundle.secretReviewItems ?? bundle.secret_review?.pending_items ?? [];
  for (const raw of secretItems) {
    const source = raw.source ?? raw;
    const row = { id: source.source_id ?? source.row_key ?? raw.review_id ?? 'secret-review' };
    add(items, seen, makeItem('secret-review', source.table ?? 'unknown', row, 0, 'lived-content secret finding requires an existing explicit secret decision', ['retain', 'redact', 'exclude-row'], { review_id: raw.review_id ?? null, field: source.column ?? null }));
  }
  return items.sort((a, b) => a.decision_id.localeCompare(b.decision_id));
}

function baseManifest(bundle, now) {
  return {
    format_version: FORMAT_VERSION,
    manifest_type: 'ambiguity-decision-manifest',
    migration_id: bundle.migration_id ?? bundle.manifest?.migration_id,
    bundle_manifest_sha256: bundleHash(bundle),
    reviewed: false,
    generated_at: now,
    reviewed_by: null,
    reviewed_at: null,
    items: generateDecisionItems(bundle),
  };
}
function hashableManifest(manifest) { const { manifest_sha256: _ignored, ...rest } = manifest; return rest; }
export function decisionManifestHash(manifest) { return canonicalSha256(hashableManifest(manifest)); }

export function generateDecisionManifest(bundle, { now = new Date().toISOString() } = {}) {
  const source = typeof bundle === 'string' ? loadVerifiedBundle(bundle) : bundle?.bundlePath ? loadVerifiedBundle(bundle.bundlePath, bundle) : bundle;
  const manifest = baseManifest(source, now);
  manifest.manifest_sha256 = decisionManifestHash(manifest);
  return manifest;
}
export const generatePolicyDraft = generateDecisionManifest;
export const generateDecisionDraft = generateDecisionManifest;

export function loadBundleDescriptor(path) {
  const manifest = JSON.parse(readFileSync(`${path}/manifest.json`, 'utf8'));
  const hash = sha256Hex(readFileSync(`${path}/manifest.json`));
  return { manifest, bundle_manifest_sha256: hash, migration_id: manifest.migration_id };
}

export function loadVerifiedBundle(path, options = {}) {
  const verified = verifyBundle({ path, passphraseFile: options.passphraseFile, env: options.env, platform: options.platform });
  const tables = {};
  for (const member of verified.manifest.members) if (member.name.startsWith('data/')) {
    const text = readBundleMember({ path, manifest: verified.manifest, member, passphraseFile: options.passphraseFile, env: options.env, platform: options.platform }).toString('utf8');
    tables[member.name.slice(5).replace(/\.ndjson(?:\.enc)?$/u, '')] = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  const envelope = JSON.parse(readFileSync(`${path}/envelope.json`, 'utf8'));
  return { tables, migration_id: verified.manifest.migration_id, bundle_manifest_sha256: envelope.manifest_sha256, manifest: verified.manifest };
}

export function choiceForItem(decisions, item) {
  const items = decisions?.items ?? decisions?.decisions ?? [];
  return items.find((candidate) => candidate.decision_id === item.decision_id || (candidate.source_row_sha256 === item.source_row_sha256 && candidate.type === item.type))?.choice;
}
export { HASH, ISO_WITH_OFFSET, SQLITE_UTC, KIND_NORMALIZATIONS };
