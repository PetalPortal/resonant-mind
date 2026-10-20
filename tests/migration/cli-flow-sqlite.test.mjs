import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readArtifactFile } from './helpers/artifacts.mjs';
import { runCli } from './helpers/cli-run.mjs';
import { SQLITE_REVIEW as REVIEW, createSqliteSource } from './helpers/seeds.mjs';

// The operator flow that needs no database, driven as separate processes against a real SQLite v3.2
// source: inspect, export, verify, draft the decisions, refuse an incomplete or malformed review, apply a
// complete one, compile the policy, build the relational plan. The target phases need PostgreSQL and
// are driven in cli-flow.integration.test.mjs (TEST_ADMIN_DATABASE_URL).
const work = mkdtempSync(join(tmpdir(), 'rmig-cli-sqlite-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name) => join(work, name);
describe('the operator flow through the CLI on a SQLite v3.2 source', () => {
  const state = {};

  it('inspects, exports and verifies', () => {
    createSqliteSource(file('source.sqlite'));
    writeFileSync(file('passphrase'), 'cli-flow-sqlite-passphrase', { mode: 0o600 });
    const inspect = runCli(['inspect-source', '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--report', file('source-report.json')]);
    expect(inspect.status, inspect.output).toBe(0);
    expect(inspect.stdout).toMatch(/^inspect-source: supported sqlite; tables=16; rows=\d+/u);
    const exported = runCli(['export', '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--source-report', file('source-report.json'), '--migration-id', 'rmig_cli_sqlite_01', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')]);
    expect(exported.status, exported.output).toBe(0);
    const verified = runCli(['verify-bundle', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')]);
    expect(verified.status, verified.output).toBe(0);
    expect(verified.stdout).toMatch(/^verify-bundle: valid;/u);
  }, 180_000);

  it('drafts the decisions: every ambiguity is an item with no choice, and nothing is guessed', () => {
    const draft = runCli(['draft-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--out', file('decisions-draft.json')]);
    expect(draft.status, draft.output).toBe(0);
    expect(draft.stdout).toMatch(/^draft-decisions: complete; items=6 \(ambiguous-name-reference=1,dormancy-translation=1,duplicate-entity-name=1,entity-kind=1,tension-state=1,timestamp=1\); reviewed=false; bundle_manifest_sha256=[0-9a-f]{64}; out=/u);
    state.draft = JSON.parse(readFileSync(file('decisions-draft.json'), 'utf8'));
    expect(state.draft).toMatchObject({ reviewed: false, reviewed_by: null, reviewed_at: null, migration_id: 'rmig_cli_sqlite_01' });
    expect([...new Set(state.draft.items.map((item) => item.type))].sort()).toEqual(Object.keys(REVIEW).sort());
    expect(state.draft.items.every((item) => !Object.hasOwn(item, 'choice') && item.allowed_choices.length > 0)).toBe(true);
    const again = runCli(['draft-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--out', file('decisions-draft.json')]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/u);
    expect(JSON.parse(readFileSync(file('decisions-draft.json'), 'utf8'))).toEqual(state.draft);
  }, 180_000);

  it('will not compile an unreviewed draft, and refuses an incomplete or malformed review at apply time', () => {
    const compileDraft = runCli(['compile-policy', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('decisions-draft.json'), '--out', file('never.json')]);
    expect(compileDraft.status).toBe(2);
    expect(compileDraft.stderr).toContain('RMIG-E-POLICY-UNRESOLVED');
    expect(existsSync(file('never.json'))).toBe(false);

    const choose = (item) => ({ ...item, choice: REVIEW[item.type] });
    const incomplete = { ...state.draft, items: state.draft.items.map((item, index) => (index === 0 ? item : choose(item))) };
    writeFileSync(file('incomplete.json'), JSON.stringify(incomplete));
    const refused = runCli(['apply-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('incomplete.json'), '--reviewed-by', 'Test Reviewer', '--out', file('never2.json'), '--json']);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'RMIG-E-POLICY-UNRESOLVED', phase: 'apply-decisions', safe_details: { unresolved: 1 } });
    expect(existsSync(file('never2.json'))).toBe(false);

    for (const [label, wrong] of [['a wildcard', 'accept-all'], ['a choice the item does not allow', 'translate-to-orphan']]) {
      const mutated = { ...state.draft, items: state.draft.items.map((item, index) => ({ ...item, choice: index === 0 ? wrong : REVIEW[item.type] })) };
      writeFileSync(file('wrong.json'), JSON.stringify(mutated));
      const wrongRun = runCli(['apply-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('wrong.json'), '--reviewed-by', 'Test Reviewer', '--out', file('never3.json')]);
      expect(wrongRun.status, label).toBe(2);
      expect(wrongRun.stderr, label).toContain('RMIG-E-POLICY-UNRESOLVED');
      expect(existsSync(file('never3.json')), label).toBe(false);
    }

    const stale = { ...state.draft, bundle_manifest_sha256: 'a'.repeat(64), items: state.draft.items.map(choose) };
    writeFileSync(file('stale.json'), JSON.stringify(stale));
    const staleRun = runCli(['apply-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('stale.json'), '--reviewed-by', 'Test Reviewer', '--out', file('never4.json')]);
    expect(staleRun.status).toBe(2);
    expect(staleRun.stderr).toContain('RMIG-E-POLICY-MISMATCH');

    // a decision file drafted for another migration is refused at apply time, even with a complete review
    const elsewhere = { ...state.draft, migration_id: 'rmig_another_run_99', items: state.draft.items.map(choose) };
    writeFileSync(file('elsewhere.json'), JSON.stringify(elsewhere));
    const elsewhereRun = runCli(['apply-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('elsewhere.json'), '--reviewed-by', 'Test Reviewer', '--out', file('never5.json')]);
    expect(elsewhereRun.status).toBe(2);
    expect(elsewhereRun.stderr).toContain('RMIG-E-POLICY-MISMATCH');
    expect(elsewhereRun.stderr).toContain('different migration');
    expect(existsSync(file('never5.json'))).toBe(false);
  }, 180_000);

  it('applies a complete review, compiles the policy and builds the relational plan', () => {
    const reviewedDraft = { ...state.draft, items: state.draft.items.map((item) => ({ ...item, choice: REVIEW[item.type] })) };
    writeFileSync(file('decisions-edited.json'), JSON.stringify(reviewedDraft, null, 2));
    const applied = runCli(['apply-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('decisions-edited.json'), '--reviewed-by', 'Test Reviewer', '--out', file('decisions-reviewed.json')]);
    expect(applied.status, applied.output).toBe(0);
    expect(applied.stdout).toMatch(/^apply-decisions: complete; items=\d+; reviewed_by="Test Reviewer"; manifest_sha256=[0-9a-f]{64}; out=/u);
    state.reviewed = JSON.parse(readFileSync(file('decisions-reviewed.json'), 'utf8'));
    expect(state.reviewed).toMatchObject({ reviewed: true, reviewed_by: 'Test Reviewer' });
    expect(state.reviewed.reviewed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const compiled = runCli(['compile-policy', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--decisions', file('decisions-reviewed.json'), '--out', file('compiled-policy.json')]);
    expect(compiled.status, compiled.output).toBe(0);
    const policy = readArtifactFile(file('compiled-policy.json'), 'compiled-policy', file('passphrase'));
    expect(compiled.stdout).toMatch(/^compile-policy: complete; plan_sha256=[0-9a-f]{64}; losses=\d+; encrypted; out=/u);
    expect(policy.decision_manifest_sha256).toBe(state.reviewed.manifest_sha256);

    const planned = runCli(['plan-relational', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--compiled-policy', file('compiled-policy.json'), '--out', file('plan.json')]);
    expect(planned.status, planned.output).toBe(0);
    expect(planned.stdout).toMatch(/^plan-relational: complete; rows=\d+; losses=\d+; images=0; reembed_jobs=\d+; migration_id=rmig_cli_sqlite_01; bundle_manifest_sha256=[0-9a-f]{64}; compiled_policy_sha256=[0-9a-f]{64}; plan_sha256=[0-9a-f]{64}; encrypted; out=/u);
    const plan = readArtifactFile(file('plan.json'), 'relational-plan', file('passphrase'));
    expect(planned.stdout).toContain('; encrypted; out=');
    expect(plan.compiled_policy_sha256).toBe(policy.plan_sha256);
    expect(plan.members.nodes.map((row) => row.name).sort()).toEqual(['Ada (work)', 'Rhizome']);
    expect(plan.members.people.map((row) => row.name)).toEqual(['Ada (person)']);
    expect(plan.members.observations.find((row) => row.id === 10)).toMatchObject({ weight: 'light', last_surfaced_at: '2026-02-03T03:05:06.000Z', person_id: 1, source_date: '2026-01-02' });
    expect(plan.members.relations[0]).toMatchObject({ from_entity: 'Ada (person)', to_entity: 'Rhizome' });
    expect(plan.members.orphan_observations).toHaveLength(1);
    expect(plan.members.tensions[0]).toMatchObject({ visits: 3, last_visited: '2026-01-07T00:00:00.000Z' });
    expect(plan.losses.map((loss) => `${loss.kind}:${loss.field}`)).toEqual(expect.arrayContaining(['null-replaced-by-v4-default:updated_at']));
    expect(plan.legacy_vectors_imported).toBe(false);
    state.plan = plan;
  }, 180_000);

  it('refuses a policy that was changed after compile-policy wrote it, and never overwrites an earlier plan', () => {
    const policy = readArtifactFile(file('compiled-policy.json'), 'compiled-policy', file('passphrase'));
    policy.excluded_rows = [...policy.excluded_rows, `observations:${'0'.repeat(64)}`];
    writeFileSync(file('tampered-policy.json'), JSON.stringify(policy));
    const tampered = runCli(['plan-relational', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--compiled-policy', file('tampered-policy.json'), '--out', file('plan-tampered.json')]);
    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toContain('RMIG-E-POLICY-MISMATCH');
    expect(existsSync(file('plan-tampered.json'))).toBe(false);
    const again = runCli(['plan-relational', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--compiled-policy', file('compiled-policy.json'), '--out', file('plan.json')]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/u);
  }, 180_000);

  it('writes the compiled policy and the plan encrypted, plaintext only on both flags, opens either form, and never replaces an earlier file', () => {
    // encrypted by default: the file is not JSON and holds none of the migrated content
    for (const name of ['compiled-policy.json', 'plan.json']) {
      const raw = readFileSync(file(name));
      expect(raw.subarray(0, 8).toString('ascii'), name).toBe('RMIGART2');
      expect(raw.toString('latin1'), name).not.toContain('Rhizome');
      expect(raw.toString('latin1'), name).not.toContain('Ada (work)');
    }
    const decisions = ['--decisions', file('decisions-reviewed.json')];
    const bundle = ['--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')];

    // one acknowledgement flag is not enough, for either command
    for (const flag of ['--allow-plaintext-artifact', '--acknowledge-plaintext-risk']) {
      const one = runCli(['compile-policy', ...bundle, ...decisions, '--out', file('one-flag.json'), flag]);
      expect(one.status, flag).toBe(2);
      expect(one.stderr, flag).toContain('RMIG-E-BUNDLE-PLAINTEXT-ACK');
      expect(existsSync(file('one-flag.json')), flag).toBe(false);
    }
    const planOne = runCli(['plan-relational', ...bundle, '--compiled-policy', file('compiled-policy.json'), '--out', file('one-flag-plan.json'), '--allow-plaintext-artifact']);
    expect(planOne.stderr).toContain('RMIG-E-BUNDLE-PLAINTEXT-ACK');

    // both flags: readable canonical JSON, and every reader accepts it
    const plain = runCli(['compile-policy', ...bundle, ...decisions, '--out', file('policy-plain.json'), '--allow-plaintext-artifact', '--acknowledge-plaintext-risk']);
    expect(plain.status, plain.output).toBe(0);
    expect(plain.stdout).toContain('PLAINTEXT');
    expect(readFileSync(file('policy-plain.json'), 'utf8')).toContain('Rhizome');
    expect(readArtifactFile(file('policy-plain.json'), 'compiled-policy').plan_sha256).toBe(readArtifactFile(file('compiled-policy.json'), 'compiled-policy', file('passphrase')).plan_sha256);
    const planPlain = runCli(['plan-relational', ...bundle, '--compiled-policy', file('policy-plain.json'), '--out', file('plan-plain.json'), '--allow-plaintext-artifact', '--acknowledge-plaintext-risk']);
    expect(planPlain.status, planPlain.output).toBe(0);
    expect(JSON.parse(readFileSync(file('plan-plain.json'), 'utf8')).plan_sha256).toBe(state.plan.plan_sha256);
    // an encrypted plan built from the encrypted policy has the same content as the plaintext route
    const planFromSealed = runCli(['plan-relational', ...bundle, '--compiled-policy', file('compiled-policy.json'), '--out', file('plan-from-sealed.json')]);
    expect(planFromSealed.status, planFromSealed.output).toBe(0);
    expect(readArtifactFile(file('plan-from-sealed.json'), 'relational-plan', file('passphrase')).plan_sha256).toBe(state.plan.plan_sha256);

    // a wrong passphrase, a missing one, and an artifact of the wrong kind are refused
    writeFileSync(file('other-passphrase-2'), 'not-the-passphrase', { mode: 0o600 });
    const readsOther = runCli(['plan-images', '--plan', file('plan.json'), '--passphrase-file', file('other-passphrase-2'), '--out', file('images-wrong.json')]);
    expect(readsOther.status).toBe(2);
    expect(readsOther.stderr).toContain('RMIG-E-BUNDLE-DECRYPT');
    const noKey = runCli(['plan-images', '--plan', file('plan.json'), '--out', file('images-nokey.json')], { RM_MIGRATION_PASSPHRASE_FILE: '' });
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toContain('RMIG-E-BUNDLE-DECRYPT');
    const wrongKind = runCli(['plan-relational', ...bundle, '--compiled-policy', file('plan.json'), '--out', file('plan-wrongkind.json')]);
    expect(wrongKind.status).toBe(2);
    expect(wrongKind.stderr).toContain('RMIG-E-BUNDLE-DECRYPT');
    expect(existsSync(file('plan-wrongkind.json'))).toBe(false);

    // nothing replaces an earlier file: compile-policy, plan-images, plan-reembed
    const before = readFileSync(file('compiled-policy.json'));
    const again = runCli(['compile-policy', ...bundle, ...decisions, '--out', file('compiled-policy.json')]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/u);
    expect(readFileSync(file('compiled-policy.json')).equals(before)).toBe(true);
    const images = runCli(['plan-images', '--plan', file('plan.json'), '--passphrase-file', file('passphrase'), '--out', file('image-plan.json')]);
    expect(images.status, images.output).toBe(0);
    expect(JSON.parse(readFileSync(file('image-plan.json'), 'utf8'))).toEqual(state.plan.image_inventory);
    const imagesAgain = runCli(['plan-images', '--plan', file('plan.json'), '--passphrase-file', file('passphrase'), '--out', file('image-plan.json')]);
    expect(imagesAgain.status).toBe(2);
    expect(imagesAgain.stderr).toMatch(/already exists/u);
    const reembed = ['plan-reembed', '--input', file('plan.json'), '--passphrase-file', file('passphrase'), '--migration-id', 'rmig_cli_sqlite_01', '--out', file('reembed-plan.json')];
    expect(runCli(reembed).status).toBe(0);
    const reembedAgain = runCli(reembed);
    expect(reembedAgain.status).toBe(2);
    expect(reembedAgain.stderr).toMatch(/already exists/u);
    // --plan carries its own bindings; mixing them with the standalone options is refused
    const mixed = runCli(['plan-images', '--plan', file('plan.json'), '--passphrase-file', file('passphrase'), '--migration-id', 'rmig_cli_sqlite_01', '--out', file('image-plan-2.json')]);
    expect(mixed.status).toBe(2);
    expect(existsSync(file('image-plan-2.json'))).toBe(false);
  }, 240_000);

  it('refuses decisions that no longer match the bundle, and a wrong passphrase', () => {
    writeFileSync(file('other-passphrase'), 'not-the-passphrase', { mode: 0o600 });
    const wrong = runCli(['draft-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('other-passphrase'), '--out', file('x.json')]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('RMIG-E-BUNDLE-DECRYPT');
    expect(existsSync(file('x.json'))).toBe(false);
  }, 180_000);

  it('refuses validate before it touches the target when an input is missing, wrong or unreachable, and leaks no connection string', () => {
    const bundle = ['--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase')];
    const base = (target) => ['validate', ...bundle, '--decisions', file('decisions-reviewed.json'), '--plan', file('plan.json'), '--source-kind', 'sqlite', '--source', file('source.sqlite'), '--target', target, '--migration-id', 'rmig_cli_sqlite_01', '--dry-run-receipt', file('dummy-receipt.json'), '--import-receipt', file('dummy-receipt.json')];
    writeFileSync(file('dummy-receipt.json'), '{}');
    const missing = runCli(['validate', ...bundle, '--out', file('v.json')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/^RMIG-E-SOURCE-ARG: validate requires /u);
    const unknown = runCli([...base('env:RMIG_TARGET'), '--out', file('v.json'), '--target-catalog', 'x']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('RMIG-E-SOURCE-ARG');
    const wrongKind = runCli([...base('env:RMIG_TARGET').map((value) => (value === 'sqlite' ? 'postgres' : value)), '--out', file('v.json')]);
    expect(wrongKind.status).toBe(2);
    expect(wrongKind.stderr).toContain('source kind');
    const wrongId = runCli([...base('env:RMIG_TARGET').map((value) => (value === 'rmig_cli_sqlite_01' ? 'rmig_other_run_01' : value)), '--out', file('v.json')]);
    expect(wrongId.status).toBe(2);
    expect(wrongId.stderr).toContain('migration id');
    const literal = runCli([...base('postgres://someone:hunter2@db.invalid/mind'), '--out', file('v.json')]);
    expect(literal.status).toBe(2);
    expect(`${literal.stdout}${literal.stderr}`).not.toContain('hunter2');
    const unset = runCli([...base('env:RMIG_TARGET_NOT_SET'), '--out', file('v.json')], { RMIG_TARGET_NOT_SET: '' });
    expect(unset.status).toBe(2);
    expect(unset.stderr).toContain('RMIG-E-SOURCE-ARG');
    const unreachable = runCli([...base('env:RMIG_TARGET_DEAD'), '--out', file('v.json')], { RMIG_TARGET_DEAD: 'postgres://someone:hunter2@127.0.0.1:1/mind?sslmode=disable' });
    expect(unreachable.status, unreachable.output).toBe(2);
    expect(unreachable.stderr).toContain('RMIG-E-TARGET-SCHEMA');
    expect(unreachable.output).not.toContain('hunter2');
    expect(existsSync(file('v.json'))).toBe(false);
  }, 180_000);
});
