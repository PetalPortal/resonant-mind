import { types } from 'node:util';

function fail(path, detail) {
  throw new TypeError(`Row value at ${path} ${detail}.`);
}

export function normalizeValue(value, path = 'row') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) {
      fail(path, 'contains an unsafe number');
    }
    return value;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || types.isAnyArrayBuffer(value)) {
    fail(path, 'must not contain bytes');
  }
  fail(path, 'contains an unsupported value');
}

export function normalizeRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('Database row must be a plain object.');
  }
  const normalized = {};
  for (const key of Object.keys(row)) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`Database row field ${key} must be a data property.`);
    normalized[key] = normalizeValue(descriptor.value, `row.${key}`);
  }
  return normalized;
}

export function comparePrimaryKey(left, right, primaryKey) {
  for (const key of primaryKey) {
    const a = left[key];
    const b = right[key];
    if (a === b) continue;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
    const aText = String(a);
    const bText = String(b);
    if (aText !== bText) return aText < bText ? -1 : 1;
  }
  return 0;
}

export function normalizeRows(rows) {
  return [...rows].map(normalizeRow);
}
