// Reading and writing the two artifacts that hold the migrated content itself: the compiled policy and the
// relational staging plan. They are encrypted by default, with the passphrase file that protects the
// bundle, and written as plaintext only when both acknowledgement flags are given. Every reader opens
// either form. Neither form is ever written over an existing file.

import { readFileSync } from 'node:fs';
import { passphraseBytes } from '../lib/bundle.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { isSealed, openSealedJson, sealJson } from '../lib/sealed.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { refuseArgument, writeBytesNew } from './shared.mjs';

export const PLAINTEXT_SWITCHES = Object.freeze(['--allow-plaintext-artifact', '--acknowledge-plaintext-risk']);
const PASSPHRASE_ENV = 'RM_MIGRATION_PASSPHRASE_FILE';

/** Both acknowledgement flags together mean plaintext; one alone is a refusal, never a quiet choice. */
export function plaintextChoice(phase, values) {
  const allow = values['--allow-plaintext-artifact'] === true;
  const acknowledged = values['--acknowledge-plaintext-risk'] === true;
  if ((allow || acknowledged) && !(allow && acknowledged)) {
    throw new MigrationRefusal({ code: 'RMIG-E-BUNDLE-PLAINTEXT-ACK', phase, summary: 'A plaintext artifact needs both --allow-plaintext-artifact and --acknowledge-plaintext-risk.', safe_details: {}, report_path: null });
  }
  return allow && acknowledged;
}

function passphraseFor(phase, passphraseFile, what) {
  if (typeof passphraseFile !== 'string' && !process.env[PASSPHRASE_ENV]) {
    throw new MigrationRefusal({ code: 'RMIG-E-BUNDLE-DECRYPT', phase, summary: `${what} needs the migration passphrase file (--passphrase-file); to write it as plaintext give both --allow-plaintext-artifact and --acknowledge-plaintext-risk.`, safe_details: {}, report_path: null });
  }
  return passphraseBytes({ phase, passphraseFile });
}

/** Fails early, before any work, when an encrypted artifact is to be written and there is no usable passphrase file. */
export function assertCanWriteArtifact(phase, kind, { passphraseFile, plaintext = false }) {
  if (plaintext) return;
  passphraseFor(phase, passphraseFile, `The ${kind.replace('-', ' ')} holds the migrated content and is written encrypted, so it`).fill(0);
}

/** Writes the artifact encrypted (the default) or, on explicit acknowledgement, as canonical JSON. */
export function writeArtifactNew(phase, path, value, { kind, passphraseFile, plaintext = false }) {
  if (plaintext) { writeBytesNew(phase, path, Buffer.from(canonicalJson(value), 'utf8')); return { encrypted: false }; }
  const passphrase = passphraseFor(phase, passphraseFile, `The ${kind.replace('-', ' ')} holds the migrated content and is written encrypted, so it`);
  try { writeBytesNew(phase, path, sealJson(value, { kind, passphrase })); } finally { passphrase.fill(0); }
  return { encrypted: true };
}

/** Opens an encrypted artifact with the passphrase file, or reads a plaintext one as JSON. */
export function readArtifact(phase, path, label, { kind, passphraseFile }) {
  let bytes;
  try { bytes = readFileSync(path); } catch { throw refuseArgument(phase, `${label} is missing or is not valid JSON.`); }
  if (isSealed(bytes)) {
    const passphrase = passphraseFor(phase, passphraseFile, `${label} is encrypted, so it`);
    try { return openSealedJson(bytes, { kind, passphrase, phase }); } finally { passphrase.fill(0); }
  }
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw refuseArgument(phase, `${label} is missing or is not valid JSON.`); }
}
