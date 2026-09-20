import { canonicalJson } from './canonical-json.mjs';
import { sha256Hex } from './hash.mjs';

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
    const decision = decisions[item.review_id];
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
