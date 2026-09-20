import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { assertMigrationId, assertTimestamp, assertPlainData, FORMAT_VERSION } from '../lib/contracts.mjs';
import { decisionManifestHash, generateDecisionItems, bundleHash } from './generate.mjs';

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = new Set(['string', 'number']);
const ITEM_REQUIRED = ['decision_id', 'type', 'source_table', 'source_id', 'source_row_sha256', 'reason', 'allowed_choices'];
const ITEM_OPTIONAL = new Set(['field', 'target_table', 'target_id', 'expected_shape', 'observed_value_sha256', 'collision_ids', 'required_choice_fields', 'review_id']);
const TOP_KEYS = new Set(['format_version', 'manifest_type', 'migration_id', 'bundle_manifest_sha256', 'reviewed', 'generated_at', 'reviewed_by', 'reviewed_at', 'items', 'manifest_sha256']);
const WILDCARDS = new Set(['*', 'all', 'accept-all', 'accept_all', 'any', 'unknown']);
function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  return value;
}
function keysOnly(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported key ${key}.`);
}
function safeText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be safe text.`);
}
function choiceValid(choice, item) {
  if (typeof choice === 'string') {
    if (WILDCARDS.has(choice.toLowerCase()) || !item.allowed_choices.includes(choice)) throw new TypeError(`Unsupported choice for ${item.decision_id}.`);
    return;
  }
  object(choice, `items[${item.decision_id}].choice`);
  if (Object.keys(choice).some((key) => WILDCARDS.has(key.toLowerCase()))) throw new TypeError('Wildcard policy choices are not supported.');
  const action = choice.action ?? choice.type ?? choice.kind ?? choice.choice;
  if (typeof action !== 'string' || WILDCARDS.has(action.toLowerCase()) || !item.allowed_choices.includes(action)) throw new TypeError(`Unsupported structured choice for ${item.decision_id}.`);
  for (const value of Object.values(choice)) if (typeof value === 'string' && WILDCARDS.has(value.toLowerCase())) throw new TypeError('Wildcard policy choices are not supported.');
  if (action === 'merge') {
    if (!Object.hasOwn(choice, 'survivor_id') || !Array.isArray(choice.merged_ids) || !Object.hasOwn(choice, 'field_rules')) throw new TypeError('Merge choices require survivor_id, merged_ids, and field_rules.');
    if (choice.merged_ids.length === 0 || choice.merged_ids.some((id) => id === null || id === undefined)) throw new TypeError('Merge choices must enumerate all source IDs.');
    if (Array.isArray(item.collision_ids) && (choice.merged_ids.length !== item.collision_ids.length || [...choice.merged_ids].map(String).sort().join(',') !== [...item.collision_ids].map(String).sort().join(','))) throw new TypeError('Merge choices must enumerate every colliding source ID exactly once.');
  }
  if (action === 'rename' && (!choice.names || typeof choice.names !== 'object')) throw new TypeError('Rename choices require deterministic names for every source ID.');
  if (action === 'rename' && Array.isArray(item.collision_ids) && item.collision_ids.some((id) => typeof choice.names[String(id)] !== 'string' || choice.names[String(id)].length === 0)) throw new TypeError('Rename choices must provide a final name for every colliding source ID.');
  if (action === 'link-by-reviewed-id' && (choice.target_id === null || choice.target_id === undefined)) throw new TypeError('Reviewed link choices require target_id.');
}
function validateItem(item, index, reviewed) {
  object(item, `items[${index}]`);
  const allowed = new Set([...ITEM_REQUIRED, ...ITEM_OPTIONAL]);
  if (reviewed) allowed.add('choice');
  keysOnly(item, allowed, `items[${index}]`);
  for (const key of ITEM_REQUIRED) if (!Object.hasOwn(item, key)) throw new TypeError(`items[${index}] is missing ${key}.`);
  if (!HASH.test(item.decision_id) || !HASH.test(item.source_row_sha256)) throw new TypeError(`items[${index}] has invalid decision or row hash.`);
  safeText(item.type, `items[${index}].type`); safeText(item.source_table, `items[${index}].source_table`); safeText(item.reason, `items[${index}].reason`);
  if (!SAFE_ID.has(typeof item.source_id) || item.source_id === '') throw new TypeError(`items[${index}].source_id must be a scalar source ID.`);
  if (!Array.isArray(item.allowed_choices) || item.allowed_choices.length === 0 || new Set(item.allowed_choices).size !== item.allowed_choices.length) throw new TypeError(`items[${index}].allowed_choices must be a non-empty choice list.`);
  for (const choice of item.allowed_choices) { safeText(choice, `items[${index}].allowed_choices`); if (WILDCARDS.has(choice.toLowerCase())) throw new TypeError('Wildcard choices are not supported.'); }
  if (Object.hasOwn(item, 'observed_value_sha256') && !HASH.test(item.observed_value_sha256)) throw new TypeError('Observed value hash is invalid.');
  if (Object.hasOwn(item, 'collision_ids') && (!Array.isArray(item.collision_ids) || item.collision_ids.length < 2)) throw new TypeError('Collision IDs must enumerate at least two IDs.');
  if (reviewed) { if (!Object.hasOwn(item, 'choice')) throw new TypeError(`items[${index}] is unresolved.`); choiceValid(item.choice, item); }
  else if (Object.hasOwn(item, 'choice')) throw new TypeError('Draft decision manifests must not contain choices.');
}
export function validateDecisionManifest(value, { bundleManifestSha256, expectedItems, bundle } = {}) {
  object(value, 'Decision manifest');
  assertPlainData(value);
  keysOnly(value, TOP_KEYS, 'Decision manifest');
  for (const key of TOP_KEYS) if (!Object.hasOwn(value, key)) throw new TypeError(`Decision manifest is missing ${key}.`);
  if (value.format_version !== FORMAT_VERSION || value.manifest_type !== 'ambiguity-decision-manifest') throw new TypeError('Unsupported decision manifest format.');
  assertMigrationId(value.migration_id, 'migration_id');
  if (!HASH.test(value.bundle_manifest_sha256)) throw new TypeError('bundle_manifest_sha256 must be a lowercase SHA-256 digest.');
  const expectedBundleHash = bundleManifestSha256 ?? (bundle === undefined ? undefined : bundleHash(bundle));
  if (expectedBundleHash !== undefined && value.bundle_manifest_sha256 !== expectedBundleHash) throw new TypeError('Decision manifest is stale for this bundle.');
  if (typeof value.reviewed !== 'boolean') throw new TypeError('reviewed must be boolean.');
  assertTimestamp(value.generated_at, 'generated_at');
  if (!Array.isArray(value.items)) throw new TypeError('items must be an array.');
  const ids = new Set();
  for (let index = 0; index < value.items.length; index += 1) { validateItem(value.items[index], index, value.reviewed); if (ids.has(value.items[index].decision_id)) throw new TypeError('Decision IDs must be unique.'); ids.add(value.items[index].decision_id); }
  if (!HASH.test(value.manifest_sha256) || decisionManifestHash(value) !== value.manifest_sha256) throw new TypeError('manifest_sha256 does not match canonical decision content.');
  if (value.reviewed) {
    safeText(value.reviewed_by, 'reviewed_by'); assertTimestamp(value.reviewed_at, 'reviewed_at');
    const completeItems = expectedItems ?? (bundle === undefined ? undefined : generateDecisionItems(bundle));
    if (completeItems !== undefined) {
      const expectedById = new Map(completeItems.map((item) => [item.decision_id, item]));
      const expected = new Set(expectedById.keys());
      if (expected.size !== ids.size || [...expected].some((id) => !ids.has(id))) throw new TypeError('Reviewed policy has missing or extra decisions.');
      for (const item of value.items) {
        const expectedItem = expectedById.get(item.decision_id);
        const comparable = (candidate) => ({ type: candidate.type, source_table: candidate.source_table, source_id: candidate.source_id, source_row_sha256: candidate.source_row_sha256, reason: candidate.reason, allowed_choices: candidate.allowed_choices });
        if (canonicalJson(comparable(item)) !== canonicalJson(comparable(expectedItem))) throw new TypeError(`Decision ${item.decision_id} is stale or does not match the verified source row.`);
      }
    }
  } else if (value.reviewed_by !== null || value.reviewed_at !== null) throw new TypeError('Unreviewed decision manifests must have null review metadata.');
  return value;
}
export function assertReviewedDecisionManifest(value, options = {}) { validateDecisionManifest(value, options); if (!value.reviewed) throw new TypeError('Decision manifest is not reviewed.'); return value; }
export function decisionContentHash(value) { const { manifest_sha256: _ignored, ...rest } = value; return canonicalSha256(rest); }
