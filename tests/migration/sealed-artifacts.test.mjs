import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertCanWriteArtifact, plaintextChoice, readArtifact, writeArtifactNew } from '../../scripts/v32-to-v4/commands/artifacts.mjs';
import { isSealed, openSealedJson, sealJson } from '../../scripts/v32-to-v4/lib/sealed.mjs';
import { MigrationRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';

const work = mkdtempSync(join(tmpdir(), 'rmig-sealed-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const key = (name, text) => { const path = join(work, name); writeFileSync(path, text, { mode: 0o600 }); return path; };
const content = { plan_type: 'x', members: { journals: [{ id: 1, content: 'a private sentence about the garden' }] } };

describe('encrypted artifacts', () => {
  it('round-trips, hides the content, and fails closed on any change', () => {
    const passphrase = Buffer.from('test-passphrase-one');
    const sealed = sealJson(content, { kind: 'relational-plan', passphrase });
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.toString('latin1')).not.toContain('garden');
    expect(openSealedJson(sealed, { kind: 'relational-plan', passphrase, phase: 'validate' })).toEqual(content);
    // two seals of the same content differ (fresh salt and nonce)
    expect(sealJson(content, { kind: 'relational-plan', passphrase }).equals(sealed)).toBe(false);
    const open = (bytes, options) => openSealedJson(bytes, { kind: 'relational-plan', passphrase, phase: 'validate', ...options });
    for (const index of [10, 30, sealed.length - 20, sealed.length - 1]) {
      const changed = Buffer.from(sealed); changed[index] ^= 0x01;
      expect(() => open(changed), `byte ${index}`).toThrow(MigrationRefusal);
    }
    expect(() => open(sealed, { kind: 'compiled-policy' })).toThrow(/wrong kind of artifact/u);
    expect(() => open(sealed, { passphrase: Buffer.from('another-passphrase') })).toThrow(MigrationRefusal);
    expect(() => open(sealed.subarray(0, 20))).toThrow(MigrationRefusal);
    expect(isSealed(Buffer.from('{"a":1}'))).toBe(false);
  });
});

describe('writing and reading an artifact', () => {
  const passphraseFile = key('pass', 'artifact-passphrase');
  it('writes encrypted by default, needs the passphrase file, and never replaces a file', () => {
    const path = join(work, 'a.bin');
    expect(() => writeArtifactNew('plan-relational', path, content, { kind: 'relational-plan', passphraseFile: undefined })).toThrow(/passphrase file/u);
    expect(() => assertCanWriteArtifact('plan-relational', 'relational-plan', { passphraseFile: undefined })).toThrow(MigrationRefusal);
    expect(writeArtifactNew('plan-relational', path, content, { kind: 'relational-plan', passphraseFile })).toEqual({ encrypted: true });
    expect(isSealed(readFileSync(path))).toBe(true);
    expect(readArtifact('validate', path, 'The plan', { kind: 'relational-plan', passphraseFile })).toEqual(content);
    const before = readFileSync(path);
    expect(() => writeArtifactNew('plan-relational', path, { other: true }, { kind: 'relational-plan', passphraseFile })).toThrow(/already exists/u);
    expect(readFileSync(path).equals(before)).toBe(true);
    // a sealed file is not read without its key, or as another kind
    expect(() => readArtifact('validate', path, 'The plan', { kind: 'relational-plan', passphraseFile: key('wrong', 'not-the-passphrase') })).toThrow(/could not be opened/u);
    expect(() => readArtifact('validate', path, 'The plan', { kind: 'compiled-policy', passphraseFile })).toThrow(/could not be opened/u);
  });

  it('writes plaintext only when asked to, and reads either form', () => {
    const path = join(work, 'b.json');
    expect(writeArtifactNew('compile-policy', path, content, { kind: 'compiled-policy', plaintext: true })).toEqual({ encrypted: false });
    expect(readFileSync(path, 'utf8')).toContain('garden');
    expect(readArtifact('plan-images', path, 'The policy', { kind: 'compiled-policy' })).toEqual(content);
    expect(() => readArtifact('plan-images', join(work, 'missing.json'), 'The policy', { kind: 'compiled-policy' })).toThrow(/missing or is not valid JSON/u);
    writeFileSync(join(work, 'bad.json'), 'not json');
    expect(() => readArtifact('plan-images', join(work, 'bad.json'), 'The policy', { kind: 'compiled-policy' })).toThrow(/not valid JSON/u);
  });

  it('treats the two acknowledgement flags as one decision', () => {
    expect(plaintextChoice('compile-policy', {})).toBe(false);
    expect(plaintextChoice('compile-policy', { '--allow-plaintext-artifact': true, '--acknowledge-plaintext-risk': true })).toBe(true);
    for (const only of ['--allow-plaintext-artifact', '--acknowledge-plaintext-risk']) expect(() => plaintextChoice('compile-policy', { [only]: true }), only).toThrow(/needs both/u);
  });
});
