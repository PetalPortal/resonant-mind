import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresV32Adapter } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';
import { createBundle, verifyBundle } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { generateDecisionManifest, decisionManifestHash, loadVerifiedBundle } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { inspectTarget, prepareTarget, dryRunStaging, importPlan, readTargetIdentity } from '../../scripts/v32-to-v4/target/postgres.mjs';
import { createV4MigrationRunner } from '../../scripts/migrate-postgres.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';

// A second, richer live run than e2e-postgres.integration.test.mjs: every v3.2 table has rows, with
// the awkward values real databases hold (microsecond timestamps, a non-UTC offset, NULLs, unicode,
// quotes and newlines, self references, JSON-in-text, vectors). It checks what the target database
// really contains against what the source database held, not only that the pipeline ran.
const { Client } = pg;
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(repo, 'tests', 'fixtures', 'migration', 'v3.2', 'postgres.sql');
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
const runE2E = typeof adminUrl === 'string' && adminUrl.length > 0;
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const LONG = `${'long line with "quotes", \'apostrophes\', back\\slash and unicode ☃ \u{1F33F}\n'.repeat(200)}end`;

const SEED = `
INSERT INTO entities (id, name, entity_type, primary_context, salience, intentionally_isolated, created_at, updated_at) VALUES
  (1, 'Rich Person One', 'person', 'default', 'foundational', 0, '2026-01-02 03:04:05.123456+00', '2026-01-03 03:04:05+00'),
  (2, 'Rich Person Two', 'person', 'default', 'active', 0, '2026-01-02 03:04:06.5+00', NULL),
  (7, 'Garden ☃ naïve', 'concept', 'default', 'active', 1, '2026-02-01 12:00:00+01', '2026-02-01 12:00:00+01');
INSERT INTO observations (id, entity_id, content, salience, emotion, weight, certainty, source, source_date, context, charge, charge_note, sit_count, novelty_score, last_surfaced_at, surface_count, archived_at, added_at, resolved_at, resolution_note, linked_observation_id, access_count, last_accessed_at, valid_from, valid_until, superseded_by, supersedes) VALUES
  (3, 1, $$${LONG}$$, 'active', 'warm', 'heavy', 'known', 'conversation', '2026-01-02', 'default', 'processing', 'a note', 2, 0.25, '2026-03-01 00:00:00.000001+00', 4, NULL, '2026-01-02 04:00:00.987654+00', NULL, NULL, NULL, 9, '2026-03-02 10:00:00+00', '2026-01-01 00:00:00+00', NULL, NULL, NULL),
  (5, 1, 'second observation, ''quoted'' and "double"', 'active', NULL, 'medium', 'believed', 'conversation', NULL, 'default', NULL, NULL, 0, 1.0, NULL, 0, '2026-04-01 00:00:00+00', '2026-01-02 04:00:01+00', '2026-04-02 00:00:00+00', 'settled', 3, 0, NULL, NULL, NULL, NULL, NULL),
  (9, 2, 'third, about the garden', 'active', 'calm', 'light', 'believed', 'conversation', NULL, 'default', NULL, NULL, 0, 0.5, NULL, 0, NULL, '2026-01-05 08:30:00-05', NULL, NULL, NULL, 1, '2026-01-06 00:00:00+00', NULL, '2026-12-31 00:00:00+00', 5, 3);
INSERT INTO observation_versions (id, observation_id, content, weight, emotion, changed_at) VALUES
  (1, 3, 'earlier wording', 'medium', 'warm', '2026-01-02 05:00:00.5+00'),
  (2, 3, 'earlier still', NULL, NULL, '2026-01-02 04:30:00+00');
INSERT INTO relations (id, from_entity, to_entity, relation_type, from_context, to_context, store_in, created_at) VALUES
  (1, 'Rich Person One', 'Rich Person Two', 'knows', 'default', 'default', 'default', '2026-01-02 06:00:00+00'),
  (2, 'Rich Person One', 'Garden ☃ naïve', 'tends', 'default', 'default', 'default', '2026-01-02 06:00:01+00');
INSERT INTO threads (id, thread_type, content, context, priority, status, source, created_at, updated_at, resolved_at, resolution) VALUES
  ('thr-1', 'intention', 'a thread', 'default', 'high', 'active', 'self', '2026-01-02 07:00:00+00', '2026-01-02 07:00:01+00', NULL, NULL),
  ('thr-2', 'question', 'a resolved thread', NULL, 'low', 'resolved', 'self', '2026-01-02 07:00:00+00', '2026-01-02 07:30:00+00', '2026-01-02 07:30:00+00', 'answered');
INSERT INTO context_entries (id, scope, content, links, updated_at) VALUES
  ('ctx-1', 'work', 'what is happening', '["thr-1"]', '2026-01-02 08:00:00+00');
INSERT INTO relational_state (id, person, feeling, intensity, timestamp) VALUES
  (1, 'Rich Person One', 'fond', 'strong', '2026-01-02 09:00:00+00');
INSERT INTO identity (id, section, content, weight, connections, timestamp) VALUES
  (1, 'core.values', 'curiosity', 0.7, '[]', '2026-01-02 10:00:00+00'),
  (2, 'core.self', 'careful', 0.9, '["core.values"]', '2026-01-02 10:00:01+00');
INSERT INTO journals (id, entry_date, content, tags, emotion, journal_type, created_at) VALUES
  (1, '2026-01-02', 'a journal entry', '["a","b"]', 'content', 'entry', '2026-01-02 11:00:00+00'),
  (2, NULL, 'an undated one', '[]', NULL, 'entry', '2026-01-02 11:00:01+00');
INSERT INTO consolidation_groups (id, summary, entity_id, source_observation_ids, consolidated_observation_id, created_at) VALUES
  (1, 'merged two', 1, '[3,5]', 3, '2026-01-02 12:00:00+00');
INSERT INTO images (id, path, description, context, emotion, weight, entity_id, observation_id, created_at, novelty_score, last_surfaced_at, surface_count, archived_at, access_count, last_accessed_at) VALUES
  (1, 'images/one.png', 'a picture', 'default', 'warm', 'medium', 1, 3, '2026-01-02 13:00:00+00', 1.0, NULL, 0, NULL, 0, NULL);
INSERT INTO subconscious (id, state_type, data, updated_at) VALUES
  (1, 'mood', '{"valence":0.5}', '2026-01-02 14:00:00+00');
INSERT INTO daemon_proposals (id, proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id, reason, confidence, status, proposed_at, resolved_at) VALUES
  (1, 'resonance', 3, 5, 1, 1, 'they keep appearing together', 0.75, 'pending', '2026-01-02 15:00:00+00', NULL);
INSERT INTO tensions (id, pole_a, pole_b, context, sit_count, sit_notes, status, created_at, resolved_at, resolution) VALUES
  ('ten-1', 'speed', 'care', 'default', 2, '["first","second"]', 'active', '2026-01-02 16:00:00+00', NULL, NULL);
INSERT INTO dormant_observations (id, observation_id, first_marked, rescue_attempts, last_rescue_attempt) VALUES
  (1, 5, '2026-01-02 17:00:00+00', 1, '2026-01-03 17:00:00+00');
INSERT INTO co_surfacing (id, obs_a_id, obs_b_id, co_count, last_co_surfaced, relation_proposed, relation_created) VALUES
  (1, 3, 5, 6, '2026-01-02 18:00:00+00', 1, 0);
INSERT INTO embeddings (id, source_type, source_id, embedding, content, metadata) VALUES
  ('observation-3', 'observation', 3, (SELECT array_fill(0.125::real, ARRAY[768])::vector), 'embedded text', '{"k":[1,2],"n":null}'),
  ('observation-5', 'observation', 5, NULL, NULL, '{}');
`;

function databaseUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function snapshot(adapter) {
  await adapter.beginSnapshot();
  try {
    const catalog = await adapter.catalog();
    const rows = {};
    for (const table of catalog.tables) {
      rows[table.name] = [];
      for await (const row of adapter.streamTable(table.name, table.primary_key)) rows[table.name].push(row);
    }
    return { hash: canonicalSha256({ catalog, rows }), rows };
  } finally {
    await adapter.endSnapshot();
    await adapter.close();
  }
}

function reviewedPolicy(bundle) {
  const draft = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  // The two kinds of item the seed legitimately raises: a dormant observation becomes an orphan
  // observation, and a tension keeps its visits but is not resolved. Anything else is a failure to see.
  const unexpected = [];
  const items = draft.items.map((item) => {
    if (item.type === 'dormancy-translation') return { ...item, choice: 'translate-to-orphan' };
    if (item.type === 'tension-state') return { ...item, choice: { action: 'preserve-visits-and-open', last_visited: '2026-01-04T00:00:00.000Z' } };
    unexpected.push(item.type + ' ' + item.source_table + '.' + item.field + ': ' + item.reason);
    return item;
  });
  if (unexpected.length > 0) throw new Error(`Unexpected decision items:\n${unexpected.join('\n')}`);
  const reviewed = { ...draft, items, reviewed: true, reviewed_by: 'ci-fixture-reviewer', reviewed_at: '2026-09-20T00:01:00.000Z' };
  reviewed.manifest_sha256 = decisionManifestHash(reviewed);
  return reviewed;
}

describe.skipIf(!runE2E)('real PostgreSQL v3.2 with every table populated to fresh v4', () => {
  it('keeps what the source held, byte for byte where the target has a column for it', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const sourceDb = `rmig_rsrc_${suffix}`;
    const targetDb = `rmig_rtgt_${suffix}`;
    const root = mkdtempSync(join(repo, '.tmp-postgres-e2e-rich-'));
    const passphrase = join(root, 'passphrase');
    const bundlePath = join(root, 'bundle.rmigrate');
    writeFileSync(passphrase, 'postgres-e2e-rich-passphrase', { mode: 0o600 });
    const admin = await connect(adminUrl);
    let sourceClient;
    let targetClient;
    let runner;
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(sourceDb)}`);
      await admin.query(`CREATE DATABASE ${quoteIdentifier(targetDb)}`);
      const sourceUrl = databaseUrl(adminUrl, sourceDb);
      const targetUrl = databaseUrl(adminUrl, targetDb);
      sourceClient = await connect(sourceUrl);
      await sourceClient.query(readFileSync(fixture, 'utf8'));
      await sourceClient.query(SEED);
      const seeded = await sourceClient.query("SELECT (SELECT count(*)::int FROM entities) AS entities, (SELECT count(*)::int FROM observations) AS observations, (SELECT count(*)::int FROM embeddings) AS embeddings");
      expect(seeded.rows[0]).toEqual({ entities: 3, observations: 3, embeddings: 2 });
      await sourceClient.end(); sourceClient = undefined;

      const env = { RMIG_RICH_SOURCE: sourceUrl };
      const adapterFor = () => createPostgresV32Adapter({ source: 'env:RMIG_RICH_SOURCE', env });
      const before = await snapshot(adapterFor());
      const sourceAdapter = adapterFor();
      const sourceIdentity = await sourceAdapter.identity();
      await createBundle({ adapter: sourceAdapter, sourceKind: 'postgres', migrationId: 'rmig_postgres_rich_01', outputPath: bundlePath, passphraseFile: passphrase, timestamp: '2026-09-20T00:02:00.000Z' });
      expect(verifyBundle({ path: bundlePath, passphraseFile: passphrase }).manifest.bundle_mode).toBe('encrypted');
      expect((await snapshot(adapterFor())).hash).toBe(before.hash);

      const bundle = loadVerifiedBundle(bundlePath, { passphraseFile: passphrase });
      const compiled = compilePolicy({ bundle, decisions: reviewedPolicy(bundle) });
      const plan = transformRelational({ bundle, compiledPolicy: compiled });
      targetClient = await connect(targetUrl);
      runner = createV4MigrationRunner({ connectionString: targetUrl });
      await inspectTarget({ client: targetClient, sourceIdentity });
      const prepared = await prepareTarget({ client: targetClient, migrationRunner: runner, sourceIdentity, migrationId: 'rmig_postgres_rich_01', bundleManifestSha256: plan.bundle_manifest_sha256, compiledPolicySha256: plan.compiled_policy_sha256, plan });
      const target = await readTargetIdentity({ client: targetClient });
      const dryRun = await dryRunStaging({ client: targetClient, plan, stagingSchema: prepared.schema, targetIdentity: target });
      const imported = await importPlan({ client: targetClient, plan, dryRun, targetIdentity: target, stagingSchema: prepared.schema });
      expect(imported.receipt_sha256).toMatch(/^[0-9a-f]{64}$/u);

      // What the target holds, compared with what the source held. Both sides are read with the same
      // SQL shape and every timestamp is printed in UTC to the microsecond, so a lost digit, a shifted
      // offset or a changed value is a failure, not a rounding.
      const sourceRead = await connect(sourceUrl);
      try {
        const ts = (column) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
        const both = async (sourceSql, targetSql) => {
          const [fromSource, fromTarget] = await Promise.all([sourceRead.query(sourceSql), targetClient.query(targetSql)]);
          return { source: fromSource.rows, target: fromTarget.rows };
        };
        const sameRows = async (label, sourceSql, targetSql) => {
          const { source, target: held } = await both(sourceSql, targetSql);
          expect(held, label).toEqual(source);
          return source.length;
        };

        // Row counts: every source row has a home (entities split across people and nodes).
        const counts = await both(
          "SELECT 'entities' AS t, count(*)::int AS n FROM entities UNION ALL SELECT 'observations', count(*)::int FROM observations UNION ALL SELECT 'observation_versions', count(*)::int FROM observation_versions UNION ALL SELECT 'relations', count(*)::int FROM relations UNION ALL SELECT 'threads', count(*)::int FROM threads UNION ALL SELECT 'context_entries', count(*)::int FROM context_entries UNION ALL SELECT 'relational_state', count(*)::int FROM relational_state UNION ALL SELECT 'identity', count(*)::int FROM identity UNION ALL SELECT 'journals', count(*)::int FROM journals UNION ALL SELECT 'consolidation_groups', count(*)::int FROM consolidation_groups UNION ALL SELECT 'images', count(*)::int FROM images UNION ALL SELECT 'subconscious', count(*)::int FROM subconscious UNION ALL SELECT 'daemon_proposals', count(*)::int FROM daemon_proposals UNION ALL SELECT 'tensions', count(*)::int FROM tensions UNION ALL SELECT 'dormant_observations', count(*)::int FROM dormant_observations UNION ALL SELECT 'co_surfacing', count(*)::int FROM co_surfacing ORDER BY 1",
          "SELECT 'entities' AS t, (SELECT count(*) FROM people)::int + (SELECT count(*) FROM nodes)::int AS n UNION ALL SELECT 'observations', count(*)::int FROM observations UNION ALL SELECT 'observation_versions', count(*)::int FROM observation_versions UNION ALL SELECT 'relations', count(*)::int FROM relations UNION ALL SELECT 'threads', count(*)::int FROM threads UNION ALL SELECT 'context_entries', count(*)::int FROM context_entries UNION ALL SELECT 'relational_state', count(*)::int FROM relational_state UNION ALL SELECT 'identity', count(*)::int FROM identity UNION ALL SELECT 'journals', count(*)::int FROM journals UNION ALL SELECT 'consolidation_groups', count(*)::int FROM consolidation_groups UNION ALL SELECT 'images', count(*)::int FROM images UNION ALL SELECT 'subconscious', count(*)::int FROM subconscious UNION ALL SELECT 'daemon_proposals', count(*)::int FROM daemon_proposals UNION ALL SELECT 'tensions', count(*)::int FROM tensions UNION ALL SELECT 'dormant_observations', count(*)::int FROM orphan_observations UNION ALL SELECT 'co_surfacing', count(*)::int FROM co_surfacing ORDER BY 1",
        );
        expect(counts.target).toEqual(counts.source);
        expect(counts.source.find((row) => row.t === 'entities').n).toBe(3);

        // Entities: person kinds go to people, the rest to nodes, ids and names kept. The one value the
        // target invents is updated_at for a source NULL: v4's own routing trigger writes the import
        // time there (COALESCE(NEW.updated_at, NOW()), as its upgrade of an existing database does).
        const entities = await both(
          `SELECT id, name, entity_type, salience, primary_context, ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at FROM entities ORDER BY id`,
          `SELECT id, name, kind AS entity_type, salience, primary_context, ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at FROM (SELECT * FROM people UNION ALL SELECT * FROM nodes) e ORDER BY id`,
        );
        expect(entities.target.map(({ updated_at: _updated, ...row }) => row)).toEqual(entities.source.map(({ updated_at: _updated, ...row }) => row));
        expect(entities.target.map((row) => row.updated_at)).toEqual(['2026-01-03T03:04:05.000000', expect.stringMatching(/^2026-10|^20[2-9]\d-/u), '2026-02-01T11:00:00.000000']);
        expect(entities.source[0].created_at).toBe('2026-01-02T03:04:05.123456');
        expect((await targetClient.query("SELECT (SELECT array_agg(id ORDER BY id) FROM people) AS people, (SELECT array_agg(id ORDER BY id) FROM nodes) AS nodes")).rows[0]).toEqual({ people: [1, 2], nodes: [7] });

        // Observations: text byte for byte (including the 13 KB one with quotes, newlines and unicode), all
        // timestamps to the microsecond, the self references, and routing to person or node.
        const observationColumns = `id, entity_id, content, salience, emotion, weight, certainty, source, source_date::text AS source_date, context, charge, sit_count, novelty_score::text AS novelty_score, ${ts('last_surfaced_at')} AS last_surfaced_at, surface_count, ${ts('archived_at')} AS archived_at, ${ts('added_at')} AS added_at, ${ts('resolved_at')} AS resolved_at, resolution_note, linked_observation_id, access_count, ${ts('last_accessed_at')} AS last_accessed_at, ${ts('valid_from')} AS valid_from, ${ts('valid_until')} AS valid_until, superseded_by, supersedes`;
        await sameRows('observations', `SELECT ${observationColumns} FROM observations ORDER BY id`, `SELECT ${observationColumns} FROM observations ORDER BY id`);
        const routed = await targetClient.query('SELECT id, person_id, node_id FROM observations ORDER BY id');
        expect(routed.rows).toEqual([{ id: 3, person_id: 1, node_id: null }, { id: 5, person_id: 1, node_id: null }, { id: 9, person_id: 2, node_id: null }]);
        expect((await targetClient.query('SELECT length(content) AS n FROM observations WHERE id = 3')).rows[0].n).toBe([...LONG].length);

        // The remaining tables, column for column where the target has the column.
        await sameRows('observation_versions', `SELECT id, observation_id, content, weight, emotion, ${ts('changed_at')} AS at FROM observation_versions ORDER BY id`, `SELECT id, observation_id, content, weight, emotion, ${ts('edited_at')} AS at FROM observation_versions ORDER BY id`);
        expect((await targetClient.query('SELECT id, version_num FROM observation_versions ORDER BY version_num')).rows).toEqual([{ id: 2, version_num: 1 }, { id: 1, version_num: 2 }]);
        await sameRows('relations', `SELECT id, from_entity, to_entity, relation_type, from_context, to_context, store_in, ${ts('created_at')} AS created_at FROM relations ORDER BY id`, `SELECT id, from_entity, to_entity, relation_type, from_context, to_context, store_in, ${ts('created_at')} AS created_at FROM relations ORDER BY id`);
        // 'question' is a documented alias for the v4 thread type 'explore'.
        await sameRows('threads', `SELECT id, CASE thread_type WHEN 'question' THEN 'explore' ELSE thread_type END AS thread_type, content, context, priority, status, source, ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at, ${ts('resolved_at')} AS resolved_at, resolution FROM threads ORDER BY id`, `SELECT id, thread_type, content, context, priority, status, source, ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at, ${ts('resolved_at')} AS resolved_at, resolution FROM threads ORDER BY id`);
        await sameRows('context_entries', `SELECT id, scope, content, links, ${ts('updated_at')} AS updated_at FROM context_entries ORDER BY id`, `SELECT id, scope, content, links, ${ts('updated_at')} AS updated_at FROM context_entries ORDER BY id`);
        await sameRows('relational_state', `SELECT id, person, feeling, intensity, ${ts('timestamp')} AS at FROM relational_state ORDER BY id`, `SELECT id, person, feeling, intensity, ${ts('timestamp')} AS at FROM relational_state ORDER BY id`);
        await sameRows('identity', `SELECT id, section, content, weight::text AS weight, connections, ${ts('timestamp')} AS at FROM identity ORDER BY id`, `SELECT id, section, content, weight::text AS weight, connections, ${ts('timestamp')} AS at FROM identity ORDER BY id`);
        await sameRows('journals', `SELECT id, entry_date, content, tags, emotion, journal_type, ${ts('created_at')} AS created_at FROM journals ORDER BY id`, `SELECT id, entry_date, content, tags, emotion, journal_type, ${ts('created_at')} AS created_at FROM journals ORDER BY id`);
        await sameRows('consolidation_groups', `SELECT id, summary, entity_id, source_observation_ids::jsonb::text AS ids, consolidated_observation_id, ${ts('created_at')} AS created_at FROM consolidation_groups ORDER BY id`, `SELECT id, summary, entity_id, to_jsonb(source_observation_ids)::text AS ids, consolidated_observation_id, ${ts('created_at')} AS created_at FROM consolidation_groups ORDER BY id`);
        await sameRows('images', `SELECT id, path, description, context, emotion, weight, entity_id, observation_id, ${ts('created_at')} AS created_at, novelty_score::text AS novelty_score, surface_count, access_count FROM images ORDER BY id`, `SELECT id, path, description, context, emotion, weight, entity_id, observation_id, ${ts('created_at')} AS created_at, novelty_score::text AS novelty_score, surface_count, access_count FROM images ORDER BY id`);
        await sameRows('subconscious', `SELECT id, state_type, data, ${ts('updated_at')} AS updated_at FROM subconscious ORDER BY id`, `SELECT id, state_type, data, ${ts('updated_at')} AS updated_at FROM subconscious ORDER BY id`);
        await sameRows('daemon_proposals', `SELECT id, proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id, reason, confidence::text AS confidence, status, ${ts('proposed_at')} AS proposed_at, ${ts('resolved_at')} AS resolved_at FROM daemon_proposals ORDER BY id`, `SELECT id, proposal_type, from_obs_id, to_obs_id, from_entity_id, to_entity_id, reason, confidence::text AS confidence, status, ${ts('proposed_at')} AS proposed_at, ${ts('resolved_at')} AS resolved_at FROM daemon_proposals ORDER BY id`);
        // A dormant observation is translated to an orphan observation (reviewed choice).
        await sameRows('orphan_observations', `SELECT id, observation_id, ${ts('first_marked')} AS first_marked, rescue_attempts, ${ts('last_rescue_attempt')} AS last_rescue_attempt FROM dormant_observations ORDER BY id`, `SELECT id, observation_id, ${ts('first_marked')} AS first_marked, rescue_attempts, ${ts('last_rescue_attempt')} AS last_rescue_attempt FROM orphan_observations ORDER BY id`);
        await sameRows('co_surfacing', `SELECT id, obs_a_id, obs_b_id, co_count, ${ts('last_co_surfaced')} AS last_co_surfaced, relation_proposed, relation_created FROM co_surfacing ORDER BY id`, `SELECT id, obs_a_id, obs_b_id, co_count, ${ts('last_co_surfaced')} AS last_co_surfaced, relation_proposed, relation_created FROM co_surfacing ORDER BY id`);
        // Tensions: sit_count becomes visits; status and sit_notes have no v4 column and the reviewed
        // choice (keep visits, leave open, last visited 2026-01-04) decides the rest.
        expect((await targetClient.query(`SELECT id, pole_a, pole_b, context, visits, ${ts('created_at')} AS created_at, ${ts('last_visited')} AS last_visited, resolved_at, resolution FROM tensions`)).rows)
          .toEqual([{ id: 'ten-1', pole_a: 'speed', pole_b: 'care', context: 'default', visits: 2, created_at: '2026-01-02T16:00:00.000000', last_visited: '2026-01-04T00:00:00.000000', resolved_at: null, resolution: null }]);

        // Legacy vectors never enter v4; each content row is queued for re-embedding instead.
        expect((await targetClient.query("SELECT count(*)::int AS n FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND a.attname = 'embedding' AND NOT a.attisdropped AND c.relkind = 'r' AND c.relname <> 'embeddings'")).rows[0].n).toBe(0);
        expect(plan.reembed_jobs.jobs.length).toBeGreaterThan(0);
        expect(JSON.stringify(plan)).not.toMatch(/0\.125/u);
        const lost = plan.losses.map((loss) => `${loss.kind}:${loss.source_table}.${loss.field}`);
        expect(lost).toEqual(expect.arrayContaining(['dropped-field:observations.charge_note', 'dropped-field:entities.intentionally_isolated', 'dropped-field:embeddings.embedding']));
      } finally {
        await sourceRead.end();
      }
    } finally {
      await runner?.close().catch(() => {});
      await sourceClient?.end().catch(() => {});
      await targetClient?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceDb)} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDb)} WITH (FORCE)`).catch(() => {});
      await admin.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
