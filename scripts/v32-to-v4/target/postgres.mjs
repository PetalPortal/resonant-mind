import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { TARGET_SCHEMAS, assertTargetRow } from '../transform/target-schema.mjs';
import { V4_MIGRATION_LOCK_ID, V4_MIGRATOR_VERSION, migrationSetSha256, readV4Migrations } from '../../migrate-postgres.mjs';
import { postgresIdentityFromRow, normalizePostgresIdentity as normalizeIdentityRow } from '../lib/postgres-identity.mjs';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
export const IMPORT_ORDER = Object.freeze(['entities', 'people', 'nodes', 'threads', 'context_entries', 'relational_state', 'identity', 'journals', 'subconscious', 'tensions', 'observations', 'observation_versions', 'relations', 'consolidation_groups', 'images', 'daemon_proposals', 'orphan_observations', 'co_surfacing']);
const SELF_REFERENCE_FIELDS = Object.freeze(['linked_observation_id', 'superseded_by', 'supersedes']);
const REFERENCES = Object.freeze({
  observations: { entity_id: ['entities'], person_id: ['people'], node_id: ['nodes'], linked_observation_id: ['observations'], superseded_by: ['observations'], supersedes: ['observations'] },
  observation_versions: { observation_id: ['observations'] },
  images: { entity_id: ['entities'], person_id: ['people'], node_id: ['nodes'], observation_id: ['observations'] },
  consolidation_groups: { entity_id: ['entities'], person_id: ['people'], node_id: ['nodes'], consolidated_observation_id: ['observations'], source_observation_ids: ['observations'] },
  orphan_observations: { observation_id: ['observations'] },
  co_surfacing: { obs_a_id: ['observations'], obs_b_id: ['observations'] },
  daemon_proposals: { from_obs_id: ['observations'], to_obs_id: ['observations'], from_entity_id: ['entities'], to_entity_id: ['entities'] },
  thread_entities: { thread_id: ['threads'], entity_id: ['entities'] },
});
const SERIAL_TABLES = new Set(['entities', 'people', 'nodes', 'observations', 'observation_versions', 'relational_state', 'identity', 'journals', 'images', 'subconscious', 'daemon_proposals', 'orphan_observations', 'co_surfacing']);

function quoteIdentifier(value) { if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new TypeError('PostgreSQL identifier is not allowlisted.'); return `"${value}"`; }
function qtable(schema, table) { return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`; }
function refusal(code, phase, summary, safeDetails = {}) { return new MigrationRefusal({ code, phase, summary, safe_details: safeDetails, report_path: null }); }
function requireHash(value, label) { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`); }
async function query(client, text, values = []) { if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.'); return client.query(text, values); }

export function normalizePostgresIdentity(row) { return normalizePostgresIdentityRow(row); }
function normalizePostgresIdentityRow(row) { return normalizeIdentityRow(row); }
function identityFromRow(row) { return postgresIdentityFromRow(row); }

export const TARGET_IDENTITY_QUERY = `
  SELECT current_database() AS database_name,
         (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
         inet_server_addr()::text AS server_address,
         inet_server_port()::text AS server_port,
         current_setting('server_version_num') AS server_version
`;
export const TARGET_OBJECT_QUERY = `
  /* non_system_objects */
  WITH app_objects AS (
    SELECT n.nspname AS schema_name, c.relname AS object_name, 'relation' AS object_kind
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid WHERE d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT n.nspname, p.proname, 'routine'
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_proc p ON p.pronamespace = n.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid WHERE d.objid = p.oid AND d.deptype = 'e')
    UNION ALL
    SELECT n.nspname, t.typname, 'type'
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_type t ON t.typnamespace = n.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND t.typrelid = 0 AND t.typtype IN ('c', 'd', 'e')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid WHERE d.objid = t.oid AND d.deptype = 'e')
  )
  SELECT count(*)::text AS object_count,
         COALESCE(array_agg(DISTINCT schema_name ORDER BY schema_name), ARRAY[]::text[]) AS schemas,
         COALESCE(jsonb_agg(jsonb_build_object('schema', schema_name, 'name', object_name, 'kind', object_kind) ORDER BY schema_name, object_kind, object_name), '[]'::jsonb) AS objects
  FROM app_objects
`;
export const TARGET_VECTOR_QUERY = `SELECT (EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'vector') OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector')) AS available`;
export const TARGET_STATE_QUERY = `
  /* target_state */
  SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind AS object_kind
  FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ORDER BY c.relkind, c.relname
`;

async function readIdentityInTransaction(client) { const result = await query(client, TARGET_IDENTITY_QUERY); return identityFromRow(result.rows?.[0] ?? {}); }
export async function readTargetIdentity({ client } = {}) {
  await query(client, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { const readOnly = await query(client, 'SHOW transaction_read_only'); if (String(readOnly.rows?.[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target identity read could not prove a read-only transaction.'); return await readIdentityInTransaction(client); }
  finally { try { await query(client, 'ROLLBACK'); } catch { /* preserve identity error */ } }
}

export async function readTargetState({ client } = {}) {
  const catalog = await query(client, TARGET_STATE_QUERY);
  const rows = (catalog.rows ?? []).map((row) => ({ schema_name: row.schema_name, object_name: row.object_name, object_kind: row.object_kind }));
  const tables = rows.filter((row) => ['r', 'p'].includes(row.object_kind));
  const counts = [];
  for (const table of tables) {
    const count = await query(client, `SELECT count(*)::text AS row_count FROM ${qtable(table.schema_name, table.object_name)}`);
    counts.push({ ...table, row_count: String(count.rows?.[0]?.row_count ?? '0') });
  }
  return Object.freeze({ objects: rows, counts: counts.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) });
}

export async function inspectTarget({ client, sourceIdentity } = {}) {
  await query(client, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const readOnly = await query(client, 'SHOW transaction_read_only');
    if (String(readOnly.rows?.[0]?.transaction_read_only ?? '').toLowerCase() !== 'on') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target preflight could not prove a read-only transaction.');
    const targetIdentity = await readIdentityInTransaction(client);
    if (sourceIdentity?.database_identity_sha256 === targetIdentity.database_identity_sha256) throw refusal('RMIG-E-SAME-SOURCE-TARGET', 'inspect-target', 'Source and target resolve to the same PostgreSQL database.');
    const objectResult = await query(client, TARGET_OBJECT_QUERY);
    const objectRow = objectResult.rows?.[0] ?? {};
    const objectCount = Number(objectRow.object_count ?? 0);
    const schemas = Array.isArray(objectRow.schemas) ? objectRow.schemas.filter((name) => typeof name === 'string' && !SYSTEM_SCHEMAS.has(name)).sort() : [];
    if (!Number.isSafeInteger(objectCount) || objectCount !== 0 || schemas.length > 0) throw refusal('RMIG-E-TARGET-NOT-FRESH', 'inspect-target', 'Target PostgreSQL database has user relations, sequences, types, routines, or other application objects. Required extensions are ignored.', { object_count: Number.isSafeInteger(objectCount) ? objectCount : null, schemas });
    const vectorResult = await query(client, TARGET_VECTOR_QUERY);
    if (vectorResult.rows?.[0]?.available !== true && String(vectorResult.rows?.[0]?.available).toLowerCase() !== 't') throw refusal('RMIG-E-TARGET-SCHEMA', 'inspect-target', 'Target PostgreSQL database does not provide pgvector.');
    return Object.freeze({ target_identity: targetIdentity, object_count: 0, schemas: [], pgvector: true, read_only_proven: true });
  } finally { try { await query(client, 'ROLLBACK'); } catch { /* preserve refusal */ } }
}

function stagingName(migrationId, bundleHash) { const id = String(migrationId).replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 28); return `rmig_${id}_${bundleHash.slice(0, 16)}`.slice(0, 63); }
function stageContentSha256(members) { return canonicalSha256(Object.fromEntries(Object.entries(members ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([table, rows]) => [table, rows ?? []]))); }
function planSha256(plan) { const { plan_sha256: _ignored, ...body } = plan; return canonicalSha256(body); }
function stageMetadataFields({ migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256, migrationSetSha256: setHash, migratorVersion, planSha256: hash, stageContentSha256: contentHash }) { return [migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256, setHash, migratorVersion, hash, contentHash, 'prepared']; }

function insertSql(table, row, schema = 'public') {
  const keys = Object.keys(row);
  if (!TARGET_SCHEMAS[table] || keys.length === 0) throw new TypeError(`Unsupported or empty row for target table ${table}.`);
  return { text: `INSERT INTO ${qtable(schema, table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${keys.map((_key, index) => `$${index + 1}`).join(', ')})`, values: keys.map((key) => row[key]) };
}

async function createStaging(client, schemaName, fields) {
  await query(client, `CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await query(client, `REVOKE ALL ON SCHEMA ${quoteIdentifier(schemaName)} FROM PUBLIC`);
  await query(client, `CREATE TABLE ${qtable(schemaName, 'run_metadata')} (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, migration_set_sha256 TEXT NOT NULL, migrator_version TEXT NOT NULL, plan_sha256 TEXT NOT NULL, stage_content_sha256 TEXT NOT NULL, dry_run_receipt_sha256 TEXT, target_state_sha256 TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(client, `INSERT INTO ${qtable(schemaName, 'run_metadata')} (migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, stageMetadataFields(fields));
}

async function stagePlan(client, schemaName, plan, fields) {
  if (!plan || !plan.members) throw new TypeError('The staging plan must contain members.');
  if (plan.bundle_manifest_sha256 !== fields.bundleManifestSha256 || plan.compiled_policy_sha256 !== fields.compiledPolicySha256 || plan.migration_id !== fields.migrationId) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'The staging plan is not bound to the requested migration inputs.');
  if (plan.plan_sha256 !== undefined && plan.plan_sha256 !== planSha256(plan)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'The staging plan hash is invalid.');
  const members = plan.members;
  const contentHash = stageContentSha256(members);
  for (const table of Object.keys(members).sort()) {
    if (!TARGET_SCHEMAS[table]) throw new TypeError(`Unsupported staging table ${table}.`);
    await query(client, `DROP TABLE IF EXISTS ${qtable(schemaName, table)}`);
    await query(client, `CREATE TABLE ${qtable(schemaName, table)} (LIKE public.${quoteIdentifier(table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    for (const row of members[table] ?? []) {
      assertTargetRow(table, row);
      const physicalRow = table === 'identity' && row.kind === undefined ? { ...row, kind: String(row.section).split('.')[0].replace(/[^a-z0-9_]+/giu, '_').toLowerCase() } : row;
      const insert = insertSql(table, physicalRow, schemaName);
      await query(client, insert.text, insert.values);
    }
  }
  await query(client, `DROP TABLE IF EXISTS ${qtable(schemaName, 'run_rows')}`);
  await query(client, `CREATE TABLE ${qtable(schemaName, 'run_rows')} (table_name TEXT NOT NULL, row_index INTEGER NOT NULL, row_json JSONB NOT NULL, row_sha256 TEXT NOT NULL, PRIMARY KEY (table_name, row_index))`);
  for (const table of Object.keys(members).sort()) for (const [index, row] of (members[table] ?? []).entries()) await query(client, `INSERT INTO ${qtable(schemaName, 'run_rows')} (table_name, row_index, row_json, row_sha256) VALUES ($1, $2, $3::jsonb, $4)`, [table, index, canonicalJson(row), canonicalSha256(row)]);
  await query(client, `UPDATE ${qtable(schemaName, 'run_metadata')} SET plan_sha256 = $1, stage_content_sha256 = $2, status = $3, updated_at = NOW() WHERE migration_id = $4`, [planSha256(plan), contentHash, 'staged', fields.migrationId]);
  return { plan_sha256: planSha256(plan), stage_content_sha256: contentHash };
}

async function readStagedMembers(client, schemaName, tables) {
  const result = await query(client, `SELECT table_name, row_index, row_json, row_sha256 FROM ${qtable(schemaName, 'run_rows')} ORDER BY table_name, row_index`);
  const members = {};
  for (const row of result.rows ?? []) {
    const value = typeof row.row_json === 'string' ? JSON.parse(row.row_json) : row.row_json;
    if (row.row_sha256 !== canonicalSha256(value)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staged row content hash is invalid.');
    (members[row.table_name] ??= []).push(value);
  }
  for (const table of tables) members[table] ??= [];
  return members;
}

async function ledgerBinding(client) {
  const migrations = await readV4Migrations();
  const result = await query(client, 'SELECT version, checksum FROM public.schema_migrations ORDER BY version');
  const rows = result.rows ?? [];
  const expected = new Map(migrations.map(({ file, checksum }) => [file, checksum]));
  if (rows.length !== migrations.length || rows.some((row) => expected.get(row.version) !== row.checksum)) throw refusal('RMIG-E-TARGET-SCHEMA', 'prepare-target', 'Target v4 ledger is not the exact current migration checksum set.');
  return { migration_set_sha256: migrationSetSha256(migrations), migrator_version: V4_MIGRATOR_VERSION, migrations };
}

export async function prepareTarget({ client, migrationRunner, sourceIdentity, migrationId, bundleManifestSha256, compiledPolicySha256, resumeSchema, plan } = {}) {
  requireHash(bundleManifestSha256, 'bundleManifestSha256'); requireHash(compiledPolicySha256, 'compiledPolicySha256');
  if (typeof migrationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(migrationId)) throw new TypeError('migrationId is invalid.');
  const target = resumeSchema ? { target_identity: await readTargetIdentity({ client }) } : await inspectTarget({ client, sourceIdentity });
  const targetIdentity = target.target_identity ?? sourceIdentity; requireHash(targetIdentity.database_identity_sha256, 'target identity');
  const schemaName = resumeSchema ?? stagingName(migrationId, bundleManifestSha256);
  const metadata = resumeSchema ? await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, status FROM ${qtable(schemaName, 'run_metadata')} WHERE migration_id = $1`, [migrationId]) : null;
  if (resumeSchema) {
    const row = metadata?.rows?.[0];
    if (!row || row.bundle_manifest_sha256 !== bundleManifestSha256 || row.compiled_policy_sha256 !== compiledPolicySha256 || row.target_identity_sha256 !== targetIdentity.database_identity_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'Existing staging metadata does not match the requested migration inputs.');
    const ledger = await ledgerBinding(client);
    if (row.migration_set_sha256 !== ledger.migration_set_sha256 || row.migrator_version !== ledger.migrator_version) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'prepare-target', 'Existing staging metadata is not bound to the current v4 runner.');
    await query(client, `CREATE TABLE IF NOT EXISTS public.migration_import_receipts (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, migration_set_sha256 TEXT NOT NULL, migrator_version TEXT NOT NULL, plan_sha256 TEXT NOT NULL, stage_content_sha256 TEXT NOT NULL, target_state_sha256 TEXT NOT NULL, receipt_sha256 TEXT NOT NULL, status TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    if (plan) await stagePlan(client, schemaName, plan, { migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256: targetIdentity.database_identity_sha256, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version });
    return Object.freeze({ schema: schemaName, target_identity: targetIdentity, status: plan ? 'staged' : row.status, resumed: true, hashes: { bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256, migration_set_sha256: ledger.migration_set_sha256, migrator_version: ledger.migrator_version } });
  }
  if (!migrationRunner || typeof migrationRunner.run !== 'function') throw new TypeError('prepareTarget requires the immutable v4 migration runner.');
  const migrations = await readV4Migrations();
  const ledger = { migration_set_sha256: migrationSetSha256(migrations), migrator_version: V4_MIGRATOR_VERSION };
  const planHash = plan ? planSha256(plan) : canonicalSha256({ migrationId });
  const contentHash = plan ? stageContentSha256(plan.members) : canonicalSha256({});
  let created = false; let runnerCompleted = false;
  try {
    await createStaging(client, schemaName, { migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256: targetIdentity.database_identity_sha256, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version, planSha256: planHash, stageContentSha256: contentHash });
    created = true;
    await migrationRunner.run({ atomic: true });
    runnerCompleted = true;
    await ledgerBinding(client);
    await query(client, `CREATE TABLE IF NOT EXISTS public.migration_import_receipts (migration_id TEXT PRIMARY KEY, bundle_manifest_sha256 TEXT NOT NULL, compiled_policy_sha256 TEXT NOT NULL, target_identity_sha256 TEXT NOT NULL, migration_set_sha256 TEXT NOT NULL, migrator_version TEXT NOT NULL, plan_sha256 TEXT NOT NULL, stage_content_sha256 TEXT NOT NULL, target_state_sha256 TEXT NOT NULL, receipt_sha256 TEXT NOT NULL, status TEXT NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    if (plan) await stagePlan(client, schemaName, plan, { migrationId, bundleManifestSha256, compiledPolicySha256, targetIdentitySha256: targetIdentity.database_identity_sha256, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version });
    return Object.freeze({ schema: schemaName, target_identity: targetIdentity, status: plan ? 'staged' : 'prepared', resumed: false, hashes: { bundle_manifest_sha256: bundleManifestSha256, compiled_policy_sha256: compiledPolicySha256, migration_set_sha256: ledger.migration_set_sha256, migrator_version: ledger.migrator_version } });
  } catch (error) {
    // The runner is atomic. If it completed, retain the hash-bound staging
    // schema so resumeSchema is a supported path; otherwise remove our schema.
    if (created && !runnerCompleted) { try { await query(client, `DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`); } catch { /* preserve original failure */ } }
    throw error;
  }
}

function tableRows(plan) { return plan?.members && typeof plan.members === 'object' ? plan.members : {}; }
function idSet(rows) { return new Set((rows ?? []).map((row) => String(row.id))); }
function hasRef(plan, tables, value) { return tables.some((table) => idSet(plan.members?.[table]).has(String(value))); }
function validationFor(plan) {
  const members = tableRows(plan); const foreignKeys = []; const uniqueness = []; const enums = [];
  for (const [table, fields] of Object.entries(REFERENCES)) for (const row of members[table] ?? []) for (const [field, targets] of Object.entries(fields)) {
    const values = field === 'source_observation_ids' ? (row[field] ?? []) : [row[field]];
    for (const value of values) if (value !== null && value !== undefined && !hasRef(plan, targets, value)) foreignKeys.push({ table, field, value, row_sha256: canonicalSha256(row) });
  }
  const uniqueColumns = { co_surfacing: ['obs_a_id', 'obs_b_id'], orphan_observations: ['observation_id'], thread_entities: ['thread_id', 'entity_id', 'role'] };
  for (const [table, rows] of Object.entries(members)) {
    const seen = new Set();
    for (const row of rows) {
      const keys = [];
      if (Object.hasOwn(row, 'id')) keys.push(['id', row.id]);
      if (uniqueColumns[table]) keys.push(['unique', uniqueColumns[table].map((field) => row[field])]);
      for (const [kind, value] of keys) { const key = `${kind}:${canonicalJson(value)}`; if (seen.has(key)) uniqueness.push({ table, key, row_sha256: canonicalSha256(row) }); seen.add(key); }
    }
    const target = TARGET_SCHEMAS[table];
    if (!target) { enums.push({ table, reason: 'unsupported target table' }); continue; }
    for (const row of rows) {
      try { assertTargetRow(table, row); } catch (error) { enums.push({ table, reason: error.message, row_sha256: canonicalSha256(row) }); }
    }
  }
  return { foreign_keys: { violations: foreignKeys.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, uniqueness: { violations: uniqueness.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }, enums: { violations: enums.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) } };
}

export function validateRelationalPlan(plan) { return validationFor(plan); }

export function buildDryRunReport({ plan, targetIdentity, migrationSetSha256: setHash, migratorVersion = V4_MIGRATOR_VERSION, stageContentSha256: contentHash, targetStateSha256: stateHash, status = 'validated' } = {}) {
  if (!plan || !plan.members) throw new TypeError('A relational staging plan is required.');
  requireHash(plan.bundle_manifest_sha256, 'plan.bundle_manifest_sha256'); requireHash(plan.compiled_policy_sha256, 'plan.compiled_policy_sha256'); requireHash(targetIdentity?.database_identity_sha256, 'target identity');
  const members = tableRows(plan); const counts = { tables: {} };
  for (const table of Object.keys(members).sort()) { const coverage = plan.coverage?.[table] ?? {}; counts.tables[table] = { source_rows: coverage.source_rows ?? members[table].length, transformed_rows: coverage.transformed_rows ?? coverage.mapped_rows ?? members[table].length, excluded_rows: coverage.excluded_rows ?? 0, rows: members[table].length, sha256: canonicalSha256(members[table]) }; }
  const losses = Array.isArray(plan.losses) ? plan.losses : [];
  const report = { format_version: 1, report_type: 'fresh-v4-dry-run', status, migration_id: plan.migration_id, bundle_manifest_sha256: plan.bundle_manifest_sha256, compiled_policy_sha256: plan.compiled_policy_sha256, migration_set_sha256: setHash ?? plan.migration_set_sha256 ?? null, migrator_version: migratorVersion, plan_sha256: plan.plan_sha256 ?? planSha256(plan), stage_content_sha256: contentHash ?? stageContentSha256(members), target_identity_sha256: targetIdentity.database_identity_sha256, target_state_sha256: stateHash ?? null, counts, validation: validationFor(plan), losses: { count: losses.length, sha256: canonicalSha256(losses), entries: losses } };
  report.receipt_sha256 = canonicalSha256(report); return Object.freeze(report);
}

function verifyDryRun(plan, dryRun, targetIdentity) {
  if (!dryRun || dryRun.status !== 'validated' || !dryRun.migration_set_sha256 || !dryRun.migrator_version || !dryRun.plan_sha256 || !dryRun.stage_content_sha256 || !dryRun.target_state_sha256) throw refusal('RMIG-E-DRY-RUN', 'import', 'Import requires a successful bound PostgreSQL dry-run receipt.');
  const expected = buildDryRunReport({ plan, targetIdentity, migrationSetSha256: dryRun.migration_set_sha256, migratorVersion: dryRun.migrator_version, stageContentSha256: dryRun.stage_content_sha256, targetStateSha256: dryRun.target_state_sha256, status: 'validated' });
  if (dryRun.receipt_sha256 !== expected.receipt_sha256 || canonicalJson(dryRun) !== canonicalJson(expected)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Dry-run receipt does not match the exact import inputs.');
  if (dryRun.validation.foreign_keys.violations.length || dryRun.validation.uniqueness.violations.length || dryRun.validation.enums.violations.length) throw refusal('RMIG-E-VALIDATION', 'Dry-run validation found rows that cannot be imported.');
}

function compatibilityCheck(members) {
  const entities = members.entities ?? []; if (entities.length === 0) throw refusal('RMIG-E-ENTITY-COMPAT', 'Fresh-v4 import requires public.entities compatibility rows for released foreign keys and routing triggers.');
  const routed = [...(members.people ?? []), ...(members.nodes ?? [])];
  for (const entity of entities) {
    const matches = routed.filter((row) => String(row.id) === String(entity.id));
    if (matches.length !== 1 || matches[0].name !== entity.name || matches[0].kind !== entity.entity_type) throw refusal('RMIG-E-ENTITY-COMPAT', 'Entity compatibility and people/nodes routing rows disagree.');
  }
}

async function insertRows(client, table, rows) {
  const deferred = [];
  for (const row of rows) {
    assertTargetRow(table, row);
    const initial = { ...row };
    if (table === 'observations') for (const field of SELF_REFERENCE_FIELDS) { if (Object.hasOwn(initial, field)) deferred.push({ id: initial.id, field, value: initial[field] }); delete initial[field]; }
    const insert = insertSql(table, initial); await query(client, insert.text, insert.values);
  }
  for (const item of deferred) await query(client, `UPDATE public.${quoteIdentifier(table)} SET ${quoteIdentifier(item.field)} = $1 WHERE id = $2`, [item.value, item.id]);
  return rows.length;
}
async function resetSequence(client, table) { if (!SERIAL_TABLES.has(table)) return; await query(client, `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM public.${quoteIdentifier(table)}`, [`public.${table}`, 'id']); }

async function validateOnTarget(client, members) {
  await query(client, 'BEGIN');
  try {
    await query(client, 'SELECT pg_advisory_xact_lock($1)', [V4_MIGRATION_LOCK_ID]);
    compatibilityCheck(members);
    let inserted = 0;
    for (const table of IMPORT_ORDER) {
      if (table === 'people' || table === 'nodes') continue; // entities trigger exactly one routed compatibility row
      inserted += await insertRows(client, table, members[table] ?? []);
    }
    await query(client, 'ROLLBACK');
    return inserted;
  } catch (error) { try { await query(client, 'ROLLBACK'); } catch { /* preserve validation error */ } throw error; }
}

export async function dryRunStaging({ client, plan, stagingSchema, targetIdentity } = {}) {
  if (typeof stagingSchema !== 'string' || !IDENTIFIER.test(stagingSchema)) throw refusal('RMIG-E-DRY-RUN-REQUIRED', 'dry-run', 'Dry-run requires an allowlisted staging schema.');
  const metadata = await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, status FROM ${qtable(stagingSchema, 'run_metadata')} WHERE migration_id = $1`, [plan.migration_id]);
  const row = metadata.rows?.[0];
  if (!row || row.bundle_manifest_sha256 !== plan.bundle_manifest_sha256 || row.compiled_policy_sha256 !== plan.compiled_policy_sha256 || row.target_identity_sha256 !== targetIdentity.database_identity_sha256 || !['staged', 'prepared'].includes(row.status)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'dry-run', 'Staging metadata is not bound to the exact plan and target.');
  const members = await readStagedMembers(client, stagingSchema, Object.keys(plan.members));
  if (stageContentSha256(members) !== row.stage_content_sha256 || stageContentSha256(members) !== stageContentSha256(plan.members)) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'dry-run', 'Staged content does not cryptographically match the plan.');
  const state = await readTargetState({ client }); const stateHash = canonicalSha256(state);
  await validateOnTarget(client, members);
  const ledger = await ledgerBinding(client);
  const stagedPlan = { ...plan, members, migration_set_sha256: row.migration_set_sha256, migrator_version: row.migrator_version, plan_sha256: row.plan_sha256 };
  const report = buildDryRunReport({ plan: stagedPlan, targetIdentity, migrationSetSha256: ledger.migration_set_sha256, migratorVersion: ledger.migrator_version, stageContentSha256: row.stage_content_sha256, targetStateSha256: stateHash, status: 'validated' });
  await query(client, `UPDATE ${qtable(stagingSchema, 'run_metadata')} SET status = $1, dry_run_receipt_sha256 = $2, target_state_sha256 = $3, updated_at = NOW() WHERE migration_id = $4`, ['dry-run', report.receipt_sha256, stateHash, plan.migration_id]);
  return report;
}

export async function importPlan({ client, plan, dryRun, targetIdentity, stagingSchema, injectFailureAfter } = {}) {
  if (typeof stagingSchema !== 'string' || !IDENTIFIER.test(stagingSchema)) throw refusal('RMIG-E-DRY-RUN-REQUIRED', 'import', 'Import requires the validated staging schema; direct plan bypass is disabled.');
  verifyDryRun(plan, dryRun, targetIdentity);
  await query(client, 'BEGIN');
  try {
    await query(client, 'SELECT pg_advisory_xact_lock($1)', [V4_MIGRATION_LOCK_ID]);
    const currentIdentity = await readIdentityInTransaction(client);
    if (currentIdentity.database_identity_sha256 !== targetIdentity.database_identity_sha256 || currentIdentity.database_identity_sha256 !== dryRun.target_identity_sha256) throw refusal('RMIG-E-TARGET-CHANGED', 'import', 'Target identity changed since the dry run.');
    const currentStateHash = canonicalSha256(await readTargetState({ client }));
    if (currentStateHash !== dryRun.target_state_sha256) throw refusal('RMIG-E-TARGET-CHANGED', 'import', 'Target public objects or row counts changed since the dry run.');
    const ledger = await ledgerBinding(client);
    const metadata = await query(client, `SELECT migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, dry_run_receipt_sha256, target_state_sha256, status FROM ${qtable(stagingSchema, 'run_metadata')} WHERE migration_id = $1 FOR UPDATE`, [plan.migration_id]);
    const row = metadata.rows?.[0];
    const metadataMismatches = !row ? ['metadata'] : [
      ['bundle_manifest_sha256', row.bundle_manifest_sha256, plan.bundle_manifest_sha256],
      ['compiled_policy_sha256', row.compiled_policy_sha256, plan.compiled_policy_sha256],
      ['target_identity_sha256', row.target_identity_sha256, targetIdentity.database_identity_sha256],
      ['migration_set_sha256', row.migration_set_sha256, ledger.migration_set_sha256],
      ['migrator_version', row.migrator_version, ledger.migrator_version],
      ['dry_run_receipt_sha256', row.dry_run_receipt_sha256, dryRun.receipt_sha256],
      ['target_state_sha256', row.target_state_sha256, dryRun.target_state_sha256],
      ['status', row.status, 'dry-run'],
      ['plan_sha256', row.plan_sha256, plan.plan_sha256 ?? planSha256(plan)],
      ['stage_content_sha256', row.stage_content_sha256, dryRun.stage_content_sha256],
    ].filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
    if (metadataMismatches.length) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staging metadata is not bound to the exact successful dry-run receipt.', { fields: metadataMismatches });
    const existing = await query(client, 'SELECT migration_id, receipt_sha256, status FROM public.migration_import_receipts WHERE migration_id = $1 FOR UPDATE', [plan.migration_id]);
    if (existing.rows?.length) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'This migration already has an import receipt; exact-once import refuses a rerun.');
    const members = await readStagedMembers(client, stagingSchema, Object.keys(plan.members));
    if (stageContentSha256(members) !== dryRun.stage_content_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staged content changed after dry-run.');
    const stagedPlan = { ...plan, members, plan_sha256: row.plan_sha256, migration_set_sha256: row.migration_set_sha256 };
    if (planSha256(stagedPlan) !== row.plan_sha256) throw refusal('RMIG-E-RECEIPT-MISMATCH', 'import', 'Staged plan hash does not match run metadata.');
    compatibilityCheck(members);
    let inserted = 0;
    for (const table of IMPORT_ORDER) {
      if (table === 'people' || table === 'nodes') continue;
      inserted += await insertRows(client, table, members[table] ?? []);
      await resetSequence(client, table);
      if (injectFailureAfter !== undefined && inserted >= injectFailureAfter) throw new Error('injected import failure for rollback proof');
    }
    await query(client, 'INSERT INTO public.migration_import_receipts (migration_id, bundle_manifest_sha256, compiled_policy_sha256, target_identity_sha256, migration_set_sha256, migrator_version, plan_sha256, stage_content_sha256, target_state_sha256, receipt_sha256, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [plan.migration_id, plan.bundle_manifest_sha256, plan.compiled_policy_sha256, targetIdentity.database_identity_sha256, row.migration_set_sha256, row.migrator_version, row.plan_sha256, row.stage_content_sha256, row.target_state_sha256, dryRun.receipt_sha256, 'complete']);
    await query(client, `UPDATE ${qtable(stagingSchema, 'run_metadata')} SET status = $1, updated_at = NOW() WHERE migration_id = $2`, ['complete', plan.migration_id]);
    await query(client, 'COMMIT');
    return Object.freeze({ migration_id: plan.migration_id, receipt_sha256: dryRun.receipt_sha256, status: 'complete', inserted_rows: inserted });
  } catch (error) { try { await query(client, 'ROLLBACK'); } catch { /* preserve import error */ } throw error; }
}

export function parseTargetIdentity(value) { return identityFromRow(value); }
export { TARGET_SCHEMAS };
