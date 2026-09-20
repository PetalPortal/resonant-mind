import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { TARGET_SCHEMAS } from '../transform/target-schema.mjs';
import { V4_MIGRATION_LOCK_ID } from '../../migrate-postgres.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
const IMPORT_ORDER = Object.freeze([
  'people', 'nodes', 'entities', 'threads', 'context_entries', 'relational_state', 'identity', 'journals',
  'subconscious', 'tensions', 'observations', 'observation_versions', 'relations', 'consolidation_groups',
  'images', 'daemon_proposals', 'orphan_observations', 'co_surfacing',
]);
const REFERENCES = Object.freeze({
  observations: { entity_id: ['people', 'nodes', 'entities'], person_id: ['people'], node_id: ['nodes'], linked_observation_id: ['observations'], superseded_by: ['observations'], supersedes: ['observations'] },
  observation_versions: { observation_id: ['observations'] },
  images: { entity_id: ['people', 'nodes', 'entities'], person_id: ['people'], node_id: ['nodes'], observation_id: ['observations'] },
  consolidation_groups: { entity_id: ['people', 'nodes', 'entities'], person_id: ['people'], node_id: ['nodes'], consolidated_observation_id: ['observations'] },
  orphan_observations: { observation_id: ['observations'] },
  co_surfacing: { obs_a_id: ['observations'], obs_b_id: ['observations'] },
  daemon_proposals: { from_obs_id: ['observations'], to_obs_id: ['observations'], from_entity_id: ['people', 'nodes', 'entities'], to_entity_id: ['people', 'nodes', 'entities'] },
});
const SERIAL_TABLES = new Set(['people', 'nodes', 'entities', 'observations', 'observation_versions', 'relational_state', 'identity', 'journals', 'images', 'subconscious', 'daemon_proposals', 'orphan_observations', 'co_surfacing']);

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError('PostgreSQL identifier is not allowlisted.');
  return `"${value}"`;
}
function qtable(schema, table) { return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`; }
function refusal(code, phase, summary, safeDetails = {}) { return new MigrationRefusal({ code, phase, summary, safe_details: safeDetails, report_path: null }); }
function requireHash(value, label) { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`); }

async function query(client, text, values = []) {
  if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.');
  return client.query(text, values);
}

function identityFromRow(row) {
  const stable = {
    database_name: row.database_name ?? null,
    database_oid: String(row.database_oid ?? ''),
    server_address: row.server_address ?? null,
    server_port: String(row.server_port ?? ''),
    server_version: String(row.server_version ?? ''),
  };
  return {
    kind: 'postgres',
    database: '[REDACTED]',
    host: '[REDACTED]',
    port: '[REDACTED]',
    database_identity_sha256: canonicalSha256(stable),
    server_identity_sha256: canonicalSha256({ server_address: stable.server_address, server_port: stable.server_port, server_version: stable.server_version }),
  };
}

export const TARGET_IDENTITY_QUERY = `
  SELECT current_database() AS database_name,
         (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
         inet_server_addr()::text AS server_address,
         inet_server_port()::text AS server_port,
         current_setting('server_version_num') AS server_version
`;
export const TARGET_OBJECT_QUERY = `
  /* non_system_objects */
  SELECT count(c.oid)::text AS object_count,
         COALESCE(array_agg(DISTINCT n.nspname ORDER BY n.nspname) FILTER (WHERE n.nspname <> 'public'), ARRAY[]::text[]) AS schemas
  FROM pg_catalog.pg_namespace n
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
`;
export const TARGET_VECTOR_QUERY = `
  SELECT (EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'vector')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector')) AS available
`;

export async function readTargetIdentity({ client } = {}) {
  await query(client, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const readOnly = await query(client, 'SHOW transaction_read_only');
    if (String(readOnly.rows?.[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target identity read could not prove a read-only transaction.');
    const result = await query(client, TARGET_IDENTITY_QUERY);
    return identityFromRow(result.rows?.[0] ?? {});
  } finally { try { await query(client, 'ROLLBACK'); } catch { /* preserve the identity error */ } }
}

export async function inspectTarget({ client, sourceIdentity } = {}) {
  await query(client, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const readOnly = await query(client, 'SHOW transaction_read_only');
    if (String(readOnly.rows?.[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') {
      throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target preflight could not prove a read-only transaction.');
    }
    const identityResult = await query(client, TARGET_IDENTITY_QUERY);
    const targetIdentity = identityFromRow(identityResult.rows?.[0] ?? {});
    if (sourceIdentity?.database_identity_sha256 === targetIdentity.database_identity_sha256) {
      throw refusal('RMIG-E-SAME-SOURCE-TARGET', 'inspect-target', 'Source and target resolve to the same PostgreSQL database.');
    }
    const objectResult = await query(client, TARGET_OBJECT_QUERY);
    const objectRow = objectResult.rows?.[0] ?? {};
    const objectCount = Number(objectRow.object_count ?? 0);
    const schemas = Array.isArray(objectRow.schemas) ? objectRow.schemas.filter((name) => typeof name === 'string' && !SYSTEM_SCHEMAS.has(name)).sort() : [];
    if (!Number.isSafeInteger(objectCount) || objectCount !== 0 || schemas.length > 0) {
      throw refusal('RMIG-E-TARGET-NOT-FRESH', 'inspect-target', 'Target PostgreSQL database is not empty of user objects.', { object_count: Number.isSafeInteger(objectCount) ? objectCount : null, schemas });
    }
    const vectorResult = await query(client, TARGET_VECTOR_QUERY);
    if (vectorResult.rows?.[0]?.available !== true && String(vectorResult.rows?.[0]?.available).toLowerCase() !== 't') {
      throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target PostgreSQL database does not provide pgvector.');
    }
    return Object.freeze({ target_identity: targetIdentity, object_count: 0, schemas: [], pgvector: true, read_only_proven: true });
  } finally {
    try { await query(client, 'ROLLBACK'); } catch { /* preserve the refusal */ }
  }
}

function stagingName(migrationId, bundleHash) {
  const id = String(migrationId).replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 28);
  return `rmig_${id}_${bundleHash.slice(0, 16)}`.slice(0, 63);
}

async function stagePlan(client, schema, plan) {
  if (!plan || !plan.members) throw new TypeError('The staging plan must contain members.');
  if (plan.bundle_manifest_sha256 === undefined || plan.compiled_policy_sha256 === undefined) throw new TypeError('The staging plan must contain bound hashes.');
  const tables = [...new Set([...IMPORT_ORDER, ...Object.keys(plan.members)])];
  for (const table of tables) {
    const rows = plan.members[table] ?? [];
    if (rows.length === 0) continue;
    if (!TARGET_SCHEMAS[table]) throw new TypeError(`Unsupported staging table ${table}.`);
    await query(client, `CREATE TABLE IF NOT EXISTS ${qtable(schema, table)} (LIKE public.${quoteIdentifier(table)} INCLUDING DEFAULTS)`);
    for (const row of rows) {
      const insert = insertSql(table, row, schema);
      await query(client, insert.text, insert.values);
    }
  }
  await query(client, `UPDATE ${qtable(schema, 'run_metadata')} SET status = $1 WHERE migration_id = $2`, ['staged', plan.migration_id]);
}

async function createStaging(client, schema, fields) {
  await query(client, `CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await query(client, `REVOKE ALL ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC`);
  await query(client, `CREATE TABLE ${qtable(schema, 'run_metadata')} (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, status TEXT NOT NULL, receipt_sha256 TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(client, `INSERT INTO ${qtable(schema, 'run_metadata')} (migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, status) VALUES ($1, $2, $3, $4, $5)`, [fields.migrationId, fields.bundleManifestSha256, fields.compiledPolicySha256, fields.targetIdentitySha256, 'prepared']);
}

export async function prepareTarget({ client, migrationRunner, sourceIdentity, migrationId, bundleManifestSha256, compiledPolicySha256, resumeSchema, plan } = {}) {
  requireHash(bundleManifestSha256, 'bundleManifestSha256');
  requireHash(compiledPolicySha256, 'compiledPolicySha256');
  if (typeof migrationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(migrationId)) throw new TypeError('migrationId is invalid.');
  if (plan && (plan.bundle_manifest_sha256 !== bundleManifestSha256 || plan.compiled_policy_sha256 !== compiledPolicySha256 || plan.migration_id !== migrationId)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'The staging plan is not bound to the requested migration inputs.');
  const target = resumeSchema ? { target_identity: await readTargetIdentity({ client }) } : await inspectTarget({ client, sourceIdentity });
  const targetIdentity = target.target_identity ?? sourceIdentity;
  const targetIdentitySha256 = targetIdentity.database_identity_sha256;
  requireHash(targetIdentitySha256, 'target identity');
  const schema = resumeSchema ?? stagingName(migrationId, bundleManifestSha256);
  let created = false;
  try {
    if (resumeSchema) {
      const result = await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, status FROM ${qtable(schema, 'run_metadata')} WHERE migration_id = $1`, [migrationId]);
      const row = result.rows?.[0];
      if (!row || row.bundle_manifest_sha256 !== bundleManifestSha256 || row.compiled_policy_sha256 !== compiledPolicySha256 || row.target_identity_sha256 !== targetIdentitySha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'Existing staging metadata does not match the requested migration inputs.');
      return Object.freeze({ schema, target_identity: targetIdentity, status: row.status, resumed: true, hashes: { bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256 } });
    }
    await createStaging(client, schema, { migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256 });
    created = true;
    if (!migrationRunner || typeof migrationRunner.run !== 'function') throw new TypeError('prepareTarget requires the immutable v4 migration runner.');
    await migrationRunner.run();
    if (plan) await stagePlan(client, schema, plan);
    await query(client, `CREATE TABLE IF NOT EXISTS public.migration_import_receipts (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, receipt_sha256 TEXT NOT NULL, status TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    return Object.freeze({ schema, target_identity: targetIdentity, status: 'prepared', resumed: false, hashes: { bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256 } });
  } catch (error) {
    if (created) { try { await query(client, `DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`); } catch { /* do not hide the original failure */ } }
    throw error;
  }
}

function tableRows(plan) { return plan?.members && typeof plan.members === 'object' ? plan.members : {}; }
function tableHash(rows) { return canonicalSha256(rows); }
function idSet(rows) { return new Set((rows ?? []).map((row) => String(row.id))); }
function hasRef(plan, tables, value) { return tables.some((table) => idSet(plan.members?.[table]).has(String(value))); }

function validationFor(plan) {
  const members = tableRows(plan);
  const foreignKeys = [];
  for (const [table, fields] of Object.entries(REFERENCES)) for (const row of members[table] ?? []) for (const [field, targets] of Object.entries(fields)) {
    if (row[field] === null || row[field] === undefined) continue;
    if (!hasRef(plan, targets, row[field])) foreignKeys.push({ table, field, value: row[field], row_sha256: canonicalSha256(row) });
  }
  const uniqueness = [];
  const uniqueColumns = { co_surfacing: ['obs_a_id', 'obs_b_id'], orphan_observations: ['observation_id'] };
  for (const [table, rows] of Object.entries(members)) {
    const seen = new Set();
    for (const row of rows) {
      const keys = [];
      if (Object.hasOwn(row, 'id')) keys.push(['id', row.id]);
      if (uniqueColumns[table]) keys.push(['unique', uniqueColumns[table].map((field) => row[field])]);
      if (keys.length === 0) keys.push(['row', row]);
      for (const [kind, value] of keys) {
        const key = `${kind}:${canonicalJson(value)}`;
        if (seen.has(key)) uniqueness.push({ table, key, row_sha256: canonicalSha256(row) });
        seen.add(key);
      }
    }
  }
  const enums = [];
  for (const [table, rows] of Object.entries(members)) {
    const schema = TARGET_SCHEMAS[table];
    if (!schema) { enums.push({ table, reason: 'unsupported target table' }); continue; }
    for (const row of rows) for (const [field, allowed] of Object.entries(schema.checks ?? {})) if (row[field] !== undefined && row[field] !== null && !allowed.has(row[field])) enums.push({ table, field, value: row[field], row_sha256: canonicalSha256(row) });
    if (schema.kind) for (const row of rows) if (row.kind !== undefined && !schema.kind.has(row.kind)) enums.push({ table, field: 'kind', value: row.kind, row_sha256: canonicalSha256(row) });
  }
  return { foreign_keys: { violations: foreignKeys.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, uniqueness: { violations: uniqueness.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, enums: { violations: enums.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) } };
}

export function buildDryRunReport({ plan, targetIdentity } = {}) {
  if (!plan || !plan.members) throw new TypeError('A relational staging plan is required.');
  requireHash(plan.bundle_manifest_sha256, 'plan.bundle_manifest_sha256');
  requireHash(plan.compiled_policy_sha256, 'plan.compiled_policy_sha256');
  requireHash(targetIdentity?.database_identity_sha256, 'target identity');
  const members = tableRows(plan);
  const counts = { tables: {} };
  for (const table of Object.keys(members).sort()) {
    const coverage = plan.coverage?.[table] ?? {};
    counts.tables[table] = {
      source_rows: coverage.source_rows ?? members[table].length,
      transformed_rows: coverage.transformed_rows ?? coverage.mapped_rows ?? members[table].length,
      excluded_rows: coverage.excluded_rows ?? 0,
      rows: members[table].length,
      sha256: tableHash(members[table]),
    };
  }
  const losses = Array.isArray(plan.losses) ? plan.losses : [];
  const report = {
    format_version: 1,
    report_type: 'fresh-v4-dry-run',
    migration_id: plan.migration_id,
    bundle_manifest_sha256: plan.bundle_manifest_sha256,
    compiled_policy_sha256: plan.compiled_policy_sha256,
    target_identity_sha256: targetIdentity.database_identity_sha256,
    counts,
    validation: validationFor(plan),
    losses: { count: losses.length, sha256: canonicalSha256(losses), entries: losses },
  };
  report.receipt_sha256 = canonicalSha256(report);
  return Object.freeze(report);
}

function verifyDryRun(plan, dryRun, targetIdentity) {
  const expected = buildDryRunReport({ plan, targetIdentity });
  if (!dryRun || dryRun.receipt_sha256 !== expected.receipt_sha256 || canonicalJson(dryRun) !== canonicalJson(expected)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Dry-run receipt does not match the exact import inputs.');
  if (dryRun.validation.foreign_keys.violations.length || dryRun.validation.uniqueness.violations.length || dryRun.validation.enums.violations.length) throw refusal('RMIG-E-VALIDATION', 'Dry-run validation found rows that cannot be imported.');
}

function insertSql(table, row, schema = 'public') {
  const keys = Object.keys(row);
  if (!TARGET_SCHEMAS[table] || keys.length === 0) throw new TypeError(`Unsupported or empty row for target table ${table}.`);
  return { text: `INSERT INTO ${qtable(schema, table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${keys.map((_key, index) => `$${index + 1}`).join(', ')})`, values: keys.map((key) => row[key]) };
}

async function resetSequence(client, table) {
  if (!SERIAL_TABLES.has(table)) return;
  await query(client, `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM public.${quoteIdentifier(table)}`, [table, 'id']);
}

export async function importPlan({ client, plan, dryRun, targetIdentity, injectFailureAfter, stagingSchema } = {}) {
  verifyDryRun(plan, dryRun, targetIdentity);
  const receipt = dryRun.receipt_sha256;
  await query(client, 'BEGIN');
  try {
    await query(client, 'SELECT pg_advisory_xact_lock($1)', [V4_MIGRATION_LOCK_ID]);
    if (stagingSchema !== undefined) {
      const metadata = await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, status FROM ${qtable(stagingSchema, 'run_metadata')} WHERE migration_id = $1 FOR UPDATE`, [plan.migration_id]);
      const row = metadata.rows?.[0];
      if (!row || row.bundle_manifest_sha256 !== plan.bundle_manifest_sha256 || row.compiled_policy_sha256 !== plan.compiled_policy_sha256 || row.target_identity_sha256 !== targetIdentity.database_identity_sha256 || !['prepared', 'staged', 'dry-run'].includes(row.status)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staging metadata is not bound to the exact dry-run inputs.');
    }
    const existing = await query(client, 'SELECT migration_id, receipt_sha256, status FROM public.migration_import_receipts WHERE migration_id = $1 FOR UPDATE', [plan.migration_id]);
    if (existing.rows?.length) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'This migration has already been imported or has conflicting receipt metadata.');
    let inserted = 0;
    const members = tableRows(plan);
    for (const table of IMPORT_ORDER) {
      for (const row of members[table] ?? []) {
        const insert = insertSql(table, row);
        await query(client, insert.text, insert.values);
        inserted += 1;
        if (injectFailureAfter !== undefined && inserted >= injectFailureAfter) throw new Error('injected import failure for rollback proof');
      }
      await resetSequence(client, table);
    }
    await query(client, 'INSERT INTO public.migration_import_receipts (migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, receipt_sha256, status) VALUES ($1, $2, $3, $4, $5, $6)', [plan.migration_id, plan.bundle_manifest_sha256, plan.compiled_policy_sha256, targetIdentity.database_identity_sha256, receipt, 'complete']);
    await query(client, 'COMMIT');
    return Object.freeze({ migration_id: plan.migration_id, receipt_sha256: receipt, status: 'complete', inserted_rows: inserted });
  } catch (error) {
    try { await query(client, 'ROLLBACK'); } catch { /* preserve the import error */ }
    throw error;
  }
}

export function parseTargetIdentity(value) { return identityFromRow(value); }
export { IMPORT_ORDER };
