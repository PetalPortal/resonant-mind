import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from './canonical-json.mjs';
import { canonicalSha256 } from './hash.mjs';
import { MigrationRefusal } from './refusal.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const specRoot = resolve(here, '../spec');
const SPECS = Object.freeze({
  postgres: JSON.parse(readFileSync(resolve(specRoot, 'v3.2-postgres.json'), 'utf8')),
  sqlite: JSON.parse(readFileSync(resolve(specRoot, 'v3.2-sqlite.json'), 'utf8')),
});
const SOURCE_KINDS = new Set(Object.keys(SPECS));
const COLLECTIONS = ['columns', 'unique_constraints', 'foreign_keys', 'checks', 'indexes'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function byName(left, right) {
  return String(left.name).localeCompare(String(right.name));
}

function normalizeColumn(value) {
  return {
    name: String(value.name),
    type: String(value.type ?? '').trim().toLowerCase(),
    nullable: Boolean(value.nullable),
    default: value.default === undefined ? null : value.default,
    pk_position: Number(value.pk_position ?? 0),
  };
}

function normalizeConstraint(value, kind) {
  if (kind === 'foreign_keys') {
    return {
      name: String(value.name),
      columns: [...(value.columns ?? [])].map(String),
      references: {
        table: String(value.references?.table),
        columns: [...(value.references?.columns ?? [])].map(String),
      },
      on_delete: String(value.on_delete ?? 'NO ACTION').toUpperCase(),
      on_update: String(value.on_update ?? 'NO ACTION').toUpperCase(),
    };
  }
  if (kind === 'checks') {
    return { name: String(value.name), expression: String(value.expression ?? '') };
  }
  return {
    name: String(value.name),
    unique: Boolean(value.unique),
    columns: [...(value.columns ?? [])].map(String),
    where: value.where ?? null,
    ...(value.method === undefined ? {} : { method: String(value.method).toLowerCase() }),
    ...(value.opclass === undefined ? {} : { opclass: String(value.opclass) }),
    ...(value.options === undefined ? {} : { options: String(value.options) }),
    ...(value.expressions === undefined ? {} : { expressions: [...value.expressions].map(String) }),
  };
}

function normalizeTable(value) {
  const table = {
    name: String(value.name),
    columns: [...(value.columns ?? [])].map(normalizeColumn).sort((a, b) => a.pk_position - b.pk_position || a.name.localeCompare(b.name)),
    primary_key: [...(value.primary_key ?? [])].map(String),
    unique_constraints: [],
    foreign_keys: [],
    checks: [],
    indexes: [],
  };
  for (const kind of COLLECTIONS.slice(1)) {
    table[kind] = [...(value[kind] ?? [])].map((entry) => normalizeConstraint(entry, kind)).sort(byName);
  }
  table.primary_key.sort((a, b) => table.columns.findIndex((column) => column.name === a) - table.columns.findIndex((column) => column.name === b));
  return table;
}

export function normalizeCatalog(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Catalog must be an object.');
  }
  const tables = Array.isArray(value) ? value : value.tables;
  if (!Array.isArray(tables)) throw new TypeError('Catalog tables must be an array.');
  return {
    ...(value.family === undefined ? {} : { family: String(value.family) }),
    ...(value.catalog_version === undefined ? {} : { catalog_version: String(value.catalog_version) }),
    tables: tables.map(normalizeTable).sort(byName),
  };
}

export function fingerprintCatalog(catalog) {
  return canonicalSha256(normalizeCatalog(catalog));
}

function compareValue(expected, actual, path, diff, maxDiffs) {
  if (diff.length >= maxDiffs) return;
  if (expected === undefined || actual === undefined) {
    if (expected === undefined) diff.push({ kind: 'extra', path, actual });
    else diff.push({ kind: 'missing', path, expected });
    return;
  }
  if (canonicalJson(expected) === canonicalJson(actual)) return;
  if (expected === undefined) {
    diff.push({ kind: 'extra', path, actual });
    return;
  }
  if (actual === undefined) {
    diff.push({ kind: 'missing', path, expected });
    return;
  }
  if (expected === null || actual === null || typeof expected !== typeof actual || typeof expected !== 'object') {
    diff.push({ kind: 'changed', path, expected, actual });
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length && diff.length < maxDiffs; index += 1) {
      compareValue(expected[index], actual[index], `${path}[${index}]`, diff, maxDiffs);
    }
    return;
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) compareValue(expected[key], actual[key], `${path}.${key}`, diff, maxDiffs);
}

export function compareCatalog(actual, expected, { maxDiffs = 24 } = {}) {
  if (!Number.isSafeInteger(maxDiffs) || maxDiffs < 1) throw new TypeError('maxDiffs must be a positive safe integer.');
  const normalizedActual = normalizeCatalog(actual);
  const normalizedExpected = normalizeCatalog(expected);
  const diff = [];
  compareValue(normalizedExpected, normalizedActual, 'catalog', diff, maxDiffs);
  return {
    match: diff.length === 0,
    actualFingerprint: fingerprintCatalog(normalizedActual),
    expectedFingerprint: fingerprintCatalog(normalizedExpected),
    diff,
  };
}

export function sourceSpecFor(kind) {
  if (!SOURCE_KINDS.has(kind)) throw new TypeError(`Unknown exact source kind: ${String(kind)}.`);
  return clone(SPECS[kind]);
}

export function assertExactSourceCatalog(kind, actual, options = {}) {
  const expected = sourceSpecFor(kind);
  const comparison = compareCatalog(actual, expected, options);
  if (!comparison.match) {
    throw new MigrationRefusal({
      code: 'RMIG-E-SOURCE-FINGERPRINT',
      phase: 'inspect-source',
      summary: 'The source catalog is not the exact public v3.2 schema.',
      safe_details: {
        source_kind: kind,
        expected_fingerprint: comparison.expectedFingerprint,
        actual_fingerprint: comparison.actualFingerprint,
        diff: comparison.diff,
      },
      report_path: null,
    });
  }
  return comparison;
}

export function catalogTables(kind) {
  return sourceSpecFor(kind).tables.map((table) => table.name);
}

export const EXACT_SOURCE_KINDS = Object.freeze([...SOURCE_KINDS]);
