import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson } from './canonical-json.mjs';
import { comparePrimaryKey, normalizeRow } from '../source/row-normalize.mjs';
import { compareCatalog, sourceSpecFor } from './fingerprint.mjs';
import { formatChecksumLines, sha256Hex, assertSafeBundleMemberPath } from './hash.mjs';
import { MigrationRefusal } from './refusal.mjs';
import { applyReviewDecisions, normalizeSecretDecisions, scanRows, secretReviewHash } from './secret-scan.mjs';
import { FORMAT_VERSION, REQUIRED_BUNDLE_ARTIFACTS, validateManifest } from './contracts.mjs';

const MAGIC = Buffer.from('RMIGENC1', 'ascii');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES;
const PASSPHRASE_ENV = 'RM_MIGRATION_PASSPHRASE_FILE';
const VERSION = '1.0.0';

function refusal(code, phase, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase, summary, safe_details: safeDetails, report_path: null });
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Bundle write made no progress.');
    offset += written;
  }
}

function readControlBytes(path) {
  const fd = openSync(path, constants.O_RDONLY);
  const size = fstatSync(fd).size;
  const bytes = Buffer.alloc(size);
  try {
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read <= 0) throw new Error('Bundle control-file read made no progress.');
      offset += read;
    }
    return bytes;
  } finally { closeSync(fd); }
}

function readControlText(path) {
  return readControlBytes(path).toString('utf8');
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertDirectory(path, label, { mustExist = true } = {}) {
  if (typeof path !== 'string' || path.length === 0 || /[\u0000\r\n]/u.test(path)) throw new TypeError(`${label} must be a safe filesystem path.`);
  const resolved = resolve(path);
  if (!mustExist) return resolved;
  let item;
  try { item = lstatSync(resolved); } catch (error) { throw new TypeError(`${label} is unavailable: ${error.code ?? 'unknown'}.`); }
  if (item.isSymbolicLink() || !item.isDirectory()) throw new TypeError(`${label} must be a regular directory and not a symlink.`);
  if (resolve(realpathSync.native(resolved)) !== resolved) throw new TypeError(`${label} must not traverse a symlink.`);
  return resolved;
}

function passphraseBytes({ env = process.env, platform = process.platform, phase = 'export', passphraseFile } = {}) {
  const path = passphraseFile ?? env?.[PASSPHRASE_ENV];
  if (typeof path !== 'string' || path.length === 0) throw refusal('RMIG-E-BUNDLE-DECRYPT', phase, 'An encrypted bundle requires RM_MIGRATION_PASSPHRASE_FILE.', { source: PASSPHRASE_ENV });
  let item;
  try { item = lstatSync(path); } catch { throw refusal('RMIG-E-BUNDLE-DECRYPT', phase, 'The migration passphrase file could not be read.'); }
  if (item.isSymbolicLink() || !item.isFile()) throw refusal('RMIG-E-BUNDLE-DECRYPT', phase, 'The migration passphrase file must be a regular non-symlink file.');
  if (platform !== 'win32' && (item.mode & 0o077) !== 0) throw refusal('RMIG-E-BUNDLE-DECRYPT', phase, 'The migration passphrase file must not be readable by group or other users.');
  let value;
  try { value = readControlBytes(path); } catch { throw refusal('RMIG-E-BUNDLE-DECRYPT', phase, 'The migration passphrase file could not be read.'); }
  if (value.length > 0 && value[value.length - 1] === 0x0a) value = value.subarray(0, value.length - 1);
  if (value.length > 0 && value[value.length - 1] === 0x0d) value = value.subarray(0, value.length - 1);
  if (value.length === 0 || value.includes(0)) {
    value.fill(0);
    throw refusal('RMIG-E-BUNDLE-DECRYPT', phase, 'The migration passphrase file must contain a non-empty passphrase.');
  }
  return value;
}

function aadFor(migrationId, memberName) {
  return Buffer.from(canonicalJson({ format_version: FORMAT_VERSION, migration_id: migrationId, path: memberName }), 'utf8');
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_BYTES, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function openMember(path, encrypted, migrationId, memberName, passphrase) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const plaintextHash = createHash('sha256');
  const storedHash = createHash('sha256');
  let cipher;
  let key;
  let salt;
  let nonce;
  if (encrypted) {
    salt = randomBytes(SALT_BYTES);
    nonce = randomBytes(NONCE_BYTES);
    key = deriveKey(passphrase, salt);
    cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aadFor(migrationId, memberName));
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    salt.copy(header, MAGIC.length);
    nonce.copy(header, MAGIC.length + SALT_BYTES);
    writeAll(fd, header);
    storedHash.update(header);
  }
  let rowCount = 0;
  let closed = false;
  return {
    writeBytes(bytes) {
      if (closed) throw new Error('Bundle member is already closed.');
      const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      plaintextHash.update(input);
      const output = cipher ? cipher.update(input) : input;
      if (output.length > 0) { writeAll(fd, output); storedHash.update(output); }
    },
    writeRow(row) {
      this.writeBytes(Buffer.from(canonicalJson(row), 'utf8'));
      rowCount += 1;
    },
    close() {
      if (closed) return { rowCount, plaintextSha256: plaintextHash.digest('hex'), sha256: storedHash.digest('hex') };
      closed = true;
      try {
        if (cipher) {
          const finalBytes = cipher.final();
          if (finalBytes.length > 0) { writeAll(fd, finalBytes); storedHash.update(finalBytes); }
          const tag = cipher.getAuthTag();
          writeAll(fd, tag);
          storedHash.update(tag);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
        key?.fill(0);
        salt?.fill(0);
        nonce?.fill(0);
      }
      return { rowCount, plaintextSha256: plaintextHash.digest('hex'), sha256: storedHash.digest('hex') };
    },
  };
}

function createNdjsonValidator(expectedCount, expectedHash) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let rowCount = 0;
  return {
    feed(bytes) {
      hash.update(bytes);
      pending += decoder.decode(bytes, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch { throw new Error('NDJSON member contains invalid JSON.'); }
        if (canonicalJson(parsed) !== `${line}\n`) throw new Error('NDJSON member is not canonical JSON.');
        rowCount += 1;
      }
    },
    finish() {
      pending += decoder.decode();
      if (pending.length > 0) throw new Error('NDJSON member must end with LF.');
      if (rowCount !== expectedCount) throw new Error('NDJSON row count mismatch.');
      if (hash.digest('hex') !== expectedHash) throw new Error('Plaintext member checksum mismatch.');
    },
  };
}

function copyBuffer(left, right) {
  const output = Buffer.alloc(left.length + right.length);
  left.copy(output, 0);
  right.copy(output, left.length);
  return output;
}

function streamFile(path, callback) {
  const fd = openSync(path, constants.O_RDONLY);
  const stat = fstatSync(fd);
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, chunk, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (read <= 0) throw new Error('Bundle member read made no progress.');
      callback(chunk.subarray(0, read), offset, stat.size);
      offset += read;
    }
  } finally { closeSync(fd); }
}

function verifyStoredMember(path, manifest, member, passphrase) {
  const storedHash = createHash('sha256');
  const validator = createNdjsonValidator(member.row_count, member.plaintext_sha256);
  if (manifest.bundle_mode !== 'encrypted') {
    streamFile(path, (chunk) => { storedHash.update(chunk); validator.feed(chunk); });
    validator.finish();
  } else {
    const fd = openSync(path, constants.O_RDONLY);
    const stat = fstatSync(fd);
    const header = Buffer.alloc(HEADER_BYTES);
    let headerOffset = 0;
    let tail = Buffer.alloc(0);
    let key;
    try {
      if (stat.size < HEADER_BYTES + TAG_BYTES || readSync(fd, header, 0, HEADER_BYTES, 0) !== HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Encrypted member header is invalid.');
      const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
      const nonce = header.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
      key = deriveKey(passphrase, salt);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aadFor(manifest.migration_id, member.name));
      storedHash.update(header);
      const chunk = Buffer.alloc(64 * 1024);
      let offset = HEADER_BYTES;
      while (offset < stat.size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
        if (read <= 0) throw new Error('Bundle member read made no progress.');
        const stored = chunk.subarray(0, read);
        storedHash.update(stored);
        const combined = copyBuffer(tail, stored);
        const processLength = Math.max(0, combined.length - TAG_BYTES);
        if (processLength > 0) validator.feed(decipher.update(combined.subarray(0, processLength)));
        tail = Buffer.from(combined.subarray(processLength));
        offset += read;
      }
      if (tail.length !== TAG_BYTES) throw new Error('Encrypted member authentication failed.');
      decipher.setAuthTag(tail);
      const finalBytes = decipher.final();
      if (finalBytes.length > 0) validator.feed(finalBytes);
      validator.finish();
    } catch (error) {
      if (error.message.includes('checksum') || error.message.includes('NDJSON') || error.message.includes('row count')) throw error;
      throw new Error('Encrypted member authentication failed.');
    } finally { closeSync(fd); key?.fill(0); }
  }
  if (storedHash.digest('hex') !== member.sha256) throw new Error(`Member checksum mismatch for ${member.name}.`);
}


function memberNamesFromManifest(manifest) {
  return manifest.members.map(({ name }) => name);
}

function validateBundleDirectory(path) {
  const root = assertDirectory(path, 'Bundle path');
  const manifestPath = join(root, 'manifest.json');
  const checksumsPath = join(root, 'checksums.sha256');
  let manifest;
  try { manifest = JSON.parse(readControlText(manifestPath)); } catch { throw new Error('Bundle manifest is missing or invalid.'); }
  validateManifest(manifest);
  const names = new Set(memberNamesFromManifest(manifest));
  const expected = new Set(['envelope.json', 'manifest.json', 'checksums.sha256', ...memberNamesFromManifest(manifest)]);
  const actual = new Set();
  const walk = (directory, relative = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Bundle contains a symlink.');
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) actual.add(rel);
      else throw new Error('Bundle contains a non-regular member.');
    }
  };
  walk(root);
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name))) throw new Error('Bundle contains missing or extra members.');
  const checksumText = readControlText(checksumsPath);
  if (!checksumText.endsWith('\n') || checksumText.endsWith('\n\n')) throw new Error('Bundle checksum file must have exactly one final LF.');
  const checksumMap = new Map();
  let previousChecksumName = null;
  for (const line of checksumText.split('\n')) {
    if (line === '') continue;
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/u);
    if (!match) throw new Error('Bundle checksum file is malformed.');
    assertSafeBundleMemberPath(match[2]);
    if (checksumMap.has(match[2])) throw new Error('Bundle checksum file contains duplicate members.');
    if (previousChecksumName !== null && previousChecksumName >= match[2]) throw new Error('Bundle checksum file is not sorted.');
    previousChecksumName = match[2];
    checksumMap.set(match[2], match[1]);
  }
  if (checksumMap.size !== expected.size - 1 || checksumMap.has('checksums.sha256') || !checksumMap.has('manifest.json') || !checksumMap.has('envelope.json')) throw new Error('Bundle checksum file has missing or extra entries.');
  if (sha256Hex(readControlBytes(manifestPath)) !== checksumMap.get('manifest.json')) throw new Error('Manifest checksum mismatch.');
  const envelopePath = join(root, 'envelope.json');
  if (sha256Hex(readControlBytes(envelopePath)) !== checksumMap.get('envelope.json')) throw new Error('Envelope checksum mismatch.');
  let envelope;
  try { envelope = JSON.parse(readControlText(envelopePath)); } catch { throw new Error('Bundle envelope is invalid.'); }
  if (envelope?.format_version !== FORMAT_VERSION || envelope.migration_id !== manifest.migration_id || envelope.bundle_mode !== manifest.bundle_mode || envelope.manifest_sha256 !== checksumMap.get('manifest.json')) throw new Error('Bundle envelope does not match the manifest.');
  const requiredNames = REQUIRED_BUNDLE_ARTIFACTS.map((name) => `${name}${manifest.bundle_mode === 'encrypted' ? '.enc' : ''}`);
  if (!Array.isArray(envelope.required_artifacts) || envelope.required_artifacts.length !== requiredNames.length || envelope.required_artifacts.some((name, index) => name !== requiredNames[index])) throw new Error('Bundle envelope required artifacts are incomplete.');
  for (const member of manifest.members) {
    if (checksumMap.get(member.name) !== member.sha256) throw new Error(`Manifest checksum does not match ${member.name}.`);
  }
  return { root, manifest };
}

function catalogTables(catalog) {
  return [...catalog.tables].sort((a, b) => a.name.localeCompare(b.name));
}

async function* orderedRows(adapter, table) {
  const primaryKey = table.primary_key ?? [];
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) throw refusal('RMIG-E-BUNDLE-INTEGRITY', 'export', 'Every exported table must have a deterministic primary-key order.', { table: table.name });
  let previous;
  for await (const raw of adapter.streamTable(table.name, primaryKey)) {
    const row = normalizeRow(raw);
    for (const key of primaryKey) if (!Object.hasOwn(row, key)) throw refusal('RMIG-E-BUNDLE-INTEGRITY', 'export', 'A source row is missing its primary-key column.', { table: table.name });
    if (previous !== undefined && comparePrimaryKey(previous, row, primaryKey) > 0) throw refusal('RMIG-E-BUNDLE-INTEGRITY', 'export', 'The source adapter did not provide deterministic primary-key order.', { table: table.name });
    previous = row;
    yield row;
  }
}

export async function createBundle({
  adapter,
  sourceKind,
  sourceFingerprint,
  sourceReport,
  migrationId,
  timestamp = new Date().toISOString(),
  migratorVersion = VERSION,
  outputPath,
  mode = 'encrypted',
  allowPlaintextBundle = false,
  acknowledgePlaintextRisk = false,
  tables,
  passphraseFile,
  env = process.env,
  platform = process.platform,
  secretDecisions = {},
  falsePositiveAcknowledgements = [],
  beforeFinalize,
} = {}) {
  if (!adapter || typeof adapter.beginSnapshot !== 'function' || typeof adapter.catalog !== 'function' || typeof adapter.streamTable !== 'function') throw new TypeError('Bundle export requires a source adapter.');
  if (!['postgres', 'sqlite', 'd1-export'].includes(sourceKind)) throw refusal('RMIG-E-SOURCE-ARG', 'export', 'Bundle export requires a supported source kind.');
  if (mode !== 'encrypted' && mode !== 'plaintext') throw refusal('RMIG-E-SOURCE-ARG', 'export', 'Bundle mode must be encrypted or plaintext.');
  if (tables !== undefined) throw refusal('RMIG-E-SOURCE-ARG', 'export', 'Partial table exports are not supported; export every fingerprinted table.');
  if (mode === 'plaintext' && (allowPlaintextBundle !== true || acknowledgePlaintextRisk !== true)) throw refusal('RMIG-E-BUNDLE-PLAINTEXT-ACK', 'export', 'Plaintext bundles require both explicit acknowledgement flags.');
  if (typeof migrationId !== 'string' || typeof outputPath !== 'string') throw refusal('RMIG-E-SOURCE-ARG', 'export', 'Bundle export requires a migration ID and output path.');
  const destination = resolve(outputPath);
  const parent = assertDirectory(dirname(destination), 'Bundle parent directory');
  if (basename(destination) === '.' || basename(destination) === '..') throw new TypeError('Bundle output must name a directory.');
  if (existsSync(destination)) throw new Error('Bundle output already exists.');
  let passphrase;
  if (mode === 'encrypted') passphrase = passphraseBytes({ env, platform, passphraseFile });
  let secretReview;
  try { secretReview = normalizeSecretDecisions(secretDecisions, falsePositiveAcknowledgements); }
  catch (error) { throw refusal('RMIG-E-SECRET-DETECTED', 'export', 'Secret review decisions must be structured and valid.', { reason: error.message }); }
  const decisionMap = Object.fromEntries(secretReview.decisions.map((item) => [item.review_id, item]));
  const acknowledgedFalsePositives = secretReview.false_positive_acknowledgements;
  const seenReviewIds = new Set();
  const incomplete = join(parent, `.${basename(destination)}.${randomBytes(12).toString('hex')}.incomplete`);
  let finalized = false;
  let adapterStarted = false;
  try {
    mkdirSync(incomplete, { mode: 0o700 });
    const dataDirectory = join(incomplete, 'data');
    mkdirSync(dataDirectory, { mode: 0o700 });
    await adapter.beginSnapshot();
    adapterStarted = true;
    const catalog = await adapter.catalog();
    const expectedKind = sourceKind === 'd1-export' ? 'sqlite' : sourceKind;
    const comparison = compareCatalog(catalog, sourceSpecFor(expectedKind));
    if (!comparison.match) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'export', 'The source catalog is not the exact supported v3.2 schema.', { expected_fingerprint: comparison.expectedFingerprint, actual_fingerprint: comparison.actualFingerprint });
    if (sourceFingerprint !== undefined && sourceFingerprint !== comparison.actualFingerprint) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'export', 'The source fingerprint does not match the exact catalog.', { expected_fingerprint: sourceFingerprint, actual_fingerprint: comparison.actualFingerprint });
    if (sourceReport !== undefined && sourceReport?.details?.actual_fingerprint !== comparison.actualFingerprint) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'export', 'The source report fingerprint does not match the exact catalog.');
    const chosenTables = catalogTables(catalog);
    const members = [];
    for (const table of chosenTables) {
      const memberName = `data/${table.name}.ndjson${mode === 'encrypted' ? '.enc' : ''}`;
      const memberPath = join(incomplete, ...memberName.split('/'));
      const writer = openMember(memberPath, mode === 'encrypted', migrationId, memberName, passphrase);
      try {
        for await (const row of orderedRows(adapter, table)) {
          const scan = scanRows([row], { table: table.name, primaryKey: table.primary_key, falsePositiveAcknowledgements: acknowledgedFalsePositives });
          if (scan.highConfidence.length > 0) throw refusal('RMIG-E-SECRET-DETECTED', 'export', 'High-confidence credentials were detected in source metadata or configuration.', { findings: scan.highConfidence.map(({ table: t, column, kind, value_sha256 }) => ({ table: t, column, kind, value_sha256 })) });
          for (const item of scan.reviewItems) seenReviewIds.add(item.review_id);
          let decisionResult;
          try { decisionResult = applyReviewDecisions(row, scan.reviewItems, decisionMap); }
          catch { throw refusal('RMIG-E-SECRET-DETECTED', 'export', 'A lived-content secret review decision is missing or invalid.', { review_ids: scan.reviewItems.map(({ review_id }) => review_id) }); }
          if (!decisionResult.exclude) writer.writeRow(decisionResult.row);
        }
        const result = writer.close();
        members.push({ name: memberName, sha256: result.sha256, plaintext_sha256: result.plaintextSha256, row_count: result.rowCount });
      } catch (error) {
        try { writer.close(); } catch { /* primary error wins */ }
        throw error;
      }
    }
    for (const item of secretReview.decisions) if (!seenReviewIds.has(item.review_id)) throw refusal('RMIG-E-SECRET-DETECTED', 'export', 'A supplied secret review decision did not match a lived-content finding.', { review_id: item.review_id });
    const persistedSecretReview = { ...secretReview, sha256: secretReviewHash(secretReview) };
    mkdirSync(join(incomplete, 'external'), { mode: 0o700 });
    const addArtifact = (relativeName, value) => {
      const memberName = `${relativeName}${mode === 'encrypted' ? '.enc' : ''}`;
      const memberPath = join(incomplete, ...memberName.split('/'));
      const writer = openMember(memberPath, mode === 'encrypted', migrationId, memberName, passphrase);
      writer.writeBytes(Buffer.from(canonicalJson(value), 'utf8'));
      const result = writer.close();
      members.push({ name: memberName, sha256: result.sha256, plaintext_sha256: result.plaintextSha256, row_count: 1 });
    };
    addArtifact('source-report.json', sourceReport ?? { format_version: FORMAT_VERSION, migration_id: migrationId, status: 'pending', reason: 'source-report was not supplied to export', source_fingerprint: comparison.actualFingerprint, secret_review_sha256: persistedSecretReview.sha256 });
    addArtifact('policy-template.json', { format_version: FORMAT_VERSION, migration_id: migrationId, status: 'pending', decisions_required: true, reason: 'policy compilation is a later phase' });
    addArtifact('external/images.json', { format_version: FORMAT_VERSION, migration_id: migrationId, status: 'pending', reason: 'image inventory and copy are external phases' });
    addArtifact('external/reembed-jobs.ndjson', { format_version: FORMAT_VERSION, migration_id: migrationId, status: 'pending', reason: 're-embedding is an external phase', legacy_vectors_imported: false });
    members.sort((left, right) => left.name.localeCompare(right.name));
    const manifest = {
      format_version: FORMAT_VERSION,
      migrator_version: migratorVersion,
      migration_id: migrationId,
      created_at: timestamp,
      source_kind: sourceKind,
      source_fingerprint: comparison.actualFingerprint,
      bundle_mode: mode,
      plaintext_acknowledgements: { allow_plaintext_bundle: mode === 'plaintext', acknowledge_plaintext_risk: mode === 'plaintext' },
      secret_review: persistedSecretReview,
      members,
    };
    validateManifest(manifest);
    const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
    const manifestPath = join(incomplete, 'manifest.json');
    const manifestFd = openSync(manifestPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeAll(manifestFd, manifestBytes); fsyncSync(manifestFd); } finally { closeSync(manifestFd); }
    const envelope = {
      format_version: FORMAT_VERSION,
      migration_id: migrationId,
      manifest_sha256: sha256Hex(manifestBytes),
      bundle_mode: mode,
      encryption: mode === 'encrypted' ? { cipher: 'aes-256-gcm', key_derivation: 'scrypt', members_independently_authenticated: true } : null,
      required_artifacts: REQUIRED_BUNDLE_ARTIFACTS.map((name) => `${name}${mode === 'encrypted' ? '.enc' : ''}`),
    };
    const envelopeBytes = Buffer.from(canonicalJson(envelope), 'utf8');
    const envelopeFd = openSync(join(incomplete, 'envelope.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeAll(envelopeFd, envelopeBytes); fsyncSync(envelopeFd); } finally { closeSync(envelopeFd); }
    const checksumEntries = [{ name: 'envelope.json', sha256: sha256Hex(envelopeBytes) }, { name: 'manifest.json', sha256: sha256Hex(manifestBytes) }, ...members.map(({ name, sha256 }) => ({ name, sha256 }))];
    const checksumBytes = Buffer.from(formatChecksumLines(checksumEntries), 'utf8');
    const checksumFd = openSync(join(incomplete, 'checksums.sha256'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeAll(checksumFd, checksumBytes); fsyncSync(checksumFd); } finally { closeSync(checksumFd); }
    beforeFinalize?.({ incompletePath: incomplete, manifest });
    syncDirectory(dataDirectory);
    syncDirectory(incomplete);
    renameSync(incomplete, destination);
    finalized = true;
    syncDirectory(parent);
    return { path: destination, manifest };
  } finally {
    if (adapterStarted) {
      try { await adapter.endSnapshot(); } catch { /* preserve primary result */ }
    }
    try { await adapter.close?.(); } catch { /* preserve primary result */ }
    passphrase?.fill(0);
    if (!finalized) rmSync(incomplete, { recursive: true, force: true });
  }
}

export function verifyBundle({ path, env = process.env, platform = process.platform, passphraseFile } = {}) {
  let bundle;
  try { bundle = validateBundleDirectory(path); }
  catch (error) { throw refusal('RMIG-E-BUNDLE-INTEGRITY', 'verify-bundle', error.message); }
  let passphrase;
  try {
    if (bundle.manifest.bundle_mode === 'encrypted') passphrase = passphraseBytes({ env, platform, phase: 'verify-bundle', passphraseFile });
    for (const member of bundle.manifest.members) verifyStoredMember(join(bundle.root, ...member.name.split('/')), bundle.manifest, member, passphrase);
    return { ok: true, path: bundle.root, manifest: bundle.manifest };
  } catch (error) {
    if (error instanceof MigrationRefusal) throw error;
    throw refusal(error.message.includes('authentication') ? 'RMIG-E-BUNDLE-DECRYPT' : 'RMIG-E-BUNDLE-INTEGRITY', 'verify-bundle', error.message);
  } finally {
    passphrase?.fill(0);
  }
}

export async function writeNdjsonMember({ path, rows, encrypted = false, migrationId, memberName, passphrase } = {}) {
  if (typeof path !== 'string' || typeof memberName !== 'string' || !rows || typeof rows[Symbol.asyncIterator] !== 'function' && typeof rows[Symbol.iterator] !== 'function') throw new TypeError('NDJSON member writer requires a path, member name, and iterable rows.');
  const writer = openMember(path, encrypted, migrationId, memberName, passphrase);
  try {
    for await (const row of rows) writer.writeRow(row);
    return writer.close();
  } catch (error) {
    try { writer.close(); } catch { /* preserve primary error */ }
    throw error;
  }
}

export const writeMember = writeNdjsonMember;
export const readPassphraseFile = passphraseBytes;
export { passphraseBytes, aadFor, MAGIC, HEADER_BYTES };
