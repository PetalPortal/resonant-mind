import { createHash } from 'node:crypto';
import { createReadStream, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, readdirSync, statSync, writeSync, fsyncSync, constants } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { ObjectStore, assertObjectStore } from './object-store.mjs';
import { mimeFor as sniffMime } from './images.mjs';

function refuse(summary, details = {}) { return new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary, safe_details: details, report_path: null }); }
function safeKey(key) { if (typeof key !== 'string' || key.length === 0 || key.includes('\\') || isAbsolute(key) || key.split('/').some((part) => !part || part === '.' || part === '..')) throw refuse('Image object key is not a safe relative path.'); return key; }
function assertNoSymlinkComponents(root, key) { let current = resolve(root); for (const part of key.split('/').slice(0, -1)) { current = join(current, part); let stat; try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; } if (stat.isSymbolicLink()) throw refuse('Image path traverses a symlink.'); } }
function regularPath(root, key, { allowMissing = false } = {}) {
  safeKey(key); assertNoSymlinkComponents(root, key); const base = resolve(root); const candidate = resolve(base, ...key.split('/')); const rel = relative(base, candidate); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refuse('Image path escapes the configured object root.');
  let stat; try { stat = lstatSync(candidate); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw refuse('An image object is missing.'); }
  if (stat.isSymbolicLink()) throw refuse('Symlink image objects are refused.'); if (!stat.isFile()) throw refuse('Image object must be a regular file.');
  const realRoot = resolve(realpathSync.native(base)); const realCandidate = resolve(realpathSync.native(candidate)); const realRel = relative(realRoot, realCandidate); if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw refuse('Image path resolves outside the configured object root.');
  return { path: candidate, stat };
}
function readHandle(root, key) {
  const found = regularPath(root, key); let fd;
  try {
    fd = openSync(found.path, constants.O_RDONLY);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== found.stat.size || (opened.dev !== undefined && found.stat.dev !== undefined && opened.dev !== found.stat.dev) || (opened.ino !== undefined && found.stat.ino !== undefined && opened.ino !== found.stat.ino)) throw refuse('Image source changed while it was being opened.');
    const bytes = readFileSync(fd); const after = fstatSync(fd); if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw refuse('Image source changed while it was being read.');
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
export async function copyImagePlan({ plan, sourceStore, targetStore, migrationId = plan?.migration_id, bundleManifestSha256 = plan?.bundle_manifest_sha256, compiledPolicySha256 = plan?.compiled_policy_sha256 } = {}) {
  assertObjectStore(sourceStore); assertObjectStore(targetStore); if (!plan || plan.plan_sha256 !== planHash(plan)) throw refuse('Image copy requires an intact image inventory plan.'); const entries = targetEntries(plan); const seen = new Map(); const receipts = [];
  for (const entry of entries) {
    if (typeof entry.expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.expected_sha256) || !Number.isSafeInteger(Number(entry.expected_size)) || Number(entry.expected_size) < 0 || typeof entry.expected_mime !== 'string' || !/^image\//u.test(entry.expected_mime)) throw refuse('Image plan requires exact SHA-256, size, and MIME metadata.');
    const source = entry.source_logical_path ?? entry.source_key; const target = entry.target_key; if (typeof source !== 'string' || typeof target !== 'string') throw refuse('Image plan contains an incomplete object entry.');
    if (seen.has(target) && seen.get(target) !== entry.expected_sha256) throw refuse('Image plan contains duplicate target keys with different content.'); seen.set(target, entry.expected_sha256);
    const expected = { sha256: entry.expected_sha256, size: entry.expected_size, mime: entry.expected_mime }; let sourceMeta;
    if (typeof sourceStore.readVerified === 'function') sourceMeta = await sourceStore.readVerified(source); else { const sourceInventory = await sourceStore.inventory({ keys: [source] }); sourceMeta = sourceInventory[0]; if (!sourceMeta || sourceMeta.missing) sourceMeta = { missing: true }; }
    if (!sourceMeta || sourceMeta.missing) throw refuse('One or more planned image objects are missing.');
    if (sourceMeta.sha256 !== expected.sha256 || Number(sourceMeta.size) !== Number(expected.size) || sourceMeta.mime !== expected.mime) throw refuse('Image source content does not match the exact planned hash, size, or MIME.');
    const current = await targetStore.verify(target, expected); if (!current.verified) { const bytes = sourceMeta.bytes ?? Buffer.from(await new Response(await sourceStore.openRead(source)).arrayBuffer()); await targetStore.put(target, bytes, { mime: sourceMeta.mime }); }
    const verified = await targetStore.verify(target, expected); if (!verified.verified) throw refuse('Image destination did not verify against the exact planned object.');
    receipts.push({ source_logical_path: source, target_key: target, target_locator: entry.target_locator ?? { store: 'object', key: target }, source_sha256: sourceMeta.sha256, status: 'complete', verified: true, sha256: verified.sha256, size: verified.size, mime: verified.mime });
  }
  const base = { format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: migrationId, plan_sha256: plan.plan_sha256, entries: receipts }; if (bundleManifestSha256 !== undefined) base.bundle_manifest_sha256 = bundleManifestSha256; if (compiledPolicySha256 !== undefined) base.compiled_policy_sha256 = compiledPolicySha256; const receipt = { ...base }; receipt.receipt_sha256 = canonicalSha256(receipt); return receipt;
}
export { safeKey, sniffMime as mimeFor, readHandle };
export const FilesystemStore = FilesystemObjectStore;
export const createFilesystemStore = (root) => new FilesystemObjectStore(root);