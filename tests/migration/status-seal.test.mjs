import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { sealReport, verifyReportSeal } from '../../scripts/v32-to-v4/lib/report-seal.mjs';
import { humanStatusResult, statusCommand } from '../../scripts/v32-to-v4/commands/status.mjs';
import { determineMigrationStatus, reportBodyHash, validateOperatorCutoverEvidence } from '../../scripts/v32-to-v4/validate/reconcile.mjs';

const work = mkdtempSync(join(tmpdir(), 'rmig-status-seal-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const keyFile = (name, text) => { const path = join(work, name); writeFileSync(path, text, { mode: 0o600 }); return path; };

function readyReport(overrides = {}) {
  const report = { format_version: 1, report_type: 'migration-reconciliation', validation_mode: 'live', migration_id: 'rmig_status_seal_01', counts: {}, violations: [], violation_counts: {}, target_present: true, exported: true, dry_run_receipt_complete: true, import_receipt_complete: true, imported: true, relational_reconciliation_complete: true, images_complete: true, reembed_complete: true, ...overrides };
  report.status = determineMigrationStatus(report, { requireReportHash: false });
  report.report_sha256 = canonicalSha256(report);
  return report;
}
const sealed = (report, passphrase) => ({ ...report, report_seal: sealReport(report, Buffer.from(passphrase)) });
const evidenceFor = (report, overrides = {}) => {
  const body = { format_version: 1, evidence_type: 'operator-cutover', migration_id: report.migration_id, report_sha256: report.report_sha256, operator_action: { performed: true, actor: 'operator', performed_at: '2026-10-20T12:00:00Z', change_id: 'chg-1' }, readback: { verified: true, verified_at: '2026-10-20T12:05:00Z', observed_version: 'v4.0.1' }, ...overrides };
  return { ...body, evidence_sha256: canonicalSha256(body) };
};

describe('cutover evidence that does not validate is refused, never set aside', () => {
  const report = readyReport();
  it('reads ready-for-cutover with no evidence, and complete with valid evidence', () => {
    expect(report.status).toBe('ready-for-cutover');
    expect(determineMigrationStatus(report)).toBe('ready-for-cutover');
    expect(determineMigrationStatus(report, { operatorCutoverEvidence: evidenceFor(report) })).toBe('complete-operator-attested');
  });
  it.each([
    ['garbage', { not: 'evidence' }],
    ['a string', 'done'],
    ['an empty object', {}],
    ['evidence for another report', evidenceFor(report, { report_sha256: 'f'.repeat(64) })],
    ['evidence with a changed body', { ...evidenceFor(report), readback: { verified: false } }],
  ])('refuses %s instead of falling back to ready-for-cutover', (_label, evidence) => {
    expect(() => validateOperatorCutoverEvidence({ report, evidence })).toThrow();
    expect(determineMigrationStatus(report, { operatorCutoverEvidence: evidence })).toBe('refused');
  });
  it('refuses unusable evidence even when the report is not ready yet', () => {
    const pending = readyReport({ images_complete: false });
    expect(pending.status).toBe('data-imported-images-pending');
    expect(determineMigrationStatus(pending, { operatorCutoverEvidence: { not: 'evidence' } })).toBe('refused');
  });
});

describe('status reports a state only for a report that validate sealed', () => {
  const passphrase = 'a-long-test-passphrase';
  const path = keyFile('passphrase', passphrase);

  it('verifies a sealed report and reports its state', () => {
    const report = sealed(readyReport(), passphrase);
    expect(verifyReportSeal(report, Buffer.from(passphrase))).toBe(true);
    const result = statusCommand({ report, passphraseFile: path });
    expect(result).toMatchObject({ status: 'ready-for-cutover', report_verified: true });
    expect(humanStatusResult(result)).toMatch(/^status: ready-for-cutover; report_verified=true;/u);
    // the cutover evidence still moves it on, and bad evidence refuses it
    expect(statusCommand({ report, passphraseFile: path, evidence: evidenceFor(report) }).status).toBe('complete-operator-attested');
    expect(statusCommand({ report, passphraseFile: path, evidence: { not: 'evidence' } }).status).toBe('refused');
  });

  it('refuses a report that was edited and given a freshly computed hash', () => {
    const original = sealed(readyReport({ images_complete: false, reembed_complete: false }), passphrase);
    expect(statusCommand({ report: original, passphraseFile: path }).status).toBe('data-imported-images-pending');
    // an editor flips the flags, recomputes the (unkeyed) hash, and keeps the old seal
    const edited = { ...original, images_complete: true, reembed_complete: true };
    edited.status = 'ready-for-cutover';
    edited.report_sha256 = reportBodyHash(edited);
    expect(edited.report_sha256).toBe(canonicalSha256((({ report_sha256: _a, report_seal: _b, ...rest }) => rest)(edited)));
    expect(() => statusCommand({ report: edited, passphraseFile: path })).toThrow(/seal does not verify/u);
    // the edit with no seal at all is not a state either
    const stripped = { ...edited }; delete stripped.report_seal;
    const result = statusCommand({ report: stripped });
    expect(result).toMatchObject({ status: 'unverified', report_verified: false, claimed_status: 'ready-for-cutover' });
    expect(humanStatusResult(result)).toMatch(/NOT proof/u);
  });

  it('refuses a seal made with a different passphrase, and a sealed report read without one', () => {
    const report = sealed(readyReport(), 'some-other-passphrase');
    expect(() => statusCommand({ report, passphraseFile: path })).toThrow(/seal does not verify/u);
    const previous = process.env.RM_MIGRATION_PASSPHRASE_FILE;
    delete process.env.RM_MIGRATION_PASSPHRASE_FILE;
    try { expect(() => statusCommand({ report: sealed(readyReport(), passphrase) })).toThrow(/needs the migration passphrase file/u); } finally { if (previous !== undefined) process.env.RM_MIGRATION_PASSPHRASE_FILE = previous; }
  });

  it('reports a report that does not match its own hash as refused, sealed or not', () => {
    const report = sealed(readyReport(), passphrase);
    const result = statusCommand({ report: { ...report, imported: false }, passphraseFile: path });
    expect(result).toMatchObject({ status: 'refused', report_verified: false });
  });

  it('labels an unsealed report unverified instead of reporting its claimed state', () => {
    const result = statusCommand({ report: readyReport() });
    expect(result.status).toBe('unverified');
    expect(result.claimed_status).toBe('ready-for-cutover');
  });
});

describe('the status command through the CLI', () => {
  it('prints the state of a sealed report, and exits 2 when the evidence or the report is refused', async () => {
    const { runCli } = await import('./helpers/cli-run.mjs');
    const passphrase = 'a-long-test-passphrase';
    const key = keyFile('cli-passphrase', passphrase);
    const report = sealed(readyReport(), passphrase);
    writeFileSync(join(work, 'report.json'), JSON.stringify(report));
    writeFileSync(join(work, 'garbage-evidence.json'), JSON.stringify({ not: 'evidence' }));
    writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidenceFor(report)));

    const ok = runCli(['status', '--report', join(work, 'report.json'), '--passphrase-file', key]);
    expect(ok.status, ok.output).toBe(0);
    expect(ok.stdout).toMatch(/^status: ready-for-cutover; report_verified=true;/u);
    const done = runCli(['status', '--report', join(work, 'report.json'), '--passphrase-file', key, '--cutover-evidence', join(work, 'evidence.json')]);
    expect(done.stdout).toMatch(/^status: complete-operator-attested;/u);
    const garbage = runCli(['status', '--report', join(work, 'report.json'), '--passphrase-file', key, '--cutover-evidence', join(work, 'garbage-evidence.json')]);
    expect(garbage.status).toBe(2);
    expect(garbage.stdout).toMatch(/^status: refused;/u);

    writeFileSync(join(work, 'edited.json'), JSON.stringify({ ...report, images_complete: false }));
    const edited = runCli(['status', '--report', join(work, 'edited.json'), '--passphrase-file', key]);
    expect(edited.status).toBe(2);
    expect(edited.stdout).toMatch(/^status: refused;.*own hash/u);
    const noKey = runCli(['status', '--report', join(work, 'report.json')], { RM_MIGRATION_PASSPHRASE_FILE: '' });
    expect(noKey.status).toBe(2);
    expect(noKey.stderr).toContain('RMIG-E-VALIDATION');
  });
});
