// Re-reads the live source and proves it still holds exactly what the bundle holds.
//
// The bundle is a copy taken at one moment. Validation is the last gate before cutover, so it asks the
// source again, row by row with the same primary-key order and the same exact-text rules the export used,
// whether anything was added, removed or changed since. A source that moved is a finding, not a rounding.

import { canonicalJson } from '../lib/canonical-json.mjs';
import { compareCatalog, sourceSpecFor } from '../lib/fingerprint.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { normalizeRow } from '../source/row-normalize.mjs';

const keyOf = (row, primaryKey) => canonicalJson(primaryKey.map((column) => row[column]));

/** @returns the live source's row count per table; findings are added to `findings`. */
export async function compareSourceToBundle({ adapter, sourceKind, expectedFingerprint, bundleTables, findings }) {
  const counts = {};
  await adapter.beginSnapshot();
  try {
    const catalog = await adapter.catalog();
    const comparison = compareCatalog(catalog, sourceSpecFor(sourceKind === 'd1-export' ? 'sqlite' : sourceKind));
    if (!comparison.match) { findings.add('source-schema-changed', { actual_fingerprint: comparison.actualFingerprint }); return counts; }
    if (comparison.actualFingerprint !== expectedFingerprint) { findings.add('source-fingerprint-differs-from-bundle', { actual_fingerprint: comparison.actualFingerprint, bundle_fingerprint: expectedFingerprint }); return counts; }
    for (const table of catalog.tables) {
      const primaryKey = table.primary_key;
      const inBundle = new Map((bundleTables[table.name] ?? []).map((row) => [keyOf(row, primaryKey), canonicalSha256(row)]));
      const seen = new Set();
      let count = 0;
      for await (const raw of adapter.streamTable(table.name, primaryKey)) {
        const row = normalizeRow(raw);
        const key = keyOf(row, primaryKey);
        count += 1;
        seen.add(key);
        const expected = inBundle.get(key);
        if (expected === undefined) findings.add('source-row-added-since-export', { table: table.name, key_sha256: canonicalSha256(key) });
        else if (expected !== canonicalSha256(row)) findings.add('source-row-changed-since-export', { table: table.name, key_sha256: canonicalSha256(key) });
      }
      for (const key of inBundle.keys()) if (!seen.has(key)) findings.add('source-row-removed-since-export', { table: table.name, key_sha256: canonicalSha256(key) });
      counts[table.name] = count;
    }
    return counts;
  } finally {
    try { await adapter.endSnapshot(); } catch { /* the comparison result matters more */ }
    await adapter.close();
  }
}
