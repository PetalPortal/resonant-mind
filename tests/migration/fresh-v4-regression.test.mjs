import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { applyV4Migrations, readV4Migrations, migrationSetSha256, V4_MIGRATOR_VERSION } from '../../scripts/migrate-postgres.mjs';
import { buildIdMaps } from '../../scripts/v32-to-v4/transform/id-map.mjs';
import { assertTargetRow, TARGET_SCHEMAS } from '../../scripts/v32-to-v4/transform/target-schema.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import {
  buildDryRunReport,
  bindRelationalPlan,
  importPlan,
  normalizePostgresIdentity,
  inspectTarget,
  parseTargetIdentity,
  prepareTarget,
  validateRelationalPlan,
  resetSequence,
} from '../../scripts/v32-to-v4/target/postgres.mjs';

const HASH = 'a'.repeat(64);
const PLAN = {
  format_version: 1,
  plan_type: 'relational-staging',
  migration_id: 'rmig_regression_v4',
  bundle_manifest_sha256: HASH,
  compiled_policy_sha256: 'b'.repeat(64),
  migration_set_sha256: 'c'.repeat(64),
  migrator_version: '4.0.1',
  members: {
    entities: [{ id: 1, name: 'Alice', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' }],
    people: [{ id: 1, name: 'Alice', kind: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' }],
    observations: [{ id: 4, entity_id: 1, person_id: 1, content: 'hello', linked_observation_id: 5 }],
  },
  coverage: {},
  losses: [],
};
const TARGET = parseTargetIdentity({
  database_name: 'mind', database_oid: 42, server_address: null, server_port: 5432, server_version: 160000,
});

function fakeClient(responses = []) {
  const calls = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      const match = responses.find((item) => item.when instanceof RegExp ? item.when.test(text) : item.when === text);
      if (match?.throw) throw match.throw;
      return match?.result ?? { rows: [], rowCount: 0 };
    },
  };
}

describe('fresh-v4 review regressions', () => {
  it('canonicalizes numeric and string ports and preserves a null socket address', () => {
    const numeric = normalizePostgresIdentity({ database_name: 'mind', database_oid: 42, server_address: null, server_port: 5432, server_version: 160000 });
    const textual = normalizePostgresIdentity({ database_name: 'mind', database_oid: '42', server_address: null, server_port: '5432', server_version: '160000' });
    expect(numeric).toEqual(textual);
    expect(numeric.server_port).toBe(5432);
    expect(numeric.server_address).toBeNull();
    expect(parseTargetIdentity(numeric).database_identity_sha256).toBe(parseTargetIdentity(textual).database_identity_sha256);
  });

  it('models released compatibility entities and does not model the removed charge_note column', () => {
    expect(TARGET_SCHEMAS.entities.columns).toMatchObject({ id: 'integer', entity_type: 'text', affect_n: 'integer' });
    expect(TARGET_SCHEMAS.observations.columns).not.toHaveProperty('charge_note');
    expect(TARGET_SCHEMAS.entities.columns).not.toHaveProperty('kind');
  });

  it('transforms an entity into compatibility and routed rows with matching identity', () => {
    const source = { entities: [{ id: 1, name: 'Alice', entity_type: 'person', primary_context: 'default', salience: 'active' }] };
    const idMaps = buildIdMaps(source, { items: [] });
    const plan = transformRelational({
      tables: source,
      compiledPolicy: { id_map: idMaps.idMap, name_map: idMaps.serializedNames, mapping_tables: ['entities'], losses: [] },
      migrationId: PLAN.migration_id,
      bundleManifestSha256: HASH,
      compiledPolicySha256: 'b'.repeat(64),
    });
    expect(plan.members.entities).toEqual([expect.objectContaining({ id: 1, entity_type: 'person' })]);
    expect(plan.members.people).toEqual([expect.objectContaining({ id: 1, kind: 'person' })]);
    assertTargetRow('entities', plan.members.entities[0]);
  });

  it('builds a receipt with plan, migration, runner, stage, and target-state bindings', () => {
    const report = buildDryRunReport({
      plan: PLAN,
      targetIdentity: TARGET,
      migrationSetSha256: PLAN.migration_set_sha256,
      migratorVersion: PLAN.migrator_version,
      stageContentSha256: canonicalSha256(PLAN.members),
      targetStateSha256: HASH,
      status: 'validated',
    });
    expect(report).toMatchObject({
      migration_set_sha256: PLAN.migration_set_sha256,
      migrator_version: PLAN.migrator_version,
      stage_content_sha256: expect.any(String),
      target_state_sha256: HASH,
      status: 'validated',
    });
    expect(report.receipt_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects invalid entity and self-reference FKs before PostgreSQL mutation', () => {
    const invalid = { ...PLAN, members: { ...PLAN.members, observations: [{ ...PLAN.members.observations[0], linked_observation_id: 999 }] } };
    expect(validateRelationalPlan(invalid).foreign_keys.violations).toEqual([expect.objectContaining({ field: 'linked_observation_id', value: 999 })]);
    expect(validateRelationalPlan(invalid).foreign_keys.violations).toEqual(expect.any(Array));
  });

  it('rejects an empty user schema, an unrelated extension, and incomplete catalog inventory', async () => {
    const base = [
      { when: /SHOW transaction_read_only/u, result: { rows: [{ transaction_read_only: 'on' }] } },
      { when: /current_database/u, result: { rows: [{ database_name: 'target', database_oid: '13', server_address: null, server_port: '5432', server_version: '160000' }] } },
    ];
    for (const inventory of [
      { object_count: '0', schemas: ['public', 'empty_user_schema'], extensions: ['plpgsql'], vector_schemas: [], objects: [], inventory_complete: true },
      { object_count: '0', schemas: ['public'], extensions: ['plpgsql', 'hstore'], vector_schemas: [], objects: [], inventory_complete: true },
      { object_count: '0', schemas: ['public'], extensions: ['plpgsql'], vector_schemas: [], objects: [] },
    ]) {
      const client = fakeClient([...base, { when: /non_system_objects/u, result: { rows: [inventory] } }]);
      await expect(inspectTarget({ client, sourceIdentity: TARGET })).rejects.toMatchObject({ code: expect.stringMatching(/^RMIG-E-TARGET-(NOT-FRESH|SCHEMA)$/u) });
    }
  });

  it('allows only public plus the vector extension schema when the catalog is complete', async () => {
    const client = fakeClient([
      { when: /SHOW transaction_read_only/u, result: { rows: [{ transaction_read_only: 'on' }] } },
      { when: /current_database/u, result: { rows: [{ database_name: 'target', database_oid: '14', server_address: null, server_port: '5432', server_version: '160000' }] } },
      { when: /non_system_objects/u, result: { rows: [{ object_count: '0', schemas: ['public', 'vector_schema'], extensions: ['plpgsql', 'vector'], vector_schemas: ['vector_schema'], objects: [], inventory_complete: true }] } },
      { when: /pg_available_extensions/u, result: { rows: [{ available: true }] } },
    ]);
    await expect(inspectTarget({ client, sourceIdentity: TARGET })).resolves.toMatchObject({ object_count: 0, pgvector: true });
  });

  it('keeps one immutable bound hash from transform through staging and dry-run', async () => {
    const source = { entities: [{ id: 1, name: 'Alice', entity_type: 'person', primary_context: 'default', salience: 'active' }] };
    const idMaps = buildIdMaps(source, { items: [] });
    const transformed = transformRelational({
      tables: source,
      compiledPolicy: { id_map: idMaps.idMap, name_map: idMaps.serializedNames, mapping_tables: ['entities'], losses: [] },
      migrationId: PLAN.migration_id,
      bundleManifestSha256: HASH,
      compiledPolicySha256: 'b'.repeat(64),
    });
    const migrationSet = migrationSetSha256(await readV4Migrations());
    const bound = bindRelationalPlan(transformed, { migrationSetSha256: migrationSet, migratorVersion: V4_MIGRATOR_VERSION });
    const restaged = bindRelationalPlan({ ...bound, members: structuredClone(bound.members) }, { migrationSetSha256: migrationSet, migratorVersion: V4_MIGRATOR_VERSION });
    const report = buildDryRunReport({ plan: restaged, targetIdentity: TARGET, migrationSetSha256: migrationSet, migratorVersion: V4_MIGRATOR_VERSION, targetStateSha256: HASH });
    expect(transformed.plan_payload_sha256).toBe(transformed.plan_sha256);
    expect(bound.plan_payload_sha256).toBe(transformed.plan_payload_sha256);
    expect(bound.plan_sha256).not.toBe(bound.plan_payload_sha256);
    expect(restaged.plan_sha256).toBe(bound.plan_sha256);
    expect(report.plan_sha256).toBe(bound.plan_sha256);
    expect(report.migration_set_sha256).toBe(migrationSet);
    expect(report.migrator_version).toBe(V4_MIGRATOR_VERSION);
  });

  it('rejects a staged routed row with any trigger-derived field mismatch or extra row', async () => {
    const entity = { id: 1, name: 'Alice', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' };
    const routed = { id: 1, name: 'Alice', kind: 'person', primary_context: 'default', salience: 'active', created_at: entity.created_at, updated_at: entity.updated_at };
    const badPlan = { ...PLAN, members: { entities: [entity], people: [routed, { ...routed, id: 2 }], nodes: [] } };
    expect(validateRelationalPlan(badPlan).routing.violations).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'extra people/nodes row' })]));
    const badDryRun = buildDryRunReport({ plan: badPlan, targetIdentity: TARGET, migrationSetSha256: PLAN.migration_set_sha256, migratorVersion: PLAN.migrator_version, stageContentSha256: canonicalSha256(badPlan.members), targetStateSha256: HASH });
    await expect(importPlan({ client: fakeClient(), plan: badPlan, dryRun: badDryRun, targetIdentity: TARGET, stagingSchema: 'rmig_stage' })).rejects.toMatchObject({ code: 'RMIG-E-VALIDATION' });
  });

  it('uses transactional ALTER SEQUENCE RESTART and never non-transactional setval', async () => {
    const client = fakeClient([
      { when: /pg_get_serial_sequence/u, result: { rows: [{ schema_name: 'public', sequence_name: 'entities_id_seq' }] } },
      { when: /COALESCE\(MAX\(id\), 0\)/u, result: { rows: [{ max_id: '9' }] } },
    ]);
    await resetSequence(client, 'entities');
    expect(client.calls.some(({ text }) => /setval/u.test(text))).toBe(false);
    expect(client.calls.some(({ text }) => text === 'ALTER SEQUENCE "public"."entities_id_seq" RESTART WITH 10')).toBe(true);
  });

  it('defers forward and cyclic observation self-FKs until all observations exist', async () => {
    const currentMigrations = await readV4Migrations();
    const currentSet = migrationSetSha256(currentMigrations);
    const cyclePlan = { ...PLAN, migration_set_sha256: currentSet, migrator_version: V4_MIGRATOR_VERSION, members: { ...PLAN.members, observations: [
      { id: 4, entity_id: 1, person_id: 1, content: 'four', linked_observation_id: 5 },
      { id: 5, entity_id: 1, person_id: 1, content: 'five', linked_observation_id: 4 },
    ] } };
    const stageHash = canonicalSha256(cyclePlan.members);
    const targetStateHash = canonicalSha256({ objects: [], counts: [] });
    const dryRun = buildDryRunReport({ plan: cyclePlan, targetIdentity: TARGET, migrationSetSha256: currentSet, migratorVersion: V4_MIGRATOR_VERSION, stageContentSha256: stageHash, targetStateSha256: targetStateHash });
    const planHash = dryRun.plan_sha256;
    const rows = Object.entries(cyclePlan.members).flatMap(([table, values]) => values.map((row, row_index) => ({ table_name: table, row_index, row_json: row, row_sha256: canonicalSha256(row) })));
    const responses = [
      { when: /current_database/u, result: { rows: [{ database_name: 'mind', database_oid: '42', server_address: null, server_port: '5432', server_version: '160000' }] } },
      { when: /\/\* target_state \*\//u, result: { rows: [] } },
      { when: /SELECT version, checksum FROM public\.schema_migrations/u, result: { rows: currentMigrations.map(({ file, checksum }) => ({ version: file, checksum })) } },
      { when: /FROM "rmig_stage"\."run_metadata"/u, result: { rows: [{ migration_id: cyclePlan.migration_id, bundle_manifest_sha256: cyclePlan.bundle_manifest_sha256, compiled_policy_sha256: cyclePlan.compiled_policy_sha256, target_identity_sha256: TARGET.database_identity_sha256, migration_set_sha256: currentSet, migrator_version: V4_MIGRATOR_VERSION, plan_sha256: planHash, stage_content_sha256: stageHash, dry_run_receipt_sha256: dryRun.receipt_sha256, target_state_sha256: targetStateHash, status: 'dry-run' }], rowCount: 1 } },
      { when: /run_rows/u, result: { rows } },
    ];
    const client = fakeClient(responses);
    await expect(importPlan({ client, plan: cyclePlan, dryRun, targetIdentity: TARGET, stagingSchema: 'rmig_stage' })).resolves.toMatchObject({ status: 'complete', inserted_rows: 3 });
    const inserts = client.calls.filter(({ text }) => /^INSERT INTO "public"/u.test(text));
    const updates = client.calls.filter(({ text }) => /^UPDATE public\."observations"/u.test(text));
    expect(inserts.some(({ text }) => text.includes('"entities"'))).toBe(true);
    expect(inserts.filter(({ text }) => text.includes('"observations"'))).toHaveLength(2);
    expect(inserts.filter(({ text }) => text.includes('"linked_observation_id"'))).toHaveLength(0);
    expect(updates).toHaveLength(2);
    expect(client.calls.some(({ text }) => /setval/u.test(text))).toBe(false);
    const failedClient = fakeClient(responses);
    await expect(importPlan({ client: failedClient, plan: cyclePlan, dryRun, targetIdentity: TARGET, stagingSchema: 'rmig_stage', injectFailureAfter: 1 })).rejects.toThrow('injected import failure');
    expect(failedClient.calls.filter(({ text }) => text === 'COMMIT')).toHaveLength(0);
    expect(failedClient.calls.filter(({ text }) => text === 'ROLLBACK')).toHaveLength(1);
    expect(failedClient.calls.some(({ text }) => /setval/u.test(text))).toBe(false);
  });
  it('refuses direct import without a bound staging schema', async () => {
    const client = fakeClient();
    const dryRun = buildDryRunReport({ plan: PLAN, targetIdentity: TARGET });
    await expect(importPlan({ client, plan: PLAN, dryRun, targetIdentity: TARGET })).rejects.toMatchObject({ code: 'RMIG-E-DRY-RUN-REQUIRED' });
    expect(client.calls).toEqual([]);
  });

  it('uses one transaction for atomic migrations and rolls back the ledger with a partial failure', async () => {
    const migrations = [
      { file: '0001_first.sql', sql: 'CREATE TABLE first_marker (id integer);' },
      { file: '0002_second.sql', sql: 'CREATE TABLE second_marker (id integer); -- FAIL' },
    ];
    const successClient = fakeClient([
      { when: /has_ledger/u, result: { rows: [{ has_ledger: false, has_entities: false }] } },
      { when: /SELECT version, checksum FROM public\.schema_migrations/u, result: { rows: [] } },
    ]);
    await expect(applyV4Migrations({ client: successClient, migrations, atomic: true })).resolves.toHaveLength(2);
    expect(successClient.calls.filter(({ text }) => text === 'BEGIN')).toHaveLength(1);
    expect(successClient.calls.filter(({ text }) => text === 'COMMIT')).toHaveLength(1);
    expect(successClient.calls.filter(({ text }) => text === 'ROLLBACK')).toHaveLength(0);
    const client = fakeClient([
      { when: /has_ledger/u, result: { rows: [{ has_ledger: false, has_entities: false }] } },
      { when: /SELECT version, checksum FROM public\.schema_migrations/u, result: { rows: [] } },
      { when: /FAIL/u, throw: new Error('migration failed') },
    ]);
    await expect(applyV4Migrations({ client, migrations, atomic: true })).rejects.toThrow('migration failed');
    const sql = client.calls.map(({ text }) => text);
    expect(sql.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(sql.filter((text) => text === 'COMMIT')).toHaveLength(0);
    expect(sql.filter((text) => text === 'ROLLBACK')).toHaveLength(1);
    expect(sql.indexOf('BEGIN')).toBeLessThan(sql.indexOf(migrations[0].sql));
    expect(sql.indexOf('ROLLBACK')).toBeGreaterThan(sql.indexOf(migrations[1].sql));
    expect(sql.filter((text) => /INSERT INTO public\.schema_migrations/u.test(text))).toHaveLength(1);
  });

  it('keeps non-atomic migration mode as one transaction per migration', async () => {
    const migrations = [
      { file: '0001_first.sql', sql: 'CREATE TABLE first_marker (id integer);' },
      { file: '0002_second.sql', sql: 'CREATE TABLE second_marker (id integer);' },
    ];
    const client = fakeClient([
      { when: /has_ledger/u, result: { rows: [{ has_ledger: false, has_entities: false }] } },
      { when: /SELECT version, checksum FROM public\.schema_migrations/u, result: { rows: [] } },
    ]);
    await expect(applyV4Migrations({ client, migrations })).resolves.toHaveLength(2);
    expect(client.calls.filter(({ text }) => text === 'BEGIN')).toHaveLength(2);
    expect(client.calls.filter(({ text }) => text === 'COMMIT')).toHaveLength(2);
  });

  it('preparation uses an atomic runner mode so a failed migration cannot strand a partial ledger', async () => {
    const client = fakeClient([
      { when: /SHOW transaction_read_only/u, result: { rows: [{ transaction_read_only: 'on' }] } },
      { when: /current_database/u, result: { rows: [{ database_name: 'target', database_oid: '12', server_address: null, server_port: '5432', server_version: '160000' }] } },
      { when: /non_system_objects/u, result: { rows: [{ object_count: '0', schemas: ['public'], extensions: ['plpgsql'], vector_schemas: [], objects: [], inventory_complete: true }] } },
      { when: /pg_available_extensions/u, result: { rows: [{ available: true }] } },
    ]);
    const runner = { run: async (options) => { expect(options).toMatchObject({ atomic: true }); throw new Error('migration failed'); } };
    await expect(prepareTarget({
      client, migrationRunner: runner, sourceIdentity: { database_identity_sha256: 'f'.repeat(64) },
      migrationId: PLAN.migration_id, bundleManifestSha256: PLAN.bundle_manifest_sha256,
      compiledPolicySha256: PLAN.compiled_policy_sha256,
    })).rejects.toThrow('migration failed');
  });

  it.each(['same-source', 'nonfresh-target', 'unknown-resume-schema'])('rejects %s resume attempts before any target write', async (scenario) => {
    const client = fakeClient(scenario === 'same-source' ? [
      { when: /SHOW transaction_read_only/u, result: { rows: [{ transaction_read_only: 'on' }] } },
      { when: /current_database/u, result: { rows: [{ database_name: 'source', database_oid: '42', server_address: null, server_port: '5432', server_version: '160000' }] } },
    ] : scenario === 'nonfresh-target' ? [
      { when: /SHOW transaction_read_only/u, result: { rows: [{ transaction_read_only: 'on' }] } },
      { when: /current_database/u, result: { rows: [{ database_name: 'target', database_oid: '43', server_address: null, server_port: '5432', server_version: '160000' }] } },
      { when: /non_system_objects/u, result: { rows: [{ inventory_complete: true, schemas: ['public', 'private'], extensions: ['plpgsql'], vector_schemas: [], object_count: '1', objects: [{ schema: 'private', name: 'table', kind: 'relation' }] }] } },
    ] : []);
    await expect(prepareTarget({
      client,
      migrationRunner: { run: vi.fn() },
      sourceIdentity: scenario === 'same-source' ? TARGET : { database_identity_sha256: 'f'.repeat(64) },
      migrationId: PLAN.migration_id,
      bundleManifestSha256: PLAN.bundle_manifest_sha256,
      compiledPolicySha256: PLAN.compiled_policy_sha256,
      resumeSchema: scenario === 'unknown-resume-schema' ? 'rmig_unknown' : 'rmig_existing',
    })).rejects.toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
    expect(client.calls.every(({ text }) => !/CREATE|ALTER|INSERT|UPDATE|DELETE|DROP/u.test(text))).toBe(true);
  });

  it('carries explicit NULLs from staged rows into import parameters', async () => {
    const plan = {
      ...PLAN,
      members: {
        entities: [{ id: 1, name: 'Alice', entity_type: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' }],
        people: [{ id: 1, name: 'Alice', kind: 'person', primary_context: 'default', salience: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' }],
        observations: [{ id: 4, entity_id: 1, person_id: 1, content: 'hello', weight: null, charge: null, source: null, context: null, sit_count: null, surface_count: null, novelty_score: null, access_count: null }],
      },
    };
    const migrations = await readV4Migrations();
    const migrationSet = migrationSetSha256(migrations);
    const stageHash = canonicalSha256(plan.members);
    const stateHash = canonicalSha256({ objects: [], counts: [] });
    const dryRun = buildDryRunReport({ plan, targetIdentity: TARGET, migrationSetSha256: migrationSet, migratorVersion: V4_MIGRATOR_VERSION, stageContentSha256: stageHash, targetStateSha256: stateHash });
    const rows = Object.entries(plan.members).flatMap(([table, values]) => values.map((row, row_index) => ({ table_name: table, row_index, row_json: row, row_sha256: canonicalSha256(row) })));
    const client = fakeClient([
      { when: /current_database/u, result: { rows: [{ database_name: 'mind', database_oid: '42', server_address: null, server_port: '5432', server_version: '160000' }] } },
      { when: /\/\* target_state \*\//u, result: { rows: [] } },
      { when: /SELECT version, checksum FROM public\.schema_migrations/u, result: { rows: migrations.map(({ file, checksum }) => ({ version: file, checksum })) } },
      { when: /FROM "rmig_stage"\."run_metadata"/u, result: { rows: [{ migration_id: plan.migration_id, bundle_manifest_sha256: plan.bundle_manifest_sha256, compiled_policy_sha256: plan.compiled_policy_sha256, target_identity_sha256: TARGET.database_identity_sha256, migration_set_sha256: migrationSet, migrator_version: V4_MIGRATOR_VERSION, plan_sha256: dryRun.plan_sha256, stage_content_sha256: stageHash, dry_run_receipt_sha256: dryRun.receipt_sha256, target_state_sha256: stateHash, status: 'dry-run' }], rowCount: 1 } },
      { when: /run_rows/u, result: { rows } },
    ]);
    await expect(importPlan({ client, plan, dryRun, targetIdentity: TARGET, stagingSchema: 'rmig_stage' })).resolves.toMatchObject({ status: 'complete', inserted_rows: 2 });
    const observationInsert = client.calls.find(({ text }) => /^INSERT INTO "public"\."observations"/u.test(text));
    expect(observationInsert.values.filter((value) => value === null)).toHaveLength(8);
  });
});
