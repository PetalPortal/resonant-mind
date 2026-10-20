import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
    const policy = JSON.parse(readFileSync(file('compiled-policy.json'), 'utf8'));
    expect(policy.decision_manifest_sha256).toBe(state.reviewed.manifest_sha256);

    const planned = runCli(['plan-relational', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('passphrase'), '--compiled-policy', file('compiled-policy.json'), '--out', file('plan.json')]);
    expect(planned.status, planned.output).toBe(0);
    expect(planned.stdout).toMatch(/^plan-relational: complete; rows=\d+; losses=\d+; images=0; reembed_jobs=\d+; migration_id=rmig_cli_sqlite_01; bundle_manifest_sha256=[0-9a-f]{64}; compiled_policy_sha256=[0-9a-f]{64}; plan_sha256=[0-9a-f]{64}; out=/u);
    const plan = JSON.parse(readFileSync(file('plan.json'), 'utf8'));
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
    const policy = JSON.parse(readFileSync(file('compiled-policy.json'), 'utf8'));
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

  it('refuses decisions that no longer match the bundle, and a wrong passphrase', () => {
    writeFileSync(file('other-passphrase'), 'not-the-passphrase', { mode: 0o600 });
    const wrong = runCli(['draft-decisions', '--bundle', file('bundle.rmigrate'), '--passphrase-file', file('other-passphrase'), '--out', file('x.json')]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('RMIG-E-BUNDLE-DECRYPT');
    expect(existsSync(file('x.json'))).toBe(false);
  }, 180_000);
});
