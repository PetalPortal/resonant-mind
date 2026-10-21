import { createHash } from 'node:crypto';
import { createReadStream, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, readdirSync, statSync, writeSync, fsyncSync, constants } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { ObjectStore, assertObjectStore } from './object-store.mjs';
import { mimeFor as sniffMime } from './images.mjs';
import { sealImageReceipt } from '../lib/report-seal.mjs';

function refuse(summary, details = {}) { return new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary, safe_details: details, report_path: null }); }
function safeKey(key) { if (typeof key !== 'string' || key.length === 0 || key.includes('\\') || isAbsolute(key) || key.split('/').some((part) => !part || part === '.' || part === '..')) throw refuse('Image object key is not a safe relative path.', { reason: 'unsafe-path' }); return key; }
function assertNoSymlinkComponents(root, key) { let current = resolve(root); for (const part of key.split('/').slice(0, -1)) { current = join(current, part); let stat; try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; } if (stat.isSymbolicLink()) throw refuse('Image path traverses a symlink.', { reason: 'symlink' }); } }
function regularPath(root, key, { allowMissing = false } = {}) {
  safeKey(key); assertNoSymlinkComponents(root, key); const base = resolve(root); const candidate = resolve(base, ...key.split('/')); const rel = relative(base, candidate); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refuse('Image path escapes the configured object root.', { reason: 'escapes-root' });
  let stat; try { stat = lstatSync(candidate); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw refuse('An image object is missing.', { reason: 'missing' }); }
  if (stat.isSymbolicLink()) throw refuse('Symlink image objects are refused.', { reason: 'symlink' }); if (!stat.isFile()) throw refuse('Image object must be a regular file.', { reason: 'not-a-regular-file' });
  const realRoot = resolve(realpathSync.native(base)); const realCandidate = resolve(realpathSync.native(candidate)); const realRel = relative(realRoot, realCandidate); if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw refuse('Image path resolves outside the configured object root.', { reason: 'escapes-root' });
  return { path: candidate, stat };
}
function readHandle(root, key) {
  const found = regularPath(root, key); let fd;
  try {
    fd = openSync(found.path, constants.O_RDONLY);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== found.stat.size || (opened.dev !== undefined && found.stat.dev !== undefined && opened.dev !== found.stat.dev) || (opened.ino !== undefined && found.stat.ino !== undefined && opened.ino !== found.stat.ino)) throw refuse('Image source changed while it was being opened.', { reason: 'changed-while-reading' });
    const bytes = readFileSync(fd); const after = fstatSync(fd); if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw refuse('Image source changed while it was being read.', { reason: 'changed-while-reading' });
    const sha256 = createHash('sha256').update(bytes).digest('hex'); return { bytes, sha256, size: bytes.byteLength, mime: sniffMime(bytes) };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export class FilesystemObjectStore extends ObjectStore {
  constructor(root) { super(); if (typeof root !== 'string' || root.length === 0) throw new TypeError('Filesystem object root is required.'); const stat = lstatSync(root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw refuse('Filesystem object root must be a real directory.'); if (resolve(realpathSync.native(root)) !== resolve(root)) throw refuse('Filesystem object root must not traverse a symlink.'); this.root = resolve(root); }
  async inventory(options = {}) {
    const requested = options.keys ?? null; const output = []; const seenHash = new Map();
    const walk = (dir, prefix = '') => { const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); for (const entry of entries) { const key = prefix ? `${prefix}/${entry.name}` : entry.name; safeKey(key); const path = join(this.root, ...key.split('/')); const stat = lstatSync(path); if (stat.isSymbolicLink()) throw refuse('Symlink image objects are refused.'); if (stat.isDirectory()) walk(path, key); else if (stat.isFile()) { const item = readHandle(this.root, key); const value = { key, size: item.size, sha256: item.sha256, mime: item.mime }; const duplicateOf = seenHash.get(item.sha256); if (duplicateOf !== undefined) value.duplicate_of = duplicateOf; else seenHash.set(item.sha256, key); output.push(value); } else throw refuse('Special image filesystem entries are refused.'); } };
    if (requested) for (const key of requested) { const found = regularPath(this.root, key, { allowMissing: true }); if (!found) output.push({ key, missing: true }); else output.push({ key, ...readHandle(this.root, key) }); }
    else walk(this.root);
    return output.sort((a, b) => a.key.localeCompare(b.key));
  }
  async openRead(key) { const found = regularPath(this.root, key); const fd = openSync(found.path, constants.O_RDONLY); const opened = fstatSync(fd); if (!opened.isFile() || opened.size !== found.stat.size) { closeSync(fd); throw refuse('Image source changed while it was being opened.'); } return createReadStream(null, { fd, autoClose: true }); }
  async readVerified(key) { return readHandle(this.root, key); }
  async put(key, body, metadata = {}) {
    safeKey(key); assertNoSymlinkComponents(this.root, key); const destination = resolve(this.root, ...key.split('/')); const parent = dirname(destination); mkdirSync(parent, { recursive: true }); assertNoSymlinkComponents(this.root, key); const realParent = resolve(realpathSync.native(parent)); if (relative(this.root, realParent).startsWith(`..${sep}`)) throw refuse('Image destination parent escapes the configured object root.');
    const bytes = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer()); const expected = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength, mime: metadata.mime ?? sniffMime(bytes) };
    let fd;
    try { fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); let offset = 0; while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) throw new Error('Image write made no progress.'); offset += count; } fsyncSync(fd); closeSync(fd); fd = undefined; }
    catch (error) { if (fd !== undefined) closeSync(fd); if (error?.code !== 'EEXIST') throw error; const existing = await this.verify(key, expected); if (existing.verified) return { key, ...expected, bytes }; throw refuse('Refusing to replace a different existing image object.'); }
    const verified = await this.verify(key, expected); if (!verified.verified) throw refuse('Image destination changed during the exclusive write.'); return { key, ...expected, bytes };
  }
  async verify(key, expected = {}) { const found = regularPath(this.root, key, { allowMissing: true }); if (!found) return { key, exists: false, verified: false }; const actual = readHandle(this.root, key); const verified = (!expected.sha256 || expected.sha256 === actual.sha256) && (expected.size === undefined || Number(expected.size) === actual.size) && (!expected.mime || expected.mime.toLowerCase() === actual.mime); return { key, exists: true, verified, sha256: actual.sha256, size: actual.size, mime: actual.mime }; }
}
export async function buildFilesystemInventory(root, options = {}) { return new FilesystemObjectStore(root).inventory(options); }
function targetEntries(plan) { return Array.isArray(plan?.entries) ? plan.entries : []; }
function planHash(plan) { const copy = { ...plan }; delete copy.plan_sha256; return canonicalSha256(copy); }

// What a source object is, observed from its bytes: SHA-256, size, and a MIME type detected from the content's
// magic bytes (never from the file name). A source that cannot be read is { ok: false, reason }, never a skip.
const fingerprintOf = (item) => ({ sha256: item.sha256, size: Number(item.size), mime: String(item.mime).toLowerCase() });
const sameFingerprint = (a, b) => a.sha256 === b.sha256 && a.size === b.size && a.mime === b.mime;
async function observe(store, key) {
  try {
    if (typeof store.readVerified === 'function') { const item = await store.readVerified(key); return { ok: true, fingerprint: fingerprintOf(item), bytes: item.bytes }; }
    const [item] = await store.inventory({ keys: [key] });
    if (!item || item.missing) return { ok: false, reason: 'missing' };
    return { ok: true, fingerprint: fingerprintOf(item) };
  } catch (error) { return { ok: false, reason: error instanceof MigrationRefusal && typeof error.safe_details?.reason === 'string' ? error.safe_details.reason : 'unreadable' }; }
}
// The values a plan states for an object (a source that stores none states none) are held to what was observed.
function plannedDisagrees(entry, seen) {
  if (entry.expected_sha256 !== null && entry.expected_sha256 !== undefined && entry.expected_sha256 !== seen.sha256) return true;
  if (entry.expected_size !== null && entry.expected_size !== undefined && Number(entry.expected_size) !== seen.size) return true;
  if (entry.expected_mime !== null && entry.expected_mime !== undefined && String(entry.expected_mime).toLowerCase() !== seen.mime) return true;
  return false;
}

/**
 * Copies every object the image plan lists and returns the receipt. v3.2's images table stores no hash, size or
 * MIME type, so for such a source the plan states none and the tool is the one that observes them:
 *  1. every source object is fingerprinted first (SHA-256, size, content-detected MIME), and a source that is
 *     missing, unreadable, a symlink or outside the source root, not an image, or at odds with a value the plan
 *     does state, refuses the whole copy before anything is written;
 *  2. each object is then read again and must still be the fingerprinted object, is written exclusively (never
 *     over a different existing object), read back and hashed, and the source is hashed once more after the
 *     copy: an object whose bytes changed between fingerprint and copy, or whose copy differs, is a failure;
 *  3. any failure refuses the copy as a whole and names each failed object, by its target key and the reason.
 *     No receipt is returned, so none can be mistaken for a complete copy.
 * The receipt records, per object, the fingerprint observed at copy time (`source_fingerprint`) and what the
 * copy hashed to; validate re-hashes the target objects and holds them to it.
 *
 * With `sealPassphrase` (the migration passphrase, as bytes) the receipt carries `receipt_seal`, the keyed seal
 * the report uses. A receipt with no trusted signature (this one has none) completes images in `validate` only
 * with a valid seal, because otherwise it is a plain file whose hash anyone could recompute, including from the
 * target directory itself.
 */
export async function copyImagePlan({ plan, sourceStore, targetStore, migrationId = plan?.migration_id, bundleManifestSha256 = plan?.bundle_manifest_sha256, compiledPolicySha256 = plan?.compiled_policy_sha256, sealPassphrase } = {}) {
  assertObjectStore(sourceStore); assertObjectStore(targetStore);
  if (!plan || plan.plan_sha256 !== planHash(plan)) throw refuse('Image copy requires an intact image inventory plan.');
  const objects = []; const keys = new Set();
  for (const entry of targetEntries(plan)) {
    const source = entry.source_logical_path ?? entry.source_key; const target = entry.target_key;
    if (typeof source !== 'string' || typeof target !== 'string') throw refuse('Image plan contains an incomplete object entry.');
    if (keys.has(target)) throw refuse('Image plan contains duplicate target keys.');
    keys.add(target); objects.push({ entry, source, target });
  }
  const failures = [];
  const fail = (target, reason) => failures.push({ target_key: target, reason });
  const refuseCopy = () => refuse(`${failures.length} of ${objects.length} planned image objects could not be copied; no receipt was written.`, { failed: failures.length, planned: objects.length, objects: failures.slice(0, 50) });

  // 1. fingerprint every source object, and write nothing until every one of them can be
  const fingerprints = new Map();
  for (const { entry, source, target } of objects) {
    const seen = await observe(sourceStore, source);
    if (!seen.ok) { fail(target, seen.reason); continue; }
    if (!/^image\/[a-z0-9.+-]+$/u.test(seen.fingerprint.mime)) { fail(target, 'not-a-recognised-image'); continue; }
    if (plannedDisagrees(entry, seen.fingerprint)) { fail(target, 'differs-from-plan'); continue; }
    fingerprints.set(target, seen.fingerprint);
  }
  if (failures.length > 0) throw refuseCopy();

  // 2. copy, read back, and look at the source again
  const receipts = [];
  for (const { entry, source, target } of objects) {
    const fingerprint = fingerprints.get(target);
    const atCopy = await observe(sourceStore, source);
    if (!atCopy.ok) { fail(target, atCopy.reason); continue; }
    if (!sameFingerprint(atCopy.fingerprint, fingerprint)) { fail(target, 'source-changed-after-fingerprint'); continue; }
    let verified;
    try {
      const current = await targetStore.verify(target, fingerprint);
      if (!current.verified) { const bytes = atCopy.bytes ?? Buffer.from(await new Response(await sourceStore.openRead(source)).arrayBuffer()); await targetStore.put(target, bytes, { mime: fingerprint.mime }); }
      verified = await targetStore.verify(target, fingerprint);
    } catch (error) { fail(target, error instanceof MigrationRefusal && /different existing/u.test(error.summary) ? 'target-holds-a-different-object' : 'copy-failed'); continue; }
    if (!verified.verified) { fail(target, 'copy-differs-from-source'); continue; }
    const after = await observe(sourceStore, source);
    if (!after.ok || !sameFingerprint(after.fingerprint, fingerprint)) { fail(target, 'source-changed-during-copy'); continue; }
    receipts.push({ source_table: entry.source_table ?? 'images', source_id: entry.source_id, image_id: entry.linked_target_ids?.image_id, source_logical_path: source, target_key: target, target_locator: entry.target_locator ?? { store: 'object', key: target }, source_fingerprint: { ...fingerprint }, source_sha256: fingerprint.sha256, status: 'complete', verified: true, sha256: verified.sha256, size: verified.size, mime: verified.mime });
  }
  if (failures.length > 0) throw refuseCopy();
  const base = { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: migrationId, plan_sha256: plan.plan_sha256, entries: receipts }; if (bundleManifestSha256 !== undefined) base.bundle_manifest_sha256 = bundleManifestSha256; if (compiledPolicySha256 !== undefined) base.compiled_policy_sha256 = compiledPolicySha256; const receipt = { ...base }; receipt.receipt_sha256 = canonicalSha256(receipt); if (sealPassphrase !== undefined) receipt.receipt_seal = sealImageReceipt(receipt, sealPassphrase); return receipt;
}
export { safeKey, sniffMime as mimeFor, readHandle };
export const FilesystemStore = FilesystemObjectStore;
export const createFilesystemStore = (root) => new FilesystemObjectStore(root);