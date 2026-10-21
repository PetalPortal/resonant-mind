import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { migrationSetSha256, readV4Migrations, V4_MIGRATION_LOCK_ID, applyV4Migrations } from '../../scripts/migrate-postgres.mjs';
import { CHECKS_SPEC_PATH, generateV4ChecksSpec, loadExpectedChecks } from '../../scripts/v32-to-v4/spec/v4-checks.mjs';
import { postgresClientConfig } from '../../scripts/v32-to-v4/source/postgres-v32.mjs';
import { parseInstantMicros } from '../../scripts/v32-to-v4/lib/instant.mjs';
import { Findings, comparePlanToTarget, evaluableDefault, literalDefault } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { readLiveTarget } from '../../scripts/v32-to-v4/validate/live-target.mjs';
import { adminUrl, hasAdminDatabase, withScratchDatabase } from './helpers/postgres-scratch.mjs';

const { Client } = pg;

describe.skipIf(!hasAdminDatabase)('the released v4 CHECK constraints, against a live PostgreSQL (TEST_ADMIN_DATABASE_URL)', () => {
  it('the committed v4-checks.json is exactly what the released migrations yield on this PostgreSQL', async () => {
    const generated = await generateV4ChecksSpec({ adminUrl });
    let committed;
    try { committed = readFileSync(CHECKS_SPEC_PATH, 'utf8').replaceAll('\r\n', '\n'); } catch { throw new Error(`spec/v4-checks.json is missing; this is what it should hold:\n${generated.text}`); }
    expect(JSON.parse(committed)).toEqual(generated.spec);
    expect(generated.spec.migration_set_sha256).toBe(migrationSetSha256(await readV4Migrations()));
    expect(generated.spec.checks.length).toBeGreaterThan(15);
  }, 120_000);

  it('evaluates the released constraints, and never runs a CHECK the released schema does not have', async () => {
    await withScratchDatabase(async (url) => {
      const setup = new Client({ connectionString: url });
      await setup.connect();
      try {
        await applyV4Migrations({ client: setup, migrations: await readV4Migrations(), lockId: V4_MIGRATION_LOCK_ID });
        // a function that cannot be allowed to run: evaluating it raises, and so does anything that reaches it
        await setup.query("INSERT INTO public.journals (content) VALUES ('a row, so that an evaluated CHECK would really run')");
        await setup.query("CREATE FUNCTION public.rmig_must_not_run(text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RAISE EXCEPTION 'executed from a target CHECK'; END $$");
      } finally { await setup.end(); }

      const read = async () => {
        const client = new Client({ ...postgresClientConfig(url), ssl: false });
        await client.connect();
        const findings = new Findings();
        try { return { live: await readLiveTarget({ client, migrationId: 'rmig_checks_it_01', findings }), findings }; } finally { await client.end(); }
      };

      const clean = await read();
      expect(Object.keys(clean.findings.counts).filter((check) => check.startsWith('check-'))).toEqual([]);
      expect(clean.live.checks.check_constraints).toBe(loadExpectedChecks().checks.length);

      const alter = new Client({ connectionString: url });
      await alter.connect();
      try {
        await alter.query('ALTER TABLE public.journals ADD CONSTRAINT journals_boom CHECK (public.rmig_must_not_run(content)) NOT VALID');
        await alter.query("ALTER TABLE public.journals ADD CONSTRAINT journals_sleep CHECK (pg_catalog.length(pg_catalog.pg_read_file('/etc/hostname')) >= 0) NOT VALID");
      } finally { await alter.end(); }
      const extra = await read(); // it must not throw: nothing the target defines is evaluated
      expect(extra.findings.counts['check-constraint-unexpected']).toBe(2);
      expect(extra.findings.samples.filter((item) => item.check === 'check-constraint-unexpected').map((item) => item.constraint).sort()).toEqual(['journals_boom', 'journals_sleep']);
      expect(extra.live.checks.check_constraints_unexpected).toBe(2);

      // a released constraint whose definition was changed is as unexpected as a new one, and one that was dropped is missing
      const change = new Client({ connectionString: url });
      await change.connect();
      let victim;
      try {
        victim = (await change.query("SELECT conname, conrelid::regclass::text AS table_name FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace AND conname NOT LIKE 'journals_%' ORDER BY conname LIMIT 1")).rows[0];
        await change.query(`ALTER TABLE ${victim.table_name} DROP CONSTRAINT ${victim.conname}`);
      } finally { await change.end(); }
      const dropped = await read();
      expect(dropped.findings.counts['check-constraint-missing']).toBe(1);
    });
  }, 180_000);
  it('flags a unique index it cannot re-prove, reads column defaults and the embedding dimension, and compares unstated target columns', async () => {
    await withScratchDatabase(async (url) => {
      const setup = new Client({ connectionString: url });
      await setup.connect();
      try {
        await applyV4Migrations({ client: setup, migrations: await readV4Migrations(), lockId: V4_MIGRATION_LOCK_ID });
        await setup.query("INSERT INTO public.journals (content) VALUES ('a row the plan states only by id and content')");
      } finally { await setup.end(); }
      const read = async () => {
        const client = new Client({ ...postgresClientConfig(url), ssl: false });
        await client.connect();
        const findings = new Findings();
        try { return { live: await readLiveTarget({ client, migrationId: 'rmig_unique_it_01', findings }), findings }; } finally { await client.end(); }
      };

      // the released schema has no partial or expression unique index, so a clean target has no such finding
      const clean = await read();
      expect(clean.findings.counts['unique-index-unexpected']).toBeUndefined();
      expect(clean.live.embeddingDimension).toBe(768); // the dimension of embeddings.embedding, read from the target's own type
      expect(clean.live.columnDefaults.journals.created_at.default).toMatch(/now\(\)|CURRENT_TIMESTAMP/iu);
      expect(clean.live.columnDefaults.journals.id).toMatchObject({ default: expect.stringContaining('nextval') });

      // a plan row that states only id and content: every other column the target holds is NULL or the database's own default
      const stored = clean.live.tables.journals[0];
      const plan = { members: { journals: [{ id: stored.id, content: stored.content }] } };
      const compare = (live, importedAt = live.importedAt) => comparePlanToTarget({ plan, targetTables: { ...live.tables, journals: live.tables.journals }, columnTypes: live.columnTypes, columnDefaults: live.columnDefaults, importedAt, sequences: live.sequenceRanges });
      const journalFindings = (result) => result.findings.samples.filter((finding) => finding.table === 'journals');
      // created_at is filled by now(): it is the import's time, and this database has no import record to say what that time is,
      // so the cell cannot be confirmed; it is a finding that names the column and the list of unevaluated columns says so
      const unknownTime = compare(clean.live);
      expect(journalFindings(unknownTime)).toEqual([expect.objectContaining({ check: 'default-expression-not-evaluated', column: 'created_at' })]);
      expect(unknownTime.unevaluated_defaults).toEqual([{ table: 'journals', column: 'created_at', cells: 1 }]);
      expect(unknownTime.tables.journals.unstated_cells_compared).toBeGreaterThanOrEqual(5);
      expect(unknownTime.tables.journals.default_expressions_not_evaluated).toBe(1);
      // given the transaction time the row was written in (what an import's now() is), the same cell is exactly the default
      const createdAt = parseInstantMicros(stored.created_at);
      expect(journalFindings(compare(clean.live, createdAt))).toEqual([]);
      expect(compare(clean.live, createdAt).unevaluated_defaults).toEqual([]);
      expect(compare(clean.live, createdAt).tables.journals.default_expressions_not_evaluated).toBe(0);
      // and any other time is not
      expect(journalFindings(compare(clean.live, createdAt + 1n))).toEqual([expect.objectContaining({ check: 'target-column-not-in-plan', column: 'created_at', difference: 'default-differs' })]);
      // the sequence behind journals.id is read with its range, and the value in the column is an integer within it
      expect(clean.live.sequenceRanges['public.journals_id_seq']).toEqual({ min: '1', max: '2147483647' });
      expect(Object.keys(clean.live.sequenceRanges).length).toBeGreaterThan(10);
      // nothing in the released schema is a default this validator cannot evaluate: a migration of the released schema never hits the finding
      const unevaluable = [];
      for (const [tableName, columns] of Object.entries(clean.live.columnDefaults)) for (const [columnName, info] of Object.entries(columns)) {
        if (info.default === null || info.default === undefined || info.generated || info.identity) continue;
        if (!literalDefault(info.default).literal && evaluableDefault(info.default).kind === null) unevaluable.push(`${tableName}.${columnName}: ${info.default}`);
      }
      expect(unevaluable).toEqual([]);

      const alter = new Client({ connectionString: url });
      await alter.connect();
      try {
        await alter.query("UPDATE public.journals SET tags = '[\"added\"]', emotion = 'unplanned' WHERE id = " + String(stored.id));
        await alter.query('CREATE UNIQUE INDEX rmig_partial_uq ON public.journals (content) WHERE content IS NOT NULL');
        await alter.query('CREATE UNIQUE INDEX rmig_expression_uq ON public.journals (lower(content))');
      } finally { await alter.end(); }
      const changed = await read();
      expect(changed.findings.counts['unique-index-unexpected']).toBe(2);
      expect(changed.findings.samples.filter((item) => item.check === 'unique-index-unexpected').map((item) => [item.index, item.reason]).sort()).toEqual([['rmig_expression_uq', 'expression-not-in-the-released-schema'], ['rmig_partial_uq', 'partial-not-in-the-released-schema']]);
      // a value in a column the plan row never states is a finding (journals.tags and journals.emotion have no default)
      const columns = journalFindings(compare(changed.live, createdAt)).filter((finding) => finding.check === 'target-column-not-in-plan').map((finding) => finding.column).sort();
      expect(columns).toEqual(['emotion', 'tags']);
    });
  }, 180_000);

});
