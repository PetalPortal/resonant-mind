import { canonicalSha256 } from './hash.mjs';

function nullableText(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function canonicalInteger(value, label, { min = 0 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(number) || number < min) throw new TypeError(`${label} must be a non-negative integer or null.`);
  return number;
}

export function normalizePostgresIdentity(row = {}) {
  return Object.freeze({
    database_name: nullableText(row.database_name),
    database_oid: canonicalInteger(row.database_oid, 'database_oid'),
    server_address: nullableText(row.server_address),
    server_port: canonicalInteger(row.server_port, 'server_port', { min: 1 }),
    server_version: nullableText(row.server_version),
  });
}

export function postgresIdentityFromRow(row = {}, extra = {}) {
  const stable = normalizePostgresIdentity(row);
  return Object.freeze({
    kind: 'postgres',
    ...extra,
    database: '[REDACTED]',
    host: '[REDACTED]',
    port: '[REDACTED]',
    database_identity_sha256: canonicalSha256(stable),
    server_identity_sha256: canonicalSha256({
      server_address: stable.server_address,
      server_port: stable.server_port,
      server_version: stable.server_version,
    }),
  });
}

export function postgresIdentityStable(value) {
  if (!value || typeof value !== 'object') throw new TypeError('PostgreSQL identity is required.');
  return normalizePostgresIdentity(value);
}
