import { comparePrimaryKey, normalizeRow } from './row-normalize.mjs';

export { normalizeRow } from './row-normalize.mjs';

export const REQUIRED_SOURCE_ADAPTER_METHODS = Object.freeze([
  'identity', 'catalog', 'beginSnapshot', 'streamTable', 'endSnapshot', 'close',
]);

export function assertSourceAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') throw new TypeError('Source adapter must be an object.');
  for (const method of REQUIRED_SOURCE_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') throw new TypeError(`Source adapter must implement ${method}().`);
  }
  return adapter;
}

export async function withSnapshot(adapter, callback) {
  assertSourceAdapter(adapter);
  if (typeof callback !== 'function') throw new TypeError('Snapshot callback must be a function.');
  await adapter.beginSnapshot();
  try {
    return await callback();
  } finally {
    await adapter.endSnapshot();
  }
}

export async function* streamNormalizedTable(adapter, table, primaryKey) {
  assertSourceAdapter(adapter);
  if (typeof table !== 'string' || table.length === 0) throw new TypeError('Table must be a non-empty string.');
  if (!Array.isArray(primaryKey) || primaryKey.length === 0 || primaryKey.some((key) => typeof key !== 'string' || key.length === 0)) {
    throw new TypeError('Primary key order must be a non-empty array of column names.');
  }
  await adapter.beginSnapshot();
  try {
    const rows = [];
    for await (const row of adapter.streamTable(table, primaryKey)) {
      const normalized = normalizeRow(row);
      for (const key of primaryKey) {
        if (!Object.hasOwn(normalized, key)) throw new TypeError(`Row is missing primary-key column ${key}.`);
      }
      rows.push(normalized);
    }
    rows.sort((left, right) => comparePrimaryKey(left, right, primaryKey));
    for (const row of rows) yield row;
  } finally {
    await adapter.endSnapshot();
  }
}

export async function collectNormalizedTable(adapter, table, primaryKey) {
  const rows = [];
  for await (const row of streamNormalizedTable(adapter, table, primaryKey)) rows.push(row);
  return rows;
}
