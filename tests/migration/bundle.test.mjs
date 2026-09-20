import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBundle, verifyBundle } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { sha256Hex } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { sourceSpecFor, fingerprintCatalog } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { scanRows } from '../../scripts/v32-to-v4/lib/secret-scan.mjs';

const MIGRATION_ID = 'rmig_20260919_bundle';
const TS = '2026-09-19T12:34:56.000Z';
const FP = fingerprintCatalog(sourceSpecFor('sqlite'));

function adapter(rows = [{ id: 2, content: 'second' }, { id: 1, content: 'first' }]) {
  return {
    beginSnapshot() {},
    endSnapshot() {},
    close() {},
    catalog() {
      return sourceSpecFor('sqlite');
    },
    async *streamTable() {
      for (const row of rows.toSorted((a, b) => a.id - b.id)) yield row;
    },
  };
}

function options(root, overrides = {}) {
  const passphraseFile = join(root, 'passphrase');
  writeFileSync(passphraseFile, Buffer.alloc(32, 1), { mode: 0o600 });
  return {
    adapter: adapter(), sourceKind: 'sqlite', sourceFingerprint: FP,
    migrationId: MIGRATION_ID, timestamp: TS, migratorVersion: '1.0.0',
    outputPath: join(root, 'bundle'), tables: ['observations'],
    env: { ...process.env, RM_MIGRATION_PASSPHRASE_FILE: passphraseFile }, ...overrides,
  };
}

describe('streaming migration bundles', () => {
  it('writes deterministic checksummed NDJSON with counts and restrictive modes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-bundle-'));
    const result = await createBundle(options(root));
    expect(readdirSync(result.path).toSorted()).toEqual(['checksums.sha256', 'data', 'manifest.json']);
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'));
    expect(manifest.members).toEqual([expect.objectContaining({
      name: 'data/observations.ndjson.enc', row_count: 2,
      plaintext_sha256: sha256Hex('{"content":"first","id":1}\n{"content":"second","id":2}\n'),
    })]);
    if (process.platform !== 'win32') {
      expect(statSync(join(result.path, 'data')).mode & 0o777).toBe(0o700);
      expect(statSync(join(result.path, 'manifest.json')).mode & 0o777).toBe(0o600);
    }
    expect(verifyBundle({ path: result.path, env: { ...process.env, RM_MIGRATION_PASSPHRASE_FILE: join(root, 'passphrase') } }).ok).toBe(true);
  });

  it('is deterministic for the same plaintext and different output directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-bundle-deterministic-'));
    const first = await createBundle(options(root, { outputPath: join(root, 'one'), mode: 'plaintext', allowPlaintextBundle: true, acknowledgePlaintextRisk: true }));
    const second = await createBundle(options(root, { outputPath: join(root, 'two'), mode: 'plaintext', allowPlaintextBundle: true, acknowledgePlaintextRisk: true }));
    expect(readFileSync(join(first.path, 'manifest.json'), 'utf8')).toBe(readFileSync(join(second.path, 'manifest.json'), 'utf8'));
    expect(readFileSync(join(first.path, 'checksums.sha256'), 'utf8')).toBe(readFileSync(join(second.path, 'checksums.sha256'), 'utf8'));
  });

  it('refuses tampered ciphertext and cleans incomplete output after interruption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-bundle-tamper-'));
    const result = await createBundle(options(root));
    const memberPath = join(result.path, 'data/observations.ndjson.enc');
    const bytes = readFileSync(memberPath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(memberPath, bytes);
    expect(() => verifyBundle({ path: result.path, env: { ...process.env, RM_MIGRATION_PASSPHRASE_FILE: join(root, 'passphrase') } })).toThrow(/integrity|decrypt|authentication|checksum/i);

    const interrupted = join(root, 'interrupted');
    await expect(createBundle(options(root, { outputPath: interrupted, beforeFinalize() { throw new Error('stop'); } }))).rejects.toThrow('stop');
    expect(readdirSync(root).filter((name) => name.includes('interrupted') || name.includes('.incomplete'))).toEqual([]);
  });

  it('scans before finalization and requires explicit lived-content decisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-bundle-secrets-'));
    const lived = { id: 1, content: 'postgres://alice:secret@example.test/mind' };
    await expect(createBundle(options(root, { adapter: adapter([lived]), outputPath: join(root, 'refused') }))).rejects.toThrow(/decision|secret|review/i);
    expect(readdirSync(root).filter((name) => name.includes('refused') || name.includes('.incomplete'))).toEqual([]);
    const item = scanRows([lived], { table: 'observations', primaryKey: ['id'] }).reviewItems[0];
    const result = await createBundle(options(root, {
      adapter: adapter([lived]), outputPath: join(root, 'retained'), secretDecisions: { [item.review_id]: 'retain' },
    }));
    expect(result.manifest.members[0].row_count).toBe(1);
    await expect(createBundle(options(root, {
      adapter: adapter([{ id: 1, config: 'postgres://alice:secret@example.test/mind' }]), outputPath: join(root, 'metadata'),
    }))).rejects.toThrow(/high-confidence|credential|secret/i);
  });

  it('streams one hundred thousand rows without accumulating the member in heap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-bundle-100k-'));
    const streamingAdapter = {
      beginSnapshot() {}, endSnapshot() {}, close() {}, catalog: () => sourceSpecFor('sqlite'),
      async *streamTable() { for (let id = 0; id < 100_000; id += 1) yield { id, content: 'bounded' }; },
    };
    const before = process.memoryUsage().heapUsed;
    const result = await createBundle(options(root, {
      adapter: streamingAdapter, outputPath: join(root, 'large'), mode: 'plaintext',
      allowPlaintextBundle: true, acknowledgePlaintextRisk: true,
    }));
    const after = process.memoryUsage().heapUsed;
    expect(result.manifest.members[0].row_count).toBe(100_000);
    expect(after - before).toBeLessThan(128 * 1024 * 1024);
  }, 30_000);

  it('requires both explicit acknowledgements for plaintext bundles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-bundle-plain-'));
    await expect(createBundle(options(root, { outputPath: join(root, 'plain'), mode: 'plaintext' }))).rejects.toThrow(/acknowledge|plaintext/i);
    const result = await createBundle(options(root, {
      outputPath: join(root, 'plain-ok'), mode: 'plaintext',
      allowPlaintextBundle: true, acknowledgePlaintextRisk: true,
    }));
    const manifest = JSON.parse(readFileSync(join(result.path, 'manifest.json'), 'utf8'));
    expect(manifest.bundle_mode).toBe('plaintext');
    expect(manifest.members[0].name).toBe('data/observations.ndjson');
  });
});
