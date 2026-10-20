// Encrypted JSON artifacts: the compiled policy and the relational staging plan.
//
// Both hold the migrated content itself (names, text, values), so they are written the way the bundle is:
// AES-256-GCM under a key derived from the same passphrase file, and plaintext only on an explicit
// two-flag acknowledgement. A reader accepts both forms: an encrypted file starts with the magic below,
// anything else must be JSON. The additional authenticated data names the kind of artifact, so a sealed
// plan cannot be handed over as a sealed policy, and any change to the bytes fails authentication.
//
// Layout: MAGIC (8) | scrypt salt (16) | GCM nonce (12) | ciphertext | GCM tag (16).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical-json.mjs';
import { deriveKey } from './bundle.mjs';
import { FORMAT_VERSION } from './contracts.mjs';
import { MigrationRefusal } from './refusal.mjs';

export const SEALED_MAGIC = Buffer.from('RMIGART1', 'ascii');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SEALED_MAGIC.length + SALT_BYTES + NONCE_BYTES;

export const ARTIFACT_KINDS = Object.freeze(['compiled-policy', 'relational-plan']);

function aad(kind) {
  if (!ARTIFACT_KINDS.includes(kind)) throw new TypeError('Unknown artifact kind.');
  return Buffer.from(canonicalJson({ format_version: FORMAT_VERSION, artifact: kind }), 'utf8');
}
function decryptRefusal(phase, summary) {
  return new MigrationRefusal({ code: 'RMIG-E-BUNDLE-DECRYPT', phase, summary, safe_details: {}, report_path: null });
}

/** True when the bytes are an encrypted artifact (they start with the artifact magic). */
export function isSealed(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= SEALED_MAGIC.length && bytes.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC);
}

export function sealJson(value, { kind, passphrase }) {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(kind));
    const body = Buffer.concat([cipher.update(Buffer.from(canonicalJson(value), 'utf8')), cipher.final()]);
    return Buffer.concat([SEALED_MAGIC, salt, nonce, body, cipher.getAuthTag()]);
  } finally { key.fill(0); }
}

export function openSealedJson(bytes, { kind, passphrase, phase }) {
  if (!isSealed(bytes) || bytes.length < HEADER_BYTES + TAG_BYTES) throw decryptRefusal(phase, 'The encrypted artifact is damaged.');
  const salt = bytes.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + SALT_BYTES);
  const nonce = bytes.subarray(SEALED_MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(kind));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    if (error instanceof MigrationRefusal) throw error;
    throw decryptRefusal(phase, 'The encrypted artifact could not be opened: wrong passphrase, wrong kind of artifact, or the file was changed.');
  } finally { key.fill(0); }
}
