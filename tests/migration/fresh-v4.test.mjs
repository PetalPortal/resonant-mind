import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import {
  createV4MigrationRunner,
  migrationChecksum,
  readV4Migrations,
} from '../../scripts/migrate-postgres.mjs';
import {
  inspectTarget,
  buildDryRunReport,
  importPlan,
  prepareTarget,
} from '../../scripts/v32-to-v4/target/postgres.mjs';

function fakeClient(responses = []) {
  const calls = [];
  return {
    calls,
    async connect() { calls.push({ text: 'CONNECT', values: [] }); },
    async end() { calls.push({ text: 'END', values: [] }); },
    async query(text, values = []) {
      calls.push({ text, values });
      const response = responses.find((item) => item.when instanceof RegExp ? item.when.test(text) : item.when === text);
      if (response?.throw) throw response.throw;
      return response?.result ?? { rows: [], rowCount: 0 };
    },
  };
}

const IDENTITY = {
  kind: 'postgres',
  database_identity_sha256: 'a'.repeat(64),
  server_identity_sha256: 'b'.repeat(64),
};

const PLAN = {
  format_version: 1,
  plan_type: 'relational-staging',
  migration_id: 'rmig_fresh_v4_test',
  bundle_manifest_sha256: 'c'.repeat(64),
  compiled_policy_sha256: 'd'.repeat(64),
  members: {
    entities: [{ id: 1, name: 'Alice', entity_type: 'person', primary_context: 'default', salience: 'active' }],
    people: [{ id: 1, name: 'Alice', kind: 'person' }],
    observations: [{ id: 4, entity_id: 1, person_id: 1, content: 'hello' }],
  },
  coverage: {
    entities: { source_rows: 1, transformed_rows: 1, excluded_rows: 0, losses: 0, target_tables: ['people'] },
    observations: { source_rows: 1, transformed_rows: 1, excluded_rows: 0, losses: 0, target_tables: ['observations'] },
  },
  losses: [],
};

it('loads immutable v4 migrations in deterministic order with stable checksums', async () => {
  const migrations = await readV4Migrations();
  expect(migrations.length).toBeGreaterThan(0);
  expect(migrations.map(({ file }) => file)).toEqual([...migrations.map(({ file }) => file)].sort());
  expect(migrations.every(({ sql, checksum }) => checksum === migrationChecksum(sql))).toBe(true);
  expect(Object.isFrozen(migrations)).toBe(true);
  expect(Object.isFrozen(migrations[0])).toBe(true);
});

it('preserves the migration runner lock, TLS, untracked refusal, and rollback contract', async () => {
  const client = fakeClient([
    { when: /has_ledger/, result: { rows: [{ has_ledger: false, has_entities: true }] } },
  ]);
  const runner = createV4MigrationRunner({
    connectionString: 'postgres://user:secret@example.test/db',
    clientFactory: () => client,
    migrations: [],
  });
  await expect(runner.run()).rejects.toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
  expect(client.calls.some(({ text }) => /pg_advisory_lock/.test(text))).toBe(true);
  expect(client.calls.some(({ text }) => /pg_advisory_unlock/.test(text))).toBe(true);
  expect(JSON.stringify(client.calls)).not.toContain('secret');
});

it('refuses a target with arbitrary schemas or the source identity without writes', async () => {
  const client = fakeClient([
    { when: /SHOW transaction_read_only/, result: { rows: [{ transaction_read_only: 'on' }] } },
    { when: /current_database/, result: { rows: [{ database_name: 'target', database_oid: '11', server_address: '127.0.0.1', server_port: '5432', server_version: '160000' }] } },
    { when: /non_system_objects/, result: { rows: [{ object_count: '1', schemas: ['arbitrary'] }] } },
    { when: /pg_available_extensions/, result: { rows: [{ available: true }] } },
  ]);
  await expect(inspectTarget({ client, sourceIdentity: IDENTITY })).rejects.toMatchObject({ code: 'RMIG-E-TARGET-NOT-FRESH' });
  expect(client.calls.every(({ text }) => !/CREATE|ALTER|INSERT|UPDATE|DELETE|DROP/i.test(text))).toBe(true);
});

it('requires pgvector and distinguishes a fresh target identity', async () => {
  const client = fakeClient([
    { when: /SHOW transaction_read_only/, result: { rows: [{ transaction_read_only: 'on' }] } },
    { when: /current_database/, result: { rows: [{ database_name: 'target', database_oid: '12', server_address: '127.0.0.1', server_port: '5432', server_version: '160000' }] } },
    { when: /non_system_objects/, result: { rows: [{ object_count: '0', schemas: [] }] } },
    { when: /pg_available_extensions/, result: { rows: [{ available: false }] } },
  ]);
  await expect(inspectTarget({ client, sourceIdentity: IDENTITY })).rejects.toMatchObject({ code: 'RMIG-E-TARGET-SCHEMA' });
});

it('binds staging preparation to migration hashes and cleans the schema on failure', async () => {
  const client = fakeClient([
    { when: /SHOW transaction_read_only/, result: { rows: [{ transaction_read_only: 'on' }] } },
    { when: /current_database/, result: { rows: [{ database_name: 'target', database_oid: '12', server_address: '127.0.0.1', server_port: '5432', server_version: '160000' }] } },
    { when: /non_system_objects/, result: { rows: [{ object_count: '0', schemas: [] }] } },
    { when: /pg_available_extensions/, result: { rows: [{ available: true }] } },
    { when: /has_ledger/, result: { rows: [{ has_ledger: false, has_entities: false }] } },
  ]);
  const runner = { run: vi.fn(async () => { throw new Error('migration failed'); }) };
  await expect(prepareTarget({ client, migrationRunner: runner, sourceIdentity: IDENTITY, migrationId: PLAN.migration_id, bundleManifestSha256: PLAN.bundle_manifest_sha256, compiledPolicySha256: PLAN.compiled_policy_sha256 })).rejects.toThrow('migration failed');
  expect(client.calls.some(({ text }) => /DROP SCHEMA/.test(text))).toBe(true);
});

it('produces a receipt-bearing dry run with exact row hashes and validation buckets', () => {
  const report = buildDryRunReport({ plan: PLAN, targetIdentity: IDENTITY });
  expect(report.counts.tables.people).toMatchObject({ rows: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(report.validation).toMatchObject({ foreign_keys: { violations: [] }, uniqueness: { violations: [] }, enums: { violations: [] } });
  expect(report.losses).toEqual({ count: 0, sha256: canonicalSha256([]), entries: [] });
  expect(report.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
});

it('refuses direct plan imports before any target mutation', async () => {
  const client = fakeClient();
  await expect(importPlan({ client, plan: PLAN, dryRun: buildDryRunReport({ plan: PLAN, targetIdentity: IDENTITY }), targetIdentity: IDENTITY, injectFailureAfter: 1 })).rejects.toMatchObject({ code: 'RMIG-E-DRY-RUN-REQUIRED' });
  expect(client.calls).toHaveLength(0);
});

it('refuses an exact-once rerun before mutating the target when no staging receipt is supplied', async () => {
  const client = fakeClient();
  await expect(importPlan({ client, plan: PLAN, dryRun: buildDryRunReport({ plan: PLAN, targetIdentity: IDENTITY }), targetIdentity: IDENTITY })).rejects.toMatchObject({ code: 'RMIG-E-DRY-RUN-REQUIRED' });
  expect(client.calls).toHaveLength(0);
});
