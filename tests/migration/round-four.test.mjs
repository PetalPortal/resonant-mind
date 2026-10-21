import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { exactNumberText, hasDuplicateKeys, jsonSurvivesParsing, losslessCanonical, numbersSurviveParsing, sameJsonLossless } from '../../scripts/v32-to-v4/lib/lossless-json.mjs';
import { decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { normalizeJson } from '../../scripts/v32-to-v4/transform/value-map.mjs';
import { comparePlanToTarget, literalDefault, planCellMismatch, sameJson, unstatedCellState } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { isSealed, openSealedJson, sealJson } from '../../scripts/v32-to-v4/lib/sealed.mjs';
import { readArtifact, writeArtifactNew } from '../../scripts/v32-to-v4/commands/artifacts.mjs';
import { MigrationRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';
import { sealReport } from '../../scripts/v32-to-v4/lib/report-seal.mjs';
import { STATUS_EXIT_CODES, humanStatusResult, statusCommand, statusExitCode } from '../../scripts/v32-to-v4/commands/status.mjs';
import { observeImageObjects, parseValidateArgs } from '../../scripts/v32-to-v4/commands/validate.mjs';
import { determineMigrationStatus, stateBasis } from '../../scripts/v32-to-v4/validate/reconcile.mjs';
import { embeddingDimensionOf } from '../../scripts/v32-to-v4/validate/live-target.mjs';
import { runCli } from './helpers/cli-run.mjs';

const work = mkdtempSync(join(tmpdir(), 'rmig-round-four-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name, text) => { const path = join(work, name); writeFileSync(path, text, { mode: 0o600 }); return path; };

// ---------------------------------------------------------------------------------------------------------
describe('JSON: a repeated key hides a value, so it is refused at any depth', () => {
  it('sees a repeated key where JSON.parse keeps only the last', () => {
    expect(JSON.parse('{"a":12345678901234567891,"a":1}')).toEqual({ a: 1 });
    expect(hasDuplicateKeys('{"a":12345678901234567891,"a":1}')).toBe(true);
    expect(hasDuplicateKeys('{"a":1,"b":{"c":[{"d":1,"d":2}]}}')).toBe(true); // deep, inside an array inside an object
    expect(hasDuplicateKeys('[{"x":1},{"x":2}]')).toBe(false); // the same key in two different objects is fine
    expect(hasDuplicateKeys('{"a":{"a":1},"b":{"a":2}}')).toBe(false);
    expect(hasDuplicateKeys('{"a":1,"\\u0061":2}')).toBe(true); // an escape spells the same key
    expect(hasDuplicateKeys('{"a":"a","b":"a,\\"a\\":"}')).toBe(false); // keys are not guessed from string values
    expect(hasDuplicateKeys('not json')).toBe(false); // another finding's business
  });

  it('makes JSON with a repeated key a comparison failure, not a quiet match', () => {
    expect(sameJsonLossless('{"a":1,"a":2}', '{"a":2}')).toBe(false);
    expect(sameJson('{"a":1,"a":2}', '{"a":1,"a":2}')).toBe(false);
    expect(() => losslessCanonical('{"a":{"b":1,"b":1}}')).toThrow(/repeats/u);
    expect(sameJsonLossless('{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true);
    expect(planCellMismatch({ table: 'subconscious', column: 'data', value: '{"n":1,"n":2}', dbValue: '{"n": 2}', columnType: 'jsonb', importedAt: null })).toBe('json');
  });

  it('does not let the number check pass a document whose big number is hidden by a later key', () => {
    expect(numbersSurviveParsing('{"a":12345678901234567891,"a":1}')).toBe(true); // JSON.parse sees only the 1
    expect(jsonSurvivesParsing('{"a":12345678901234567891,"a":1}')).toBe(false);
    expect(jsonSurvivesParsing('{"a":1,"b":[1,2.5]}')).toBe(true);
    expect(jsonSurvivesParsing('not json')).toBe(true);
  });

  const bundle = {
    migration_id: 'rmig_dupkeys_test', bundle_manifest_sha256: 'b'.repeat(64),
    tables: { entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default' }], subconscious: [{ id: 1, state_type: 'mood', data: '{"a":12345678901234567891,"a":1}', updated_at: '2026-01-02T08:00:00Z' }] },
  };

  it('raises a malformed-json decision item, and normalizes the value only through a reviewed choice', () => {
    const items = generateDecisionItems(bundle).filter((item) => item.type === 'malformed-json');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ field: 'data', source_table: 'subconscious' });
    expect(() => normalizeJson('{"a":1,"a":2}', 'object')).toThrow(/reviewed/u);
    expect(normalizeJson('{"a":1,"b":2}', 'object')).toEqual({ a: 1, b: 2 });
    expect(normalizeJson('{"a":1,"a":2}', 'object', { choice: { action: 'map-json', value: { a: 2 } } })).toEqual({ a: 2 });
  });

  it('compiles only once the item is decided', () => {
    const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    manifest.items = manifest.items.map((item) => ({ ...item, stated_by: 'owner', choice: { action: 'map-json', value: { a: 1 } } }));
    manifest.reviewed = true; manifest.reviewed_by = 'test'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
    expect(compilePolicy({ bundle, decisions: manifest }).value_map.json).toBeTruthy();
  });
});

describe('JSON numbers are compared exactly on their decimal value, exponent included', () => {
  it('tells apart numbers whose exponents differ beyond 2^53', () => {
    expect(Number('9007199254740993')).toBe(Number('9007199254740992')); // a double cannot hold the difference
    expect(sameJsonLossless('1e9007199254740993', '1e9007199254740992')).toBe(false);
    expect(sameJsonLossless('[1e9007199254740993]', '[1e9007199254740993]')).toBe(true);
    expect(sameJsonLossless('1e-9007199254740993', '1e-9007199254740992')).toBe(false);
    expect(exactNumberText('1e9007199254740993')).toBe('1e9007199254740993');
    expect(exactNumberText('10e9007199254740992')).toBe('1e9007199254740993'); // trailing zeros move into the exponent exactly
    expect(exactNumberText('0.5e9007199254740994')).toBe('5e9007199254740993');
    expect(numbersSurviveParsing('1e9007199254740993')).toBe(false); // and such a number is a decision, not a silent Infinity
  });

  it('keeps every other spelling of one value equal and every other digit apart', () => {
    expect(sameJsonLossless('[1.0, 2e2, 0.50]', '[1, 200, 0.5]')).toBe(true);
    expect(sameJsonLossless('1.0000000000000000000001', '1')).toBe(false);
    expect(sameJsonLossless('-1', '1')).toBe(false);
    expect(sameJsonLossless('1e400', '1e401')).toBe(false);
  });

  it('decides that zero has no sign: -0 equals 0, because PostgreSQL numeric cannot hold a negative zero', () => {
    expect(sameJsonLossless('-0', '0')).toBe(true);
    expect(sameJsonLossless('[-0.0, -0e5]', '[0, 0]')).toBe(true);
    expect(exactNumberText('-0')).toBe('0');
    expect(exactNumberText('-0.000')).toBe('0');
    expect(sameJsonLossless('{"z":-0}', '{"z":0.0}')).toBe(true);
    expect(sameJsonLossless('-1e-9007199254740993', '1e-9007199254740993')).toBe(false); // a signed non-zero value keeps its sign
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('the plan is compared with every column the target holds, not only the columns the plan states', () => {
  const plan = { members: { journals: [{ id: 1, content: 'a day', journal_type: null }] } };
  const target = (extra = {}) => ({ journals: [{ id: 1, content: 'a day', journal_type: null, ...extra }] });
  const compare = (targetTables, columnDefaults = {}, columnTypes = {}) => comparePlanToTarget({ plan, targetTables, columnTypes, columnDefaults, importedAt: null });

  it('finds a value in a column the plan row never mentions', () => {
    const clean = compare(target());
    expect(clean.findings.samples).toEqual([]);
    const extra = compare(target({ tags: '["x"]' }));
    expect(extra.findings.counts['target-column-not-in-plan']).toBe(1);
    expect(extra.findings.samples[0]).toMatchObject({ check: 'target-column-not-in-plan', table: 'journals', column: 'tags', difference: 'unplanned-value' });
    expect(JSON.stringify(extra.findings.samples)).not.toContain('"x"'); // the finding names the column, never the value
    expect(extra.tables.journals.unstated_cells_compared).toBeGreaterThanOrEqual(1);
  });

  it('accepts only NULL, the database own default, or a column the database computes', () => {
    const columnDefaults = { journals: { entry_date: { default: "'none'::text" }, tags: { default: null }, emotion: { default: 'lower(\'X\'::text)' }, created_at: { default: 'now()' }, journal_type: { default: null, generated: true } } };
    expect(compare(target({ entry_date: 'none' }), columnDefaults).findings.samples).toEqual([]);
    expect(compare(target({ entry_date: 'other' }), columnDefaults).findings.samples[0]).toMatchObject({ column: 'entry_date', difference: 'default-differs' });
    expect(compare(target({ tags: 'x' }), columnDefaults).findings.samples[0]).toMatchObject({ column: 'tags', difference: 'unplanned-value' });
    expect(compare(target({ tags: null, entry_date: null }), columnDefaults).findings.samples).toEqual([]);
    // a default that is an expression the tool cannot evaluate (here lower(...)) is never accepted: it is a finding naming the column
    const expression = compare(target({ emotion: 'x' }), columnDefaults);
    expect(expression.findings.samples).toEqual([expect.objectContaining({ check: 'default-expression-not-evaluated', table: 'journals', column: 'emotion' })]);
    expect(expression.tables.journals.default_expressions_not_evaluated).toBe(1);
    expect(expression.unevaluated_defaults).toEqual([{ table: 'journals', column: 'emotion', cells: 1 }]);
    expect(JSON.stringify(expression.findings.samples)).not.toContain('"x"');
  });

  it('knows a literal default when it sees one, and never evaluates anything else', () => {
    expect(literalDefault("'active'::text")).toEqual({ literal: true, value: 'active' });
    expect(literalDefault("'it''s'::character varying")).toEqual({ literal: true, value: "it's" });
    expect(literalDefault("'[]'::text")).toEqual({ literal: true, value: '[]' }); // a literal that looks like an array is still a text literal
    expect(unstatedCellState({ dbValue: '["added"]', columnInfo: { default: "'[]'::text" } })).toBe('default-differs');
    expect(unstatedCellState({ dbValue: '[]', columnInfo: { default: "'[]'::text" } })).toBe('default');
    expect(literalDefault('0')).toEqual({ literal: true, value: 0, numeric: true });
    expect(literalDefault('1.5')).toEqual({ literal: true, value: 1.5, numeric: true });
    expect(literalDefault('false')).toEqual({ literal: true, value: false });
    expect(literalDefault("'{}'::jsonb")).toEqual({ literal: true, value: '{}' });
    for (const expression of ['now()', "nextval('s'::regclass)", "('a'::text || 'b'::text)", "'{}'::integer[]", null, undefined]) expect(literalDefault(expression), String(expression)).toEqual({ literal: false });
    expect(unstatedCellState({ dbValue: '{ }', columnInfo: { default: "'{}'::jsonb" } })).toBe('default'); // the same json value, spelled differently
    expect(unstatedCellState({ dbValue: 3, columnInfo: { default: '3' } })).toBe('default');
    expect(unstatedCellState({ dbValue: 'x', columnInfo: undefined })).toBe('unplanned-value');
    expect(unstatedCellState({ dbValue: null, columnInfo: undefined })).toBe('absent');
  });

  it('re-derives the one column a released v4 trigger fills in (identity.kind) instead of trusting the stored value', () => {
    const identityPlan = { members: { identity: [{ id: 1, section: 'Core.Beliefs', content: 'x' }, { id: 2, section: 'self.voice', content: 'y' }] } };
    const stored = (kindOne, kindTwo) => ({ identity: [{ id: 1, section: 'Core.Beliefs', content: 'x', kind: kindOne }, { id: 2, section: 'self.voice', content: 'y', kind: kindTwo }] });
    const run = (tables) => comparePlanToTarget({ plan: identityPlan, targetTables: tables, columnTypes: {}, columnDefaults: {}, importedAt: null }).findings;
    // the trigger folds first and lower-cases after, so 'Core' becomes '_ore'
    expect(run(stored('_ore', 'self')).samples.filter((finding) => finding.table === 'identity')).toEqual([]);
    const wrong = run(stored('core', 'self')).samples.filter((finding) => finding.table === 'identity');
    expect(wrong).toEqual([expect.objectContaining({ check: 'target-column-not-in-plan', column: 'kind', difference: 'derived-value-differs' })]);
    expect(unstatedCellState({ table: 'identity', column: 'kind', row: { section: 'a.b', kind: 'a' } })).toBe('derived');
    expect(unstatedCellState({ table: 'identity', column: 'kind', row: { section: 'a.b', kind: 'b' } })).toBe('derived-value-differs');
  });

  it('reads the embedding dimension from the type the target gives its embedding column', () => {
    expect(embeddingDimensionOf({ embeddings: { embedding: 'vector(768)' } })).toBe(768);
    expect(embeddingDimensionOf({ embeddings: { embedding: 'vector' } })).toBeNull();
    expect(embeddingDimensionOf({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('a sealed artifact is bound to its migration', () => {
  const passphrase = Buffer.from('round-four-passphrase');
  const content = (migration_id) => ({ plan_type: 'x', migration_id, members: { journals: [{ id: 1, content: 'private' }] } });

  it('refuses to seal an artifact that does not say which migration it belongs to', () => {
    expect(() => sealJson({ plan_type: 'x' }, { kind: 'relational-plan', passphrase })).toThrow(/migration_id/u);
  });

  it('round-trips for its own migration and refuses another one the caller names', () => {
    const sealed = sealJson(content('rmig_round_four_a'), { kind: 'relational-plan', passphrase });
    expect(isSealed(sealed)).toBe(true);
    expect(openSealedJson(sealed, { kind: 'relational-plan', passphrase, phase: 'validate' })).toEqual(content('rmig_round_four_a'));
    expect(openSealedJson(sealed, { kind: 'relational-plan', passphrase, phase: 'validate', migrationId: 'rmig_round_four_a' })).toEqual(content('rmig_round_four_a'));
    expect(() => openSealedJson(sealed, { kind: 'relational-plan', passphrase, phase: 'validate', migrationId: 'rmig_round_four_b' })).toThrow(/different migration id/u);
  });

  it('authenticates the migration id in the header: changing it fails, even to another real one', () => {
    const sealed = sealJson(content('rmig_round_four_a'), { kind: 'relational-plan', passphrase });
    const swapped = Buffer.from(sealed);
    swapped.write('b', 8 + 2 + 'rmig_round_four_'.length, 'ascii'); // the last letter of the id in the header
    expect(swapped.subarray(10, 10 + 17).toString()).toBe('rmig_round_four_b');
    expect(() => openSealedJson(swapped, { kind: 'relational-plan', passphrase, phase: 'validate' })).toThrow(MigrationRefusal);
    expect(() => openSealedJson(swapped, { kind: 'relational-plan', passphrase, phase: 'validate', migrationId: 'rmig_round_four_b' })).toThrow(MigrationRefusal);
  });

  it('reads through the commands with the migration the command is working on', () => {
    const passphraseFile = file('round-four-pass', 'round-four-passphrase');
    const path = join(work, 'plan.bin');
    writeArtifactNew('plan-relational', path, content('rmig_round_four_a'), { kind: 'relational-plan', passphraseFile });
    expect(readArtifact('validate', path, 'The plan', { kind: 'relational-plan', passphraseFile, migrationId: 'rmig_round_four_a' })).toEqual(content('rmig_round_four_a'));
    expect(() => readArtifact('validate', path, 'The plan', { kind: 'relational-plan', passphraseFile, migrationId: 'rmig_round_four_b' })).toThrow(/different migration id/u);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('status says what it read, from when, and what each part rests on', () => {
  const passphrase = 'round-four-status-passphrase';
  const passphraseFile = file('status-pass', passphrase);
  const IDENTITY = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
  function report(overrides = {}) {
    const body = {
      format_version: 1, report_type: 'migration-reconciliation', validation_mode: 'live', validated_at: '2026-10-20T10:00:00.000Z', migration_id: 'rmig_status_four_01', counts: {},
      target: { identity_sha256: IDENTITY }, violations: [], violation_counts: {}, target_present: true, exported: true, dry_run_receipt_complete: true, import_receipt_complete: true, imported: true,
      relational_reconciliation_complete: true, images_complete: true, reembed_complete: true,
      images: { basis: 'tool-rehashed-source-and-target' }, reembed: { basis: 'receipts-attested', observed_by_tool: false }, ...overrides,
    };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    body.status = determineMigrationStatus(body, { requireReportHash: false });
    body.report_sha256 = canonicalSha256(body);
    return { ...body, report_seal: sealReport(body, Buffer.from(passphrase)) };
  }

  it('reports a historical fact: as of validate, for that target, not a check of the target now', () => {
    const result = statusCommand({ report: report(), passphraseFile });
    expect(result).toMatchObject({ status: 'ready-for-cutover', report_verified: true, as_of_validation: true, current_target_checked: false, validated_at: '2026-10-20T10:00:00.000Z', target_identity_sha256: IDENTITY });
    const line = humanStatusResult(result);
    expect(line).toMatch(/^status: ready-for-cutover; report_verified=true;/u);
    expect(line).toContain('This is what validate proved at 2026-10-20T10:00:00.000Z for target ab12cd34ef56ab12');
    expect(line).toContain('not a check of the target now');
    expect(line).toContain('Only running validate again checks the current target');
    expect(line).toContain('current_target_checked=false');
  });

  it('says plainly when the report does not record the time or the target', () => {
    const old = report({ validated_at: undefined, target: undefined });
    const line = humanStatusResult(statusCommand({ report: old, passphraseFile }));
    expect(line).toContain('at a time the report does not record for a target the report does not identify');
  });

  it('names what is verified by the tool and what is only attested', () => {
    const ready = statusCommand({ report: report(), passphraseFile });
    expect(ready.basis).toEqual({ relational: 'verified-by-tool', images: 'tool-rehashed-source-and-target', images_fingerprint: 'source-now', reembed: 'attested-by-receipts', cutover: 'none' });
    expect(humanStatusResult(ready)).toContain('reembedding=attested-by-receipts (attested by receipts, not observed); cutover=none');
    const signed = statusCommand({ report: report({ images: { basis: 'signed-receipt-attested' } }), passphraseFile });
    expect(signed.basis.images).toBe('signed-receipt-attested');
    expect(humanStatusResult(signed)).toContain('images=signed-receipt-attested (attested by a signed receipt, not observed by the tool)');
    // the tool re-reading the objects is said to be that, and what it held them to
    expect(humanStatusResult(ready)).toContain('images=tool-rehashed-source-and-target (the tool re-hashed the source objects and the copied objects now: they are the same, and they match the copy receipt)');
    const recorded = statusCommand({ report: report({ images: { basis: 'signed-receipt-rehashed-target', expected_values: { from_plan: 0, from_receipt_fingerprint: 2 } } }), passphraseFile });
    expect(recorded.basis).toMatchObject({ images: 'signed-receipt-rehashed-target', images_fingerprint: 'copy-time-receipt' });
    expect(humanStatusResult(recorded)).toContain('images=signed-receipt-rehashed-target (the tool re-hashed the copied objects and they match a receipt signed by a key the operator trusts; the original sources were not read)');
    const planned = statusCommand({ report: report({ images: { basis: 'tool-rehashed-target-against-plan', expected_values: { from_plan: 2, from_receipt_fingerprint: 0 } } }), passphraseFile });
    expect(planned.basis).toMatchObject({ images: 'tool-rehashed-target-against-plan', images_fingerprint: 'plan' });
    expect(humanStatusResult(planned)).toContain('they match the values the plan states; the original sources were not read');
    // the name an earlier build gave the basis is not a basis any more
    expect(statusCommand({ report: report({ images: { basis: 'tool-rehashed-objects' } }), passphraseFile }).basis.images).toBe('complete-basis-not-recorded');
    expect(stateBasis(report({ images_complete: false, reembed_complete: false })).images).toBe('pending');
    expect(stateBasis(report({ images_complete: false, reembed_complete: false })).reembed).toBe('pending');
    expect(stateBasis({ relational_reconciliation_complete: false }).relational).toBe('not-established');
  });

  it('calls a cutover the operator evidenced attested, never verified', () => {
    const sealed = report();
    const body = { format_version: 1, evidence_type: 'operator-cutover', migration_id: sealed.migration_id, report_sha256: sealed.report_sha256, operator_action: { performed: true, actor: 'operator', performed_at: '2026-10-20T12:00:00Z', change_id: 'chg-1' }, readback: { verified: true, verified_at: '2026-10-20T12:05:00Z', observed_version: 'v4.0.1' } };
    const evidence = { ...body, evidence_sha256: canonicalSha256(body) };
    const result = statusCommand({ report: sealed, passphraseFile, evidence });
    expect(result.status).toBe('complete-operator-attested');
    expect(result.basis.cutover).toBe('attested-by-operator');
    expect(humanStatusResult(result)).toContain("cutover=attested-by-operator (the operator's statement, not observed)");
  });

  it('exits 0 for a state it could read, 2 for one it refused and 3 for a report it cannot verify, through the CLI', () => {
    const sealed = report();
    const path = file('four-report.json', JSON.stringify(sealed));
    const ok = runCli(['status', '--report', path, '--passphrase-file', passphraseFile]);
    expect(ok.status, ok.output).toBe(0);
    expect(ok.stdout).toContain('not a check of the target now');
    const json = runCli(['status', '--report', path, '--passphrase-file', passphraseFile, '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ as_of_validation: true, current_target_checked: false });
    const edited = file('four-edited.json', JSON.stringify({ ...sealed, images_complete: false }));
    const refused = runCli(['status', '--report', edited, '--passphrase-file', passphraseFile]);
    expect(refused.status).toBe(2);
    expect(refused.stdout).not.toContain('not a check of the target now');

    // A report with no seal is read for what it claims and proves nothing: not 0, so a script that gates on the exit code stops, and not 2, which is a refusal
    const { report_seal: _seal, ...unsealed } = sealed;
    const unsealedPath = file('four-unsealed.json', JSON.stringify(unsealed));
    const unverified = runCli(['status', '--report', unsealedPath, '--passphrase-file', passphraseFile]);
    expect(unverified.status, unverified.output).toBe(3);
    expect(unverified.stdout).toContain('status: unverified (NOT proof; the report claimed ready-for-cutover); exit code 3;');
    const unverifiedJson = runCli(['status', '--report', unsealedPath, '--json']);
    expect(unverifiedJson.status, unverifiedJson.output).toBe(3);
    expect(JSON.parse(unverifiedJson.stdout)).toMatchObject({ status: 'unverified', report_verified: false, claimed_status: 'ready-for-cutover' });
  });

  it('has one exit code per outcome, and none of them is shared', () => {
    expect(STATUS_EXIT_CODES).toEqual({ verified: 0, refused: 2, unverified: 3 });
    expect(statusExitCode({ status: 'ready-for-cutover' })).toBe(0);
    expect(statusExitCode({ status: 'data-imported-images-pending' })).toBe(0);
    expect(statusExitCode({ status: 'refused' })).toBe(2);
    expect(statusExitCode({ status: 'unverified' })).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('validate options for the external evidence', () => {
  const base = ['--bundle', 'b', '--decisions', 'd', '--plan', 'p', '--source-kind', 'sqlite', '--source', 's', '--target', 'env:T', '--migration-id', 'rmig_args_test_01', '--dry-run-receipt', 'x', '--import-receipt', 'y', '--out', 'o'];

  it('refuses re-embedding receipts without the model the operator states', () => {
    expect(() => parseValidateArgs([...base, '--reembed-plan', 'rp', '--reembed-receipts', 'rr'])).toThrow(/--embedding-model/u);
    expect(parseValidateArgs([...base, '--reembed-plan', 'rp', '--reembed-receipts', 'rr', '--embedding-model', 'some-model'])).toMatchObject({ embeddingModel: 'some-model' });
    expect(parseValidateArgs([...base, '--image-target-dir', 'dir']).imageTargetDir).toBe('dir');
  });

  it('reads the planned objects itself from the directory the operator names, and records what is missing', () => {
    const root = join(work, 'objects');
    mkdirSync(join(root, 'images'), { recursive: true });
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71]), Buffer.from('rest of a png')]);
    writeFileSync(join(root, 'images', 'one.png'), bytes);
    const inventory = { entries: [{ target_key: 'images/one.png' }, { target_key: 'images/gone.png' }, { target_key: '../escape.png' }] };
    const { observed } = observeImageObjects(root, inventory);
    expect(observed['images/one.png']).toMatchObject({ size: bytes.length, mime: 'image/png' });
    expect(observed['images/one.png'].sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(observed['images/gone.png']).toEqual({ missing: true });
    expect(observed['../escape.png']).toEqual({ missing: true });
    expect(() => observeImageObjects(join(work, 'no-such-directory'), inventory)).toThrow(/image-target-dir/u);
  });
});
