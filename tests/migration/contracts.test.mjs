import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATION_PHASES,
  REPORT_STATUSES,
  validateManifest,
  validateReport,
} from '../../scripts/v32-to-v4/lib/contracts.mjs';
import {
  EXPECTED_REFUSAL_CODES,
  MigrationRefusal,
  exitCodeFor,
  serializeRefusal,
} from '../../scripts/v32-to-v4/lib/refusal.mjs';
import {
  createReport,
  reportArtifactHash,
  writeReportAtomic,
} from '../../scripts/v32-to-v4/lib/report.mjs';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { assertNodeVersion } from '../../scripts/v32-to-v4/lib/runtime.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MIGRATION_ID = 'rmig_20260919_contracts';
const TIMESTAMP = '2026-09-19T12:34:56.000Z';

const minimumCodes = [
  'RMIG-E-NODE-VERSION',
  'RMIG-E-SOURCE-ARG',
  'RMIG-E-SOURCE-FINGERPRINT',
  'RMIG-E-SOURCE-DRIFT',
  'RMIG-E-SOURCE-NOT-READONLY',
  'RMIG-E-D1-REMOTE-UNSUPPORTED',
  'RMIG-E-BUNDLE-PLAINTEXT-ACK',
  'RMIG-E-BUNDLE-INTEGRITY',
  'RMIG-E-BUNDLE-DECRYPT',
  'RMIG-E-SECRET-DETECTED',
  'RMIG-E-POLICY-UNRESOLVED',
  'RMIG-E-POLICY-MISMATCH',
  'RMIG-E-SAME-SOURCE-TARGET',
  'RMIG-E-TARGET-NOT-FRESH',
  'RMIG-E-TARGET-SCHEMA',
  'RMIG-E-DRY-RUN-REQUIRED',
  'RMIG-E-RECEIPT-MISMATCH',
  'RMIG-E-IMAGE-INCOMPLETE',
  'RMIG-E-REEMBED-INCOMPLETE',
  'RMIG-E-VALIDATION',
];

function bundleMembers(suffix = '.enc') {
  return [
    { name: `data/entities.ndjson${suffix}`, sha256: SHA_B, plaintext_sha256: SHA_A, row_count: 2 },
    { name: `external/images.json${suffix}`, sha256: SHA_B, plaintext_sha256: SHA_A, row_count: 1 },
    { name: `external/reembed-jobs.ndjson${suffix}`, sha256: SHA_B, plaintext_sha256: SHA_A, row_count: 1 },
    { name: `policy-template.json${suffix}`, sha256: SHA_B, plaintext_sha256: SHA_A, row_count: 1 },
    { name: `source-report.json${suffix}`, sha256: SHA_B, plaintext_sha256: SHA_A, row_count: 1 },
  ];
}

function manifest(overrides = {}) {
  const secretReview = { decisions: [], false_positive_acknowledgements: [] };
  return {
    format_version: 1,
    migrator_version: '1.0.0',
    migration_id: MIGRATION_ID,
    created_at: TIMESTAMP,
    source_kind: 'postgres',
    source_fingerprint: SHA_A,
    bundle_mode: 'encrypted',
    plaintext_acknowledgements: {
      allow_plaintext_bundle: false,
      acknowledge_plaintext_risk: false,
    },
    secret_review: { ...secretReview, sha256: canonicalSha256(secretReview) },
    members: bundleMembers(),
    ...overrides,
  };
}

function reportInput(overrides = {}) {
  return {
    migrator_version: '1.0.0',
    phase: 'inspect-source',
    timestamp: TIMESTAMP,
    migration_id: MIGRATION_ID,
    status: 'succeeded',
    details: { source_kind: 'postgres' },
    ...overrides,
  };
}

function trapCountingProxy(target) {
  let traps = 0;
  const handler = {};
  for (const trap of [
    'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'get', 'has',
    'set', 'defineProperty', 'deleteProperty', 'isExtensible', 'preventExtensions',
  ]) {
    handler[trap] = (...args) => {
      traps += 1;
      return Reflect[trap](...args);
    };
  }
  return { proxy: new Proxy(target, handler), trapCalls: () => traps };
}

describe('closed versioned artifact contracts', () => {
  it('accepts exactly the format version 1 manifest schema', () => {
    expect(validateManifest(manifest())).toEqual(manifest());
  });

  it.each([0, 2, '1', null, undefined])('rejects unknown manifest version %j', (version) => {
    expect(() => validateManifest(manifest({ format_version: version }))).toThrow(/format_version/i);
  });

  it.each([
    ['missing key', (value) => { delete value.source_fingerprint; }],
    ['extra key', (value) => { value.connection_string = 'safe-looking'; }],
    ['nested extra key', (value) => { value.members[0].bytes = 12; }],
    ['bad digest', (value) => { value.source_fingerprint = 'abc'; }],
    ['unsafe count', (value) => { value.members[0].row_count = Number.MAX_SAFE_INTEGER + 1; }],
    ['plaintext without acknowledgement', (value) => { value.bundle_mode = 'plaintext'; }],
  ])('rejects a manifest with %s', (_label, mutate) => {
    const value = manifest();
    mutate(value);
    expect(() => validateManifest(value)).toThrow();
  });

  it('requires plain non-proxy data without invoking proxy traps', () => {
    const observed = trapCountingProxy(manifest());
    expect(() => validateManifest(observed.proxy)).toThrow(/proxy/i);
    expect(observed.trapCalls()).toBe(0);
    expect(() => validateManifest(new (class Manifest {})())).toThrow(/plain/i);
  });

  it.each([
    'CON',
    'nested/con.json',
    'nested/trailing-dot.',
    'nested/trailing-space ',
    'nested/caf\u00e9.json',
    'C:/absolute.json',
    'C:drive-relative.json',
    '../escape.json',
    'nested/../escape.json',
  ])('rejects unsafe manifest member path %j exactly like checksum paths', (name) => {
    const value = manifest();
    value.members[0].name = name;
    expect(() => validateManifest(value)).toThrow(/safe relative POSIX path/i);
  });

  it('requires safe deterministic member ordering and mode-specific member names', () => {
    const value = manifest();
    value.members.push({ ...value.members[0], name: 'data/z.ndjson.enc' });
    value.members.sort((a, b) => a.name.localeCompare(b.name));
    expect(() => validateManifest(value)).not.toThrow();
    const reordered = manifest({ members: [...manifest().members].reverse() });
    expect(() => validateManifest(reordered)).toThrow(/order|sorted/i);
    const plaintext = manifest({ bundle_mode: 'plaintext', plaintext_acknowledgements: { allow_plaintext_bundle: true, acknowledge_plaintext_risk: true }, members: bundleMembers('').sort((a, b) => a.name.localeCompare(b.name)) });
    expect(validateManifest(plaintext)).toEqual(plaintext);
    const wrongMembers = bundleMembers();
    wrongMembers[0] = { ...wrongMembers[0], name: 'data/entities.ndjson' };
    const wrongSuffix = manifest({ members: wrongMembers });
    expect(() => validateManifest(wrongSuffix)).toThrow(/encrypted|suffix|member/i);
  });
  it('rejects Windows-case collisions between manifest member paths', () => {
    const value = manifest();
    value.members.push({ ...value.members[0], name: 'DATA/ENTITIES.NDJSON.ENC' });
    expect(() => validateManifest(value)).toThrow(/collision/i);
  });
});

describe('structured refusals', () => {
  it('defines every required stable code and exactly one remediation per code', () => {
    expect(EXPECTED_REFUSAL_CODES).toEqual(expect.arrayContaining(minimumCodes));
    expect(new Set(EXPECTED_REFUSAL_CODES).size).toBe(EXPECTED_REFUSAL_CODES.length);

    for (const code of EXPECTED_REFUSAL_CODES) {
      const refusal = new MigrationRefusal({
        code,
        phase: 'inspect-source',
        summary: 'The requested operation was safely refused.',
        safe_details: {},
        report_path: null,
      });
      expect(refusal.remediation).toEqual(expect.any(String));
      expect(refusal.remediation.trim()).toBe(refusal.remediation);
      expect(refusal.remediation.split('\n')).toHaveLength(1);
      expect(exitCodeFor(refusal)).toBe(2);
    }
  });

  it('maps the Node gate to a complete structured refusal', () => {
    let refusal;
    try {
      assertNodeVersion(21);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(MigrationRefusal);
    expect(refusal).toMatchObject({
      code: 'RMIG-E-NODE-VERSION',
      phase: 'runtime',
      remediation: expect.any(String),
      safe_details: { minimum_major: 22, received_major: 21 },
      report_path: null,
    });
    expect(exitCodeFor(refusal)).toBe(2);
  });

  it('maps success to 0 and unexpected failures to 1', () => {
    expect(exitCodeFor()).toBe(0);
    expect(exitCodeFor(new Error('unexpected'))).toBe(1);
  });

  it('rejects unknown contracts and redacts secret-bearing refusal values', () => {
    expect(() => new MigrationRefusal({
      code: 'RMIG-E-MADE-UP', phase: 'inspect-source', summary: 'No.', safe_details: {}, report_path: null,
    })).toThrow(/unknown refusal code/i);
    expect(() => new MigrationRefusal({
      code: 'RMIG-E-SOURCE-ARG', phase: 'inspect-source', summary: 'No.', safe_details: {}, report_path: null, extra: true,
    })).toThrow(/keys/i);
    const redacted = new MigrationRefusal({
      code: 'RMIG-E-SOURCE-ARG',
      phase: 'inspect-source',
      summary: 'Could not use postgres://operator:password@db.example/mind.',
      safe_details: { access_token: 'seeded-token-9417' },
      report_path: null,
    });
    expect(redacted.summary).not.toContain('operator:');
    expect(redacted.safe_details).toEqual({ access_token: '[REDACTED]' });
    const hidden = {};
    Object.defineProperty(hidden, 'password', { value: 'hidden-secret' });
    expect(() => new MigrationRefusal({
      code: 'RMIG-E-SOURCE-ARG',
      phase: 'inspect-source',
      summary: 'Source argument is invalid.',
      safe_details: hidden,
      report_path: null,
    })).toThrow(/plain|data|field/i);
  });

  it('snapshots refusal details so later caller mutation cannot leak secrets', () => {
    const details = { argument: '--source' };
    const refusal = new MigrationRefusal({
      code: 'RMIG-E-SOURCE-ARG',
      phase: 'inspect-source',
      summary: 'Source argument is invalid.',
      safe_details: details,
      report_path: null,
    });
    details.access_token = 'late-secret-token';
    expect(serializeRefusal(refusal, { json: true })).not.toContain('late-secret-token');
    expect(() => { refusal.safe_details.access_token = 'another-secret'; }).toThrow();
  });

  it('serializes deterministic human stderr or canonical JSON stdout', () => {
    const refusal = new MigrationRefusal({
      code: 'RMIG-E-SOURCE-ARG',
      phase: 'inspect-source',
      summary: 'Source argument is invalid.',
      safe_details: { argument: '--source' },
      report_path: 'reports/source.json',
    });
    expect(serializeRefusal(refusal, { json: false })).toBe(
      `RMIG-E-SOURCE-ARG: Source argument is invalid. ${refusal.remediation} Report: reports/source.json\n`,
    );
    expect(serializeRefusal(refusal, { json: true })).toBe(canonicalJson(refusal.toJSON()));
  });

  it('redacts secret-bearing environment values from refusal human and JSON output by default', () => {
    const name = 'RMIG_TEST_SOURCE_DATABASE_URL';
    const secret = 'postgres://refusal-user:refusal-password@refusal-host.example/refusal-db';
    const previous = process.env[name];
    process.env[name] = secret;
    try {
      const refusal = new MigrationRefusal({
        code: 'RMIG-E-SOURCE-ARG',
        phase: 'inspect-source',
        summary: `Source ${secret} is invalid.`,
        safe_details: { note: `ordinary field contains ${secret}` },
        report_path: null,
      });
      const human = serializeRefusal(refusal);
      const json = serializeRefusal(refusal, { json: true });
      expect(human).not.toContain(secret);
      expect(json).not.toContain(secret);
      expect(human).toContain('[REDACTED]');
      expect(json).toContain('[REDACTED]');
      expect(json).not.toContain(name);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});

describe('reports', () => {
  it('creates a closed, versioned report with a canonical artifact hash', () => {
    const report = createReport(reportInput());
    expect(report).toMatchObject({
      format_version: 1,
      migrator_version: '1.0.0',
      phase: 'inspect-source',
      timestamp: TIMESTAMP,
      migration_id: MIGRATION_ID,
      status: 'succeeded',
      artifact_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(report.artifact_sha256).toBe(reportArtifactHash(report));
    expect(validateReport(report)).toEqual(report);
  });

  it.each([
    ['timestamp', { timestamp: '2026-09-19 12:34:56' }],
    ['migration ID', { migration_id: '../escape' }],
    ['phase', { phase: 'made-up-phase' }],
    ['status', { status: 'probably-fine' }],
  ])('rejects an invalid %s', (_label, overrides) => {
    expect(() => createReport(reportInput(overrides))).toThrow();
  });

  it('exports fixed phase and status enums', () => {
    expect(MIGRATION_PHASES).toContain('validate');
    expect(REPORT_STATUSES).toEqual(expect.arrayContaining([
      'succeeded', 'refused', 'failed', 'complete', 'data-imported-not-search-ready',
    ]));
  });

  it('redacts environment values and connection strings before hashing', () => {
    const secret = 'seeded-environment-secret-9417';
    const report = createReport(reportInput({
      details: {
        database_url: 'postgres://operator:' + secret + '@db.example/mind',
        note: `DATABASE_URL=${secret}`,
      },
    }), { environmentValues: { DATABASE_URL: secret } });
    const serialized = canonicalJson(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('operator:');
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts source and target env secrets in ordinary report fields without caller options', () => {
    const sourceName = 'RMIG_TEST_DATABASE_URL';
    const targetName = 'RMIG_TEST_POSTGRES_URL';
    const ordinaryName = 'RMIG_TEST_PATH';
    const source = 'postgres://source-user:source-password@source-host.example/source-db';
    const target = 'postgres://target-user:target-password@target-host.example/target-db';
    const previous = new Map([
      [sourceName, process.env[sourceName]],
      [targetName, process.env[targetName]],
      [ordinaryName, process.env[ordinaryName]],
    ]);
    process.env[sourceName] = source;
    process.env[targetName] = target;
    process.env[ordinaryName] = 'ordinary-value-that-must-remain';
    try {
      const report = createReport(reportInput({
        details: {
          summary: `copy ${source} into ${target}`,
          ordinary: 'ordinary-value-that-must-remain',
        },
      }));
      const serialized = canonicalJson(report);
      expect(serialized).not.toContain(source);
      expect(serialized).not.toContain(target);
      expect(serialized).not.toContain('source-host.example');
      expect(serialized).not.toContain('target-host.example');
      expect(serialized).not.toContain(sourceName);
      expect(serialized).not.toContain(targetName);
      expect(serialized).toContain('ordinary-value-that-must-remain');
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('rejects hidden or accessor input instead of silently dropping it', () => {
    const hiddenDetails = { safe: 'visible' };
    Object.defineProperty(hiddenDetails, 'password', { value: 'hidden-secret' });
    expect(() => createReport(reportInput({ details: hiddenDetails }))).toThrow(/field|data/i);

    const accessorDetails = {};
    Object.defineProperty(accessorDetails, 'note', { enumerable: true, get() { return 'unsafe'; } });
    expect(() => createReport(reportInput({ details: accessorDetails }))).toThrow(/accessor|field|data/i);
  });

  it('rejects missing, extra, proxy, hidden, accessor, and hash-tampered report data', () => {
    const valid = createReport(reportInput());
    for (const mutate of [
      (value) => { delete value.phase; },
      (value) => { value.extra = true; },
      (value) => { value.details.password = 'secret'; },
      (value) => { value.artifact_sha256 = SHA_A; },
    ]) {
      const value = structuredClone(valid);
      mutate(value);
      expect(() => validateReport(value)).toThrow();
    }
    const observed = trapCountingProxy(valid);
    expect(() => validateReport(observed.proxy)).toThrow(/proxy/i);
    expect(observed.trapCalls()).toBe(0);

    const hidden = createReport(reportInput());
    Object.defineProperty(hidden.details, 'password', { value: 'hidden-secret' });
    expect(() => validateReport(hidden)).toThrow(/data|field|unsupported/i);
    const accessor = createReport(reportInput());
    Object.defineProperty(accessor.details, 'note', { enumerable: true, get() { return 'unsafe'; } });
    expect(() => validateReport(accessor)).toThrow(/accessor|data|unsupported/i);
  });

  it('atomically writes canonical bytes and refuses unsafe overwrite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rm-contract-'));
    const path = join(directory, 'report.json');
    const report = createReport(reportInput());
    writeReportAtomic(path, report);
    expect(readFileSync(path, 'utf8')).toBe(canonicalJson(report));
    expect(() => writeReportAtomic(path, report)).toThrow(/exists/i);
    expect(readdirSync(directory)).toEqual(['report.json']);
  });

  it('cleans temporary and lock files after write failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rm-contract-fail-'));
    const path = join(directory, 'report.json');
    const report = createReport(reportInput());
    expect(() => writeReportAtomic(path, report, {
      beforeRename() { throw new Error('injected failure'); },
    })).toThrow('injected failure');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('allows only one concurrent exclusive writer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rm-contract-race-'));
    const path = join(directory, 'report.json');
    const report = createReport(reportInput());
    const results = await Promise.allSettled([
      Promise.resolve().then(() => writeReportAtomic(path, report)),
      Promise.resolve().then(() => writeReportAtomic(path, report)),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(canonicalJson(report));
    expect(readdirSync(directory)).toEqual(['report.json']);
  });

  it('rejects symlink targets, symlink parents, and non-file overwrite targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-contract-path-'));
    const real = join(root, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'existing.json'), 'do not replace');
    const report = createReport(reportInput());
    expect(() => writeReportAtomic(real, report, { overwrite: true })).toThrow(/regular file|directory/i);

    try {
      symlinkSync(join(real, 'existing.json'), join(root, 'linked.json'));
      symlinkSync(real, join(root, 'linked-parent'), 'dir');
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
      expect(readFileSync(join(real, 'existing.json'), 'utf8')).toBe('do not replace');
      return;
    }
    expect(() => writeReportAtomic(join(root, 'linked.json'), report, { overwrite: true })).toThrow(/symlink/i);
    expect(() => writeReportAtomic(join(root, 'linked-parent', 'new.json'), report)).toThrow(/symlink/i);
    expect(readFileSync(join(real, 'existing.json'), 'utf8')).toBe('do not replace');
  });
});
