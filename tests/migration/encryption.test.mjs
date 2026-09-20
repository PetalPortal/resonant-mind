import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBundle, verifyBundle, aadFor } from '../../scripts/v32-to-v4/lib/bundle.mjs';
import { fingerprintCatalog, sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';

const fingerprint = fingerprintCatalog(sourceSpecFor('sqlite'));

function adapter() {
  return {
    beginSnapshot() {}, endSnapshot() {}, close() {}, catalog: () => sourceSpecFor('sqlite'),
    async *streamTable() { yield { id: 1, content: 'safe' }; },
  };
}

function passphrase(root, fill) {
  const path = join(root, `pass-${fill}`);
  writeFileSync(path, Buffer.alloc(32, fill), { mode: 0o600 });
  return path;
}

async function make(root, passphrasePath, platform = process.platform) {
  return createBundle({
    adapter: adapter(), sourceKind: 'sqlite', sourceFingerprint: fingerprint,
    migrationId: 'rmig_20260919_encryption', timestamp: '2026-09-19T12:34:56.000Z',
    outputPath: join(root, 'bundle'),
    env: { RM_MIGRATION_PASSPHRASE_FILE: passphrasePath }, platform,
  });
}

describe('encrypted bundle boundary', () => {
  it('binds authenticated encryption to migration identity and member path', () => {
    expect(aadFor('rmig_20260919_encryption', 'data/observations.ndjson.enc')).not.toEqual(aadFor('rmig_20260919_encryption', 'data/other.ndjson.enc'));
    expect(aadFor('rmig_20260919_encryption', 'data/observations.ndjson.enc')).not.toEqual(aadFor('rmig_other_encryption', 'data/observations.ndjson.enc'));
  });

  it('refuses a wrong passphrase without exposing passphrase material', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-encryption-'));
    const good = passphrase(root, 1);
    await make(root, good);
    const wrong = passphrase(root, 2);
    expect(() => verifyBundle({ path: join(root, 'bundle'), env: { RM_MIGRATION_PASSPHRASE_FILE: wrong } })).toThrow(/decrypt|authentication/i);
    let error;
    try { verifyBundle({ path: join(root, 'bundle'), env: { RM_MIGRATION_PASSPHRASE_FILE: wrong } }); } catch (caught) { error = caught; }
    expect(String(error)).not.toContain('pass-');
  });

  it('refuses symlink and loose-permission passphrase files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-passphrase-policy-'));
    const loose = join(root, 'loose');
    writeFileSync(loose, Buffer.alloc(32, 1), { mode: 0o644 });
    await expect(make(root, loose, 'linux')).rejects.toThrow(/permission|readable|passphrase/i);
    const target = passphrase(root, 3);
    const link = join(root, 'link');
    try { symlinkSync(target, link); } catch (error) { if (error?.code === 'EPERM') return; throw error; }
    await expect(make(root, link, 'linux')).rejects.toThrow(/regular|symlink|passphrase/i);
  });
});
