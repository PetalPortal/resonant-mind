import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../lib/hash.mjs';
import { ObjectStore, assertObjectStore } from './object-store.mjs';

function refuse(summary, details = {}) {
  return new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary, safe_details: details, report_path: null });
}
function safeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\\') || isAbsolute(key) || key.split('/').some((part) => !part || part === '.' || part === '..')) throw refuse('Image object key is not a safe relative path.');
  return key;
}
function mimeFor(key, bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' })[extname(key).toLowerCase()] ?? 'application/octet-stream';
}
function assertNoSymlinkComponents(root, key) { let current = resolve(root); for (const part of key.split('/').slice(0, -1)) { current = join(current, part); let stat; try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; } if (stat.isSymbolicLink()) throw refuse('Image path traverses a symlink.'); } }
function regularPath(root, key, { allowMissing = false } = {}) {
  safeKey(key); assertNoSymlinkComponents(root, key); const base = resolve(root); const candidate = resolve(base, ...key.split('/'));
  const rel = relative(base, candidate); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refuse('Image path escapes the configured object root.');
  let stat; try { stat = lstatSync(candidate); } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw refuse('An image object is missing.'); }
  if (stat.isSymbolicLink()) throw refuse('Symlink image objects are refused.');
  if (!stat.isFile()) throw refuse('Image object must be a regular file.');
  const realRoot = resolve(realpathSync.native(base)); const realCandidate = resolve(realpathSync.native(candidate)); const realRel = relative(realRoot, realCandidate);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw refuse('Image path resolves outside the configured object root.');
  return { path: candidate, stat };
}
function digestFile(path) { const bytes = readFileSync(path); return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength }; }

export class FilesystemObjectStore extends ObjectStore {
  constructor(root) { super(); if (typeof root !== 'string' || root.length === 0) throw new TypeError('Filesystem object root is required.'); const stat = lstatSync(root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw refuse('Filesystem object root must be a real directory.'); if (resolve(realpathSync.native(root)) !== resolve(root)) throw refuse('Filesystem object root must not traverse a symlink.'); this.root = resolve(root); }
  async inventory(options = {}) {
    const requested = options.keys ?? null; const output = []; const seenHash = new Map();
    const walk = (dir, prefix = '') => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name; safeKey(key); const path = join(this.root, ...key.split('/')); const stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw refuse('Symlink image objects are refused.');
        if (stat.isDirectory()) walk(path, key);
        else if (stat.isFile()) { const { bytes, sha256, size } = digestFile(path); const item = { key, size, sha256, mime: mimeFor(key, bytes) }; const duplicateOf = seenHash.get(sha256); if (duplicateOf !== undefined) item.duplicate_of = duplicateOf; else seenHash.set(sha256, key); output.push(item); }
        else throw refuse('Special image filesystem entries are refused.');
      }
    };
    if (requested) {
      for (const key of requested) { const found = regularPath(this.root, key, { allowMissing: true }); if (!found) output.push({ key, missing: true }); else { const { bytes, sha256, size } = digestFile(found.path); output.push({ key, size, sha256, mime: mimeFor(key, bytes) }); } }
    } else walk(this.root);
    return output.sort((a, b) => a.key.localeCompare(b.key));
  }
  async openRead(key) { const found = regularPath(this.root, key); return createReadStream(found.path); }
  async put(key, body, metadata = {}) {
    safeKey(key); assertNoSymlinkComponents(this.root, key); const destination = resolve(this.root, ...key.split('/')); const parent = dirname(destination); mkdirSync(parent, { recursive: true });
    const bytes = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer());
    const temp = `${destination}.tmp-${process.pid}`; writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp, destination);
    return { key, ...digestFile(destination), mime: metadata.mime ?? mimeFor(key, bytes) };
  }
  async verify(key, expected = {}) {
    const found = regularPath(this.root, key, { allowMissing: true }); if (!found) return { key, exists: false, verified: false };
    const actual = digestFile(found.path); const mime = mimeFor(key, actual.bytes); const verified = (!expected.sha256 || expected.sha256 === actual.sha256) && (expected.size === undefined || Number(expected.size) === actual.size) && (!expected.mime || expected.mime === mime);
    return { key, exists: true, verified, sha256: actual.sha256, size: actual.size, mime };
  }
}

export async function buildFilesystemInventory(root, options = {}) { return new FilesystemObjectStore(root).inventory(options); }
function targetEntries(plan) { return Array.isArray(plan?.entries) ? plan.entries : []; }
export async function copyImagePlan({ plan, sourceStore, targetStore, migrationId = plan?.migration_id, bundleManifestSha256 = plan?.bundle_manifest_sha256, compiledPolicySha256 = plan?.compiled_policy_sha256 } = {}) {
  assertObjectStore(sourceStore); assertObjectStore(targetStore); const entries = targetEntries(plan); const seen = new Map(); const receipts = [];
  for (const entry of entries) {
    const source = entry.source_logical_path ?? entry.source_key; const target = entry.target_key; if (typeof source !== 'string' || typeof target !== 'string') throw refuse('Image plan contains an incomplete object entry.');
    if (seen.has(target) && seen.get(target) !== entry.expected_sha256) throw refuse('Image plan contains duplicate target keys with different content.'); seen.set(target, entry.expected_sha256);
    const expected = { sha256: entry.expected_sha256 ?? undefined, size: entry.expected_size ?? undefined, mime: entry.expected_mime ?? undefined };
    const sourceMeta = (await sourceStore.inventory({ keys: [source] }))[0]; if (!sourceMeta || sourceMeta.missing) { receipts.push({ source_logical_path: source, target_key: target, status: 'missing', verified: false }); continue; }
    if (entry.expected_sha256 && sourceMeta.sha256 !== entry.expected_sha256 || entry.expected_size !== undefined && sourceMeta.size !== Number(entry.expected_size)) { receipts.push({ source_logical_path: source, target_key: target, status: 'changed', verified: false, actual_sha256: sourceMeta.sha256, actual_size: sourceMeta.size }); continue; }
    const current = await targetStore.verify(target, expected); if (!current.verified) { const stream = await sourceStore.openRead(source); const bytes = Buffer.from(await new Response(stream).arrayBuffer()); await targetStore.put(target, bytes, { mime: sourceMeta.mime }); }
    const verified = await targetStore.verify(target, expected); receipts.push({ source_logical_path: source, target_key: target, status: verified.verified ? 'complete' : 'changed', verified: verified.verified, sha256: verified.sha256, size: verified.size, mime: verified.mime });
  }
  const status = receipts.every((entry) => entry.verified) ? 'complete' : 'incomplete'; const base = { format_version: 1, receipt_type: 'image-copy', status, entries: receipts }; if (migrationId !== undefined) base.migration_id = migrationId; if (bundleManifestSha256 !== undefined) base.bundle_manifest_sha256 = bundleManifestSha256; if (compiledPolicySha256 !== undefined) base.compiled_policy_sha256 = compiledPolicySha256; const receipt = { ...base }; receipt.receipt_sha256 = canonicalSha256(receipt); if (status !== 'complete') throw refuse('One or more planned image objects are missing or changed.', { incomplete: receipts.filter((entry) => !entry.verified).length }); return receipt;
}
export { safeKey, mimeFor };
export const FilesystemStore = FilesystemObjectStore;
export const createFilesystemStore = (root) => new FilesystemObjectStore(root);