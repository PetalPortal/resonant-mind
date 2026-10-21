import { canonicalJson } from './canonical-json.mjs';
import { canonicalSha256, sha256Hex } from './hash.mjs';

const LIVED_FIELDS = /(?:content|body|text|summary|description|message|note|prompt|context|value|reason|title|label)/iu;
const METADATA_PATH = /(?:metadata|config|configuration|settings|credential|connection|environment|secret)/iu;
const POSTGRES_URL = /postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@[^\s/]+(?:\/[^\s]*)?/iu;
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/iu;
const CLOUD_VALUE = /\b(?:sk|rk|ghp|github_pat|xoxb|xoxp)_[A-Za-z0-9_-]{12,}\b/u;
const CLOUDFLARE_NAME = /\b(?:cf[_-]?api[_-]?token|cloudflare[_-]?(?:api[_-]?)?(?:token|key))\b/iu;
const KEY_NAME = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key|auth[_-]?token)/iu;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function findingKind(key, text) {
  if (POSTGRES_URL.test(text)) return 'postgres-credential-url';
  if (PRIVATE_KEY.test(text)) return 'private-key';
  if (CLOUDFLARE_NAME.test(key) || CLOUD_VALUE.test(text)) return 'cloudflare-or-api-token';
  if (BEARER.test(text)) return 'bearer-token';
  if (KEY_NAME.test(key) && text.length > 0) return key.toLowerCase().includes('private') ? 'private-key' : 'credential-field';
  return null;
}

export function reviewDecisionId(item) {
  const stable = {
    table: item.table,
    row_key: item.row_key,
    column: item.column,
    kind: item.kind,
    value_sha256: item.value_sha256,
  };
  return sha256Hex(canonicalJson(stable).trim());
}

function rowKey(row, rowIndex, primaryKey) {
  if (Array.isArray(primaryKey) && primaryKey.length > 0) {
    return primaryKey.map((key) => row[key] ?? null);
  }
  return row.id ?? rowIndex;
}

export function scanRows(rows, {
  table = 'unknown',
  primaryKey,
  falsePositiveAcknowledgements = [],
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError('Secret scanner rows must be an array.');
  const acknowledged = new Set(falsePositiveAcknowledgements);
  const highConfidence = [];
  const reviewItems = [];
  const walk = (value, path, rowIndex, row) => {
    if (typeof value === 'string') {
      const key = path.split('.').at(-1) ?? path;
      const kind = findingKind(key, value);
      if (!kind) return;
      const item = {
        table,
        row_key: rowKey(row, rowIndex, primaryKey),
        column: path,
        kind,
        value_sha256: sha256Hex(value),
      };
      item.review_id = reviewDecisionId(item);
      if (acknowledged.has(item.review_id)) return;
      const isLived = LIVED_FIELDS.test(key) && !METADATA_PATH.test(path) && !KEY_NAME.test(key);
      if (isLived) reviewItems.push(item);
      else highConfidence.push(item);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`, rowIndex, row));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key, rowIndex, row);
    }
  };
  rows.forEach((row, index) => walk(row, '', index, row));
  return { highConfidence, reviewItems };
}

export function applyReviewDecisions(row, items, decisions = {}) {
  const output = structuredClone(row);
  let exclude = false;
  for (const item of items) {
    const raw = decisions[item.review_id];
    const decision = typeof raw === 'object' && raw !== null ? raw.decision : raw;
    if (!['retain', 'redact', 'exclude-row'].includes(decision)) {
      throw new Error(`A decision is required for secret review item ${item.review_id}.`);
    }
    if (decision === 'exclude-row') {
      exclude = true;
      continue;
    }
    if (decision === 'redact') {
      const segments = item.column.match(/[^.[\]]+/gu) ?? [];
      let cursor = output;
      for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
      if (segments.length > 0) cursor[segments.at(-1)] = '[REDACTED]';
    }
  }
  return { row: output, exclude };
}

const REVIEW_ID = /^[0-9a-f]{64}$/u;
const DECISIONS = new Set(['retain', 'redact', 'exclude-row']);

function assertReviewText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be a safe non-empty string.`);
}

function assertReviewTimestamp(value, label) {
  assertReviewText(value, label);
  if (new Date(value).toISOString() !== value) throw new TypeError(`${label} must be a canonical UTC timestamp.`);
}

export function normalizeSecretDecisions(decisions = {}, falsePositiveAcknowledgements = []) {
  if (decisions === null || typeof decisions !== 'object' || Array.isArray(decisions) || Object.getPrototypeOf(decisions) !== Object.prototype) throw new TypeError('Secret decisions must be a plain object.');
  if (!Array.isArray(falsePositiveAcknowledgements) || falsePositiveAcknowledgements.some((id) => typeof id !== 'string' || !REVIEW_ID.test(id))) throw new TypeError('False-positive acknowledgements must be review IDs.');
  const normalized = [];
  for (const [reviewId, value] of Object.entries(decisions)) {
    if (!REVIEW_ID.test(reviewId)) throw new TypeError('Secret decision keys must be review IDs.');
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Secret decisions must be structured records.');
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'decision,reviewed_at,reviewed_by') throw new TypeError('Secret decision records must contain exactly decision, reviewed_at, and reviewed_by.');
    if (!DECISIONS.has(value.decision)) throw new TypeError('Secret decision choice is invalid.');
    assertReviewText(value.reviewed_by, 'Secret decision reviewed_by');
    assertReviewTimestamp(value.reviewed_at, 'Secret decision reviewed_at');
    normalized.push({ review_id: reviewId, decision: value.decision, reviewed_at: value.reviewed_at, reviewed_by: value.reviewed_by });
  }
  normalized.sort((left, right) => left.review_id.localeCompare(right.review_id));
  const falsePositives = [...new Set(falsePositiveAcknowledgements)].sort();
  return { decisions: normalized, false_positive_acknowledgements: falsePositives };
}

export function secretReviewHash(review) {
  return canonicalSha256(review);
}
