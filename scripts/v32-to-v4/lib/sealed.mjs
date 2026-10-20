// Encrypted JSON artifacts: the compiled policy and the relational staging plan.
//
// Both hold the migrated content itself (names, text, values), so they are written the way the bundle is:
// AES-256-GCM under a key derived from the same passphrase file, and plaintext only on an explicit
// two-flag acknowledgement. A reader accepts both forms: an encrypted file starts with the magic below,
// anything else must be JSON. The additional authenticated data names the kind of artifact, so a sealed
// plan cannot be handed over as a sealed policy, and any change to the bytes fails authentication. It names the
// migration too: the migration id is written in the header, covered by the authentication, and must be the
// migration_id of the artifact inside, so an artifact sealed for one migration is refused for another (a
// reader that knows which migration it is working on says so and the header is checked against that).
//
// Layout: MAGIC (8) | migration id length (2, big endian) | migration id (UTF-8) | scrypt salt (16) |
// GCM nonce (12) | ciphertext | GCM tag (16). RMIGART1, the layout before the migration id was bound, is
// not read.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical-json.mjs';
import { deriveKey } from './bundle.mjs';
import { FORMAT_VERSION } from './contracts.mjs';
import { MigrationRefusal } from './refusal.mjs';

export const SEALED_MAGIC = Buffer.from('RMIGART2', 'ascii');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ID_BYTES = 256;

export const ARTIFACT_KINDS = Object.freeze(['compiled-policy', 'relational-plan']);

function aad(kind, migrationId) {
  if (!ARTIFACT_KINDS.includes(kind)) throw new TypeError('Unknown artifact kind.');
  return Buffer.from(canonicalJson({ format_version: FORMAT_VERSION, artifact: kind, migration_id: migrationId }), 'utf8');
}
function decryptRefusal(phase, summary) {
  return new MigrationRefusal({ code: 'RMIG-E-BUNDLE-DECRYPT', phase, summary, safe_details: {}, report_path: null });
}

/** True when the bytes are an encrypted artifact (they start with the artifact magic). */
export function isSealed(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= SEALED_MAGIC.length && bytes.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC);
}

export function sealJson(value, { kind, passphrase }) {
  const migrationId = value?.migration_id;
  if (typeof migrationId !== 'string' || migrationId.length === 0 || Buffer.byteLength(migrationId, 'utf8') > MAX_ID_BYTES) throw new TypeError('A sealed artifact needs the migration_id it belongs to.');
  const idBytes = Buffer.from(migrationId, 'utf8');
  const idLength = Buffer.alloc(2); idLength.writeUInt16BE(idBytes.length);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(kind, migrationId));
    const body = Buffer.concat([cipher.update(Buffer.from(canonicalJson(value), 'utf8')), cipher.final()]);
    return Buffer.concat([SEALED_MAGIC, idLength, idBytes, salt, nonce, body, cipher.getAuthTag()]);
  } finally { key.fill(0); }
}

/**
 * Opens an encrypted artifact. `migrationId`, when the caller knows which migration it is working on, must be
 * the one the artifact was sealed for; whatever the caller knows, the id in the header (authenticated) must
 * be the migration_id of the artifact inside.
 */
export function openSealedJson(bytes, { kind, passphrase, phase, migrationId }) {
  const fixed = SEALED_MAGIC.length + 2;
  if (!isSealed(bytes) || bytes.length < fixed) throw decryptRefusal(phase, 'The encrypted artifact is damaged.');
  const idLength = bytes.readUInt16BE(SEALED_MAGIC.length);
  const headerBytes = fixed + idLength + SALT_BYTES + NONCE_BYTES;
  if (idLength === 0 || idLength > MAX_ID_BYTES || bytes.length < headerBytes + TAG_BYTES) throw decryptRefusal(phase, 'The encrypted artifact is damaged.');
  const sealedFor = bytes.subarray(fixed, fixed + idLength).toString('utf8');
  if (migrationId !== undefined && migrationId !== sealedFor) {
    throw new MigrationRefusal({ code: 'RMIG-E-BUNDLE-DECRYPT', phase, summary: 'The encrypted artifact was made for a different migration id than the one named here.', safe_details: {}, report_path: null });
  }
  const salt = bytes.subarray(fixed + idLength, fixed + idLength + SALT_BYTES);
  const nonce = bytes.subarray(fixed + idLength + SALT_BYTES, headerBytes);
  const key = deriveKey(passphrase, salt);
  let value;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(kind, sealedFor));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(headerBytes, bytes.length - TAG_BYTES)), decipher.final()]);
    value = JSON.parse(plain.toString('utf8'));
  } catch {
    throw decryptRefusal(phase, 'The encrypted artifact could not be opened: wrong passphrase, wrong kind of artifact, or the file was changed.');
  } finally { key.fill(0); }
  if (value?.migration_id !== sealedFor) throw decryptRefusal(phase, 'The encrypted artifact names a different migration inside than the one it was sealed for.');
  return value;
}
