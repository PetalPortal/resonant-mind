import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { canonicalSha256, sha256Hex } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { FilesystemObjectStore, copyImagePlan } from '../../scripts/v32-to-v4/external/filesystem-store.mjs';
import { buildImageInventory, validateImageReceipt } from '../../scripts/v32-to-v4/external/images.mjs';
import { observeImageObjects } from '../../scripts/v32-to-v4/commands/validate.mjs';
import { generateDecisionManifest, decisionManifestHash } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { Findings } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { checkExternalEvidence } from '../../scripts/v32-to-v4/validate/external-evidence.mjs';
import { stateBasis } from '../../scripts/v32-to-v4/validate/reconcile.mjs';

// v3.2's images table stores a path and nothing about the object: no hash, no size, no MIME type. These tests
// use real directories of real bytes, and bundles whose image rows carry only what v3.2 carries.
const roots = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), 'rmig-image-fp-')); roots.push(root); return root; };

// magic bytes, then a payload: the content decides the type, never the name
const PNG = (tag) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`png ${tag}`)]);
const JPEG = (tag) => Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.from(`jpeg ${tag}`)]);
const GIF = (tag) => Buffer.concat([Buffer.from('GIF89a'), Buffer.from(`gif ${tag}`)]);
const WEBP = (tag) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(`webp ${tag}`)]);
const sha = (bytes) => sha256Hex(bytes);
const MIGRATION_ID = 'rmig_image_fp_test';

function put(root, key, bytes) {
  const path = join(root, ...key.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/** An image plan for rows that carry only a path, the way a v3.2 source does. */
const v32Plan = (paths) => buildImageInventory({ images: paths.map((path, index) => ({ id: index + 1, path })), migrationId: MIGRATION_ID, bundleManifestSha256: 'b'.repeat(64), compiledPolicySha256: 'c'.repeat(64) });

/** A refusal's reasons, by planned object. */
const reasonsOf = async (promise) => {
  try { await promise; } catch (error) { return { code: error.code, objects: error.safe_details.objects, failed: error.safe_details.failed, error }; }
  throw new Error('expected a refusal');
};

describe('copy-images fingerprints each source object itself', () => {
  it('records the SHA-256, size and content-detected MIME of what it copied, and the copy is those bytes', async () => {
    const source = tempRoot(); const target = tempRoot();
    // the names lie: a JPEG called .png, a GIF with no extension at all
    const files = { 'images/a.png': JPEG('a'), 'images/b.jpg': PNG('b'), 'images/c': GIF('c'), 'nested/deep/d.webp': WEBP('d'), 'images/e.png': PNG('e') };
    for (const [key, bytes] of Object.entries(files)) put(source, key, bytes);
    const plan = v32Plan(Object.keys(files));
    expect(plan.entries.every((entry) => entry.expected_sha256 === null && entry.expected_size === null && entry.expected_mime === null)).toBe(true);

    const receipt = await copyImagePlan({ plan, sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) });
    expect(receipt).toMatchObject({ status: 'complete', receipt_type: 'image-copy', plan_sha256: plan.plan_sha256, migration_id: MIGRATION_ID });
    expect(receipt.entries).toHaveLength(5);
    for (const entry of receipt.entries) {
      const bytes = files[entry.source_logical_path];
      const mime = { 'images/a.png': 'image/jpeg', 'images/b.jpg': 'image/png', 'images/c': 'image/gif', 'nested/deep/d.webp': 'image/webp', 'images/e.png': 'image/png' }[entry.source_logical_path];
      expect(entry.source_fingerprint).toEqual({ sha256: sha(bytes), size: bytes.byteLength, mime });
      expect(entry).toMatchObject({ sha256: sha(bytes), source_sha256: sha(bytes), size: bytes.byteLength, mime, verified: true, status: 'complete', source_table: 'images' });
      expect(readFileSync(join(target, ...entry.target_key.split('/')))).toEqual(bytes);
    }
    // the receipt is the plan's evidence: it covers every planned object and states the fingerprint of each
    const checked = validateImageReceipt({ plan, receipt, requireSignature: false });
    expect(Object.keys(checked.fingerprints)).toHaveLength(5);
    expect(Object.values(checked.fingerprints).every((fingerprint) => fingerprint.from_plan === false)).toBe(true);
    // the same copy again is the same copy: objects already there are verified, not rewritten or refused
    const again = await copyImagePlan({ plan, sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) });
    expect(again.receipt_sha256).toBe(receipt.receipt_sha256);
  });

  it('refuses a source whose bytes are not an image, whatever its name says, and writes nothing', async () => {
    const source = tempRoot(); const target = tempRoot();
    put(source, 'images/fine.png', PNG('fine'));
    put(source, 'images/fake.png', Buffer.from('this is a text file called .png'));
    const { code, objects, failed } = await reasonsOf(copyImagePlan({ plan: v32Plan(['images/fine.png', 'images/fake.png']), sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) }));
    expect(code).toBe('RMIG-E-IMAGE-INCOMPLETE');
    expect(failed).toBe(1);
    expect(objects).toEqual([{ target_key: expect.stringMatching(/^images\/2-/u), reason: 'not-a-recognised-image' }]);
    expect(existsSync(join(target, 'images'))).toBe(false);
  });

  it('refuses a missing source object, names it, and copies none of the others', async () => {
    const source = tempRoot(); const target = tempRoot();
    put(source, 'images/here.png', PNG('here'));
    const plan = v32Plan(['images/here.png', 'images/gone.png', 'images/also-gone.png']);
    const { objects, failed, error } = await reasonsOf(copyImagePlan({ plan, sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) }));
    expect(failed).toBe(2);
    expect(objects.map((item) => item.reason)).toEqual(['missing', 'missing']);
    expect(readdirSync(target)).toEqual([]);
    // a refusal says which objects, by their target keys, and no path, file name or directory
    const text = JSON.stringify(error.toJSON());
    expect(text).not.toContain('gone.png');
    expect(text).not.toContain(source);
    expect(error.summary).toContain('no receipt was written');
  });

  it('refuses a symlink that leaves the source root, on a directory and on a file, and an unsafe path', async () => {
    const source = tempRoot(); const outside = tempRoot(); const target = tempRoot();
    put(outside, 'secret.png', PNG('secret'));
    put(source, 'images/inside.png', PNG('inside'));
    symlinkSync(outside, join(source, 'linked-dir'), 'junction');
    const paths = ['images/inside.png', 'linked-dir/secret.png', '../outside.png'];
    let fileLink = false;
    try { symlinkSync(join(outside, 'secret.png'), join(source, 'images', 'escape.png'), 'file'); fileLink = true; } catch (error) { if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error; }
    if (fileLink) paths.push('images/escape.png');
    const { objects } = await reasonsOf(copyImagePlan({ plan: v32Plan(paths), sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) }));
    expect(objects.map((item) => item.reason)).toEqual(fileLink ? ['symlink', 'unsafe-path', 'symlink'] : ['symlink', 'unsafe-path']);
    expect(readdirSync(target)).toEqual([]);
    // and the bytes outside the root were never read into a receipt or the target
    expect(existsSync(join(target, 'images'))).toBe(false);
  });

  it('refuses a source object that is unreadable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // permission bits are not enforced there
    const source = tempRoot(); const target = tempRoot();
    const path = put(source, 'images/locked.png', PNG('locked'));
    chmodSync(path, 0o000);
    const { objects } = await reasonsOf(copyImagePlan({ plan: v32Plan(['images/locked.png']), sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) }));
    expect(objects).toEqual([{ target_key: expect.any(String), reason: 'unreadable' }]);
    chmodSync(path, 0o600);
  });

  // The store handed to the copy changes the file at a chosen moment: after the n-th time the copy has read it.
  class ChangingStore extends FilesystemObjectStore {
    constructor(root, { key, afterRead, change }) { super(root); this.watch = { key, afterRead, change, reads: 0 }; }
    async readVerified(key) {
      const result = await super.readVerified(key);
      if (key === this.watch.key) { this.watch.reads += 1; if (this.watch.reads === this.watch.afterRead) this.watch.change(); }
      return result;
    }
  }

  it('refuses a source that changed between the fingerprint and the copy, and one that changed during the copy', async () => {
    for (const [afterRead, reason] of [[1, 'source-changed-after-fingerprint'], [2, 'source-changed-during-copy']]) {
      const source = tempRoot(); const target = tempRoot();
      put(source, 'images/steady.png', PNG('steady'));
      const moving = put(source, 'images/moving.png', PNG('before'));
      const store = new ChangingStore(source, { key: 'images/moving.png', afterRead, change: () => writeFileSync(moving, PNG('after the fingerprint')) });
      const { objects, failed } = await reasonsOf(copyImagePlan({ plan: v32Plan(['images/steady.png', 'images/moving.png']), sourceStore: store, targetStore: new FilesystemObjectStore(target) }));
      expect(failed, reason).toBe(1);
      expect(objects, reason).toEqual([{ target_key: expect.stringMatching(/^images\/2-/u), reason }]);
      // changed before the copy wrote anything: nothing of it is in the target
      if (reason === 'source-changed-after-fingerprint') expect(readdirSync(join(target, 'images')).filter((name) => name.startsWith('2-'))).toEqual([]);
    }
  });

  it('refuses a copy that differs from the source, and a target that already holds another object under the key', async () => {
    const source = tempRoot(); const target = tempRoot();
    put(source, 'images/one.png', PNG('one'));
    const plan = v32Plan(['images/one.png']);
    class CorruptingStore extends FilesystemObjectStore {
      async put(key, body, metadata) { return super.put(key, Buffer.concat([Buffer.from(body), Buffer.from('!')]), metadata); }
    }
    const corrupted = await reasonsOf(copyImagePlan({ plan, sourceStore: new FilesystemObjectStore(source), targetStore: new CorruptingStore(target) }));
    expect(corrupted.objects.map((item) => item.reason)).toEqual(['copy-differs-from-source']);

    const other = tempRoot();
    put(other, plan.entries[0].target_key, PNG('somebody else'));
    const occupied = await reasonsOf(copyImagePlan({ plan, sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(other) }));
    expect(occupied.objects.map((item) => item.reason)).toEqual(['target-holds-a-different-object']);
    expect(readFileSync(join(other, ...plan.entries[0].target_key.split('/')))).toEqual(PNG('somebody else'));
  });

  it('holds the copy to any value the plan does state', async () => {
    const source = tempRoot(); const target = tempRoot();
    const bytes = PNG('pinned');
    put(source, 'images/pinned.png', bytes);
    const pinned = (change = {}) => buildImageInventory({ images: [{ id: 1, path: 'images/pinned.png', sha256: sha(bytes), size: bytes.byteLength, mime: 'image/png', ...change }], migrationId: MIGRATION_ID });
    const store = () => new FilesystemObjectStore(source);
    const ok = await copyImagePlan({ plan: pinned(), sourceStore: store(), targetStore: new FilesystemObjectStore(target) });
    expect(ok.entries[0].source_fingerprint).toEqual({ sha256: sha(bytes), size: bytes.byteLength, mime: 'image/png' });
    for (const change of [{ sha256: 'f'.repeat(64) }, { size: bytes.byteLength + 1 }, { mime: 'image/jpeg' }]) {
      const refused = await reasonsOf(copyImagePlan({ plan: pinned(change), sourceStore: store(), targetStore: new FilesystemObjectStore(tempRoot()) }));
      expect(refused.objects.map((item) => item.reason), JSON.stringify(change)).toEqual(['differs-from-plan']);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// validate: the same plan the importer worked from, with a copy made by the tool

const bundleFor = (images) => ({
  migration_id: MIGRATION_ID, bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [{ id: 9, name: 'Ada', entity_type: 'person', primary_context: 'default' }],
    observations: [{ id: 30, entity_id: 9, content: 'a thought about the garden', added_at: '2026-01-01T00:00:00Z' }],
    images,
  },
});
function relationalFor(images) {
  const bundle = bundleFor(images);
  const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  for (const item of manifest.items) item.choice = 'exclude-row';
  manifest.reviewed = true; manifest.reviewed_by = 'test-reviewer'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
  return transformRelational({ bundle, compiledPolicy: compilePolicy({ bundle, decisions: manifest }) });
}
// what a v3.2 source has: ids, paths and the links, and nothing about the objects
const V32_IMAGES = [
  { id: 6, path: 'objects/one.png', description: 'one', observation_id: 30, entity_id: 9 },
  { id: 7, path: 'objects/two.jpg', description: 'two', observation_id: 30, entity_id: 9 },
];
const FILES = { 'objects/one.png': PNG('one'), 'objects/two.jpg': JPEG('two') };

const targetFor = (relational) => Object.fromEntries(Object.entries(relational.members).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
function runEvidence({ relational, files, tables = targetFor(relational) }) {
  const findings = new Findings();
  const evidence = checkExternalEvidence({
    derived: { members: relational.members, imageInventory: relational.image_inventory, reembedPlan: relational.reembed_jobs },
    files: { embeddingModel: 'test-model', ...files }, migrationId: MIGRATION_ID, live: { tables, columnTypes: {}, columnDefaults: {}, embeddingDimension: 3, importedAt: null }, findings,
  });
  return { evidence, findings };
}

/** The operator's flow for a local copy: the objects on disk, the tool's copy, and the directory validate is pointed at. */
async function localCopy(relational, files = FILES) {
  const source = tempRoot(); const target = tempRoot();
  for (const [key, bytes] of Object.entries(files)) put(source, key, bytes);
  const receipt = await copyImagePlan({ plan: relational.image_inventory, sourceStore: new FilesystemObjectStore(source), targetStore: new FilesystemObjectStore(target) });
  return { source, target, receipt, imageObjects: () => observeImageObjects(target, relational.image_inventory) };
}
const resign = (receipt, mutate) => {
  const { receipt_sha256: _hash, signature: _signature, ...body } = receipt;
  const changed = mutate(structuredClone(body));
  return { ...changed, receipt_sha256: canonicalSha256(changed) };
};

describe('validate holds the copied objects to the fingerprint the copy recorded', () => {
  const relational = relationalFor(V32_IMAGES);
  const imagePlan = relational.image_inventory;

  it('has no hash, size or MIME type in the plan for a v3.2 source', () => {
    expect(imagePlan.entries).toHaveLength(2);
    for (const entry of imagePlan.entries) expect(entry).toMatchObject({ expected_sha256: null, expected_size: null, expected_mime: null });
  });

  it('completes a v3.2 migration with local images: the tool re-hashes the objects and says what it held them to', async () => {
    const copy = await localCopy(relational);
    const { evidence, findings } = runEvidence({ relational, files: { imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects() } });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, basis: 'tool-rehashed-objects', objects_rehashed_by_tool: true, signature_required: false, receipt_signature_verified: false, expected_values: { from_plan: 0, from_receipt_fingerprint: 2 } });
    // and the state says it rests on the copy-time fingerprint, not on the original source
    expect(stateBasis({ relational_reconciliation_complete: true, dry_run_receipt_complete: true, import_receipt_complete: true, images_complete: true, reembed_complete: true, images: evidence.images, reembed: { basis: 'receipts-attested' } })).toMatchObject({ images: 'tool-rehashed-objects', images_fingerprint: 'copy-time-receipt' });
  });

  it('finds an object changed in the target after it was copied: different bytes, a different type, removed, or swapped for the other', async () => {
    const copy = await localCopy(relational);
    const [first, second] = imagePlan.entries;
    const path = (entry) => join(copy.target, ...entry.target_key.split('/'));
    const original = readFileSync(path(first));
    const outcome = () => runEvidence({ relational, files: { imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects() } });

    writeFileSync(path(first), Buffer.concat([original, Buffer.from('x')]));
    let result = outcome();
    expect(result.findings.counts).toEqual({ 'image-object-differs-from-copy-fingerprint': 1 });
    expect(result.evidence.images).toMatchObject({ complete: false, basis: 'not-complete' });

    // same size, another image
    writeFileSync(path(first), Buffer.concat([Buffer.from([255, 216, 255, 224]), original.subarray(4)]));
    result = outcome();
    expect(result.findings.counts).toEqual({ 'image-object-differs-from-copy-fingerprint': 1 });

    writeFileSync(path(first), original);
    expect(outcome().findings.counts).toEqual({});

    // the other row's object under this row's key
    writeFileSync(path(first), readFileSync(path(second)));
    expect(outcome().findings.counts).toEqual({ 'image-object-differs-from-copy-fingerprint': 1 });
    writeFileSync(path(first), original);

    rmSync(path(second));
    result = outcome();
    expect(result.findings.counts).toEqual({ 'image-object-missing-in-target-dir': 1 });
    expect(result.evidence.images.complete).toBe(false);
  });

  it('is not complete when the receipt states no fingerprint for an object, however the objects look', async () => {
    const copy = await localCopy(relational);
    const objects = copy.imageObjects();
    for (const field of ['sha256', 'size', 'mime']) {
      const stripped = resign(copy.receipt, (body) => { delete body.entries[0][field]; return body; });
      const { evidence, findings } = runEvidence({ relational, files: { imagePlan, imageReceipt: stripped, imageObjects: objects } });
      expect(evidence.images.complete, field).toBe(false);
      expect(findings.counts['external-image-receipt-invalid'], field).toBe(1);
      expect(findings.samples[0].reasons, field).toBe('fingerprint-missing-or-malformed');
    }
    const nulled = resign(copy.receipt, (body) => { body.entries[1].sha256 = null; return body; });
    expect(runEvidence({ relational, files: { imagePlan, imageReceipt: nulled, imageObjects: objects } }).evidence.images.complete).toBe(false);
    const notAnImage = resign(copy.receipt, (body) => { body.entries[0].mime = 'application/octet-stream'; body.entries[0].source_fingerprint.mime = 'application/octet-stream'; return body; });
    expect(runEvidence({ relational, files: { imagePlan, imageReceipt: notAnImage, imageObjects: objects } }).findings.samples[0].reasons).toBe('fingerprint-missing-or-malformed');
  });

  it('is not complete when a receipt entry does not belong to its row, or disagrees with itself', async () => {
    const copy = await localCopy(relational);
    const objects = copy.imageObjects();
    const reasons = (receipt) => { const { findings, evidence } = runEvidence({ relational, files: { imagePlan, imageReceipt: receipt, imageObjects: objects } }); expect(evidence.images.complete).toBe(false); return findings.samples.find((sample) => sample.check === 'external-image-receipt-invalid')?.reasons; };
    // an entry claiming another row's id
    expect(reasons(resign(copy.receipt, (body) => { body.entries[0].image_id = body.entries[1].image_id; return body; }))).toBe('bound-to-another-row');
    // two entries with their keys swapped: each is no longer the planned object for its key
    expect(reasons(resign(copy.receipt, (body) => { const [a, b] = [body.entries[0].target_key, body.entries[1].target_key]; body.entries[0].target_key = b; body.entries[1].target_key = a; return body; }))).toBe('not-bound-to-the-planned-object');
    // an entry for a key the plan does not list, in place of a planned one
    expect(reasons(resign(copy.receipt, (body) => { body.entries[0].target_key = 'images/999-0000000000000000'; return body; }))).toMatch(/entry-for-an-unplanned-object|no-receipt-entry/u);
    // a source fingerprint that is not the copy's, and a source hash that is not the copy's
    expect(reasons(resign(copy.receipt, (body) => { body.entries[0].source_fingerprint.size += 1; return body; }))).toBe('source-fingerprint-differs-from-the-copy');
    expect(reasons(resign(copy.receipt, (body) => { body.entries[0].source_sha256 = 'a'.repeat(64); return body; }))).toBe('source-hash-differs-from-the-copy');
    // an entry short
    const short = resign(copy.receipt, (body) => { body.entries.pop(); return body; });
    expect(runEvidence({ relational, files: { imagePlan, imageReceipt: short, imageObjects: objects } }).evidence.images.complete).toBe(false);
  });

  it('does not accept a receipt for objects the copy tool never saw: unsigned and without a directory to re-hash', async () => {
    const copy = await localCopy(relational);
    const { evidence, findings } = runEvidence({ relational, files: { imagePlan, imageReceipt: copy.receipt } });
    expect(evidence.images.complete).toBe(false);
    expect(findings.samples[0]).toMatchObject({ signature_required: true });
  });
});

describe('an operator-signed receipt for objects the tool cannot read (R2)', () => {
  const relational = relationalFor(V32_IMAGES);
  const imagePlan = relational.image_inventory;
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });

  /** What an operator who looked at the objects in the bucket writes: per object, the SHA-256, size and MIME type they observed. */
  const operatorEntry = (entry, bytes) => ({ target_key: entry.target_key, source_logical_path: entry.source_logical_path, target_locator: entry.target_locator, verified: true, sha256: sha(bytes), source_sha256: sha(bytes), size: bytes.byteLength, mime: bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg' : 'image/png' });
  const body = (mutate = (value) => value) => mutate({
    format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: MIGRATION_ID, plan_sha256: imagePlan.plan_sha256, bundle_manifest_sha256: imagePlan.bundle_manifest_sha256, compiled_policy_sha256: imagePlan.compiled_policy_sha256,
    entries: imagePlan.entries.map((entry) => operatorEntry(entry, FILES[entry.source_logical_path])),
  });
  const signed = (value, privateKey = keys.privateKey) => ({ ...value, signature: { algorithm: 'ed25519', key_id: 'operator-key', value: sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64') } });
  const run = (receipt, extra = {}) => runEvidence({ relational, files: { imagePlan, imageReceipt: receipt, trustedPublicKey: publicKey, ...extra } });

  it('completes with a signature when every object carries the fingerprint the operator observed, and calls it attested', () => {
    const { evidence, findings } = run(signed(body()));
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, basis: 'signed-receipt-attested', objects_rehashed_by_tool: false, receipt_signature_verified: true, signature_required: true, expected_values: { from_plan: 0, from_receipt_fingerprint: 2 } });
    expect(stateBasis({ relational_reconciliation_complete: true, dry_run_receipt_complete: true, import_receipt_complete: true, images_complete: true, reembed_complete: true, images: evidence.images, reembed: { basis: 'receipts-attested' } })).toMatchObject({ images: 'signed-receipt-attested', images_fingerprint: 'copy-time-receipt' });
  });

  it('does not complete a signed receipt whose entries carry no fingerprint', () => {
    for (const field of ['sha256', 'size', 'mime']) {
      const { evidence, findings } = run(signed(body((value) => { delete value.entries[1][field]; return value; })));
      expect(evidence.images.complete, field).toBe(false);
      expect(findings.samples[0].reasons, field).toBe('fingerprint-missing-or-malformed');
    }
    // a receipt that lists the objects and says they were verified, and nothing else
    const bare = body((value) => ({ ...value, entries: value.entries.map(({ target_key, source_logical_path, target_locator }) => ({ target_key, source_logical_path, target_locator, verified: true })) }));
    expect(run(signed(bare)).evidence.images.complete).toBe(false);
  });

  it('does not complete an unsigned receipt, a receipt signed by another key, or one edited after signing, fingerprints or not', () => {
    expect(run(body()).evidence.images.complete).toBe(false);
    expect(run(signed(body(), generateKeyPairSync('ed25519').privateKey)).evidence.images.complete).toBe(false);
    const good = signed(body());
    const edited = { ...good, entries: good.entries.map((entry, index) => (index === 0 ? { ...entry, size: entry.size + 1 } : entry)) };
    expect(run(edited).evidence.images.complete).toBe(false);
  });

  it('does not complete when the signed receipt does not cover every planned row exactly once', () => {
    expect(run(signed(body((value) => { value.entries.pop(); return value; }))).evidence.images.complete).toBe(false);
    expect(run(signed(body((value) => { value.entries.push({ ...value.entries[0] }); return value; }))).evidence.images.complete).toBe(false);
    expect(run(signed(body((value) => { value.entries[0].image_id = 7; return value; }))).findings.samples[0].reasons).toBe('bound-to-another-row');
  });

  it('is not made complete by objects the tool re-hashed when a trusted key is configured, and still needs the signature', async () => {
    const copy = await localCopy(relational);
    const { evidence } = run(copy.receipt, { imageObjects: copy.imageObjects() });
    expect(evidence.images).toMatchObject({ complete: false, signature_required: true });
  });
});

describe('where the plan itself states the values (a source that stores them)', () => {
  const pinnedImages = Object.entries(FILES).map(([path, bytes], index) => ({ id: 6 + index, path, description: path, observation_id: 30, entity_id: 9, sha256: sha(bytes), size: bytes.byteLength, mime: path.endsWith('jpg') ? 'image/jpeg' : 'image/png' }));
  const relational = relationalFor(pinnedImages);
  const imagePlan = relational.image_inventory;

  it('still has to match: the copy and the re-hash agree with the plan, and the plan is what the state rests on', async () => {
    expect(imagePlan.entries.every((entry) => entry.expected_sha256 !== null)).toBe(true);
    const copy = await localCopy(relational);
    const { evidence, findings } = runEvidence({ relational, files: { imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects() } });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, basis: 'tool-rehashed-objects', expected_values: { from_plan: 2, from_receipt_fingerprint: 0 } });
    expect(stateBasis({ images_complete: true, images: evidence.images })).toMatchObject({ images_fingerprint: 'plan' });
  });

  it('refuses a source object that is not the one the plan states, and an object in the target that is not', async () => {
    const wrong = { ...FILES, 'objects/one.png': PNG('replaced in the source') };
    await expect(localCopy(relational, wrong)).rejects.toMatchObject({ code: 'RMIG-E-IMAGE-INCOMPLETE', safe_details: { objects: [{ reason: 'differs-from-plan' }] } });
    const copy = await localCopy(relational);
    const entry = imagePlan.entries[0];
    writeFileSync(join(copy.target, ...entry.target_key.split('/')), PNG('replaced in the target'));
    const { findings, evidence } = runEvidence({ relational, files: { imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects() } });
    expect(findings.counts).toEqual({ 'image-object-differs-from-plan': 1 });
    expect(evidence.images.complete).toBe(false);
  });

  it('refuses a receipt that fingerprints an object differently from the plan, even when it is internally consistent', async () => {
    const copy = await localCopy(relational);
    const other = PNG('some other picture');
    const forged = resign(copy.receipt, (value) => { Object.assign(value.entries[0], { sha256: sha(other), source_sha256: sha(other), size: other.byteLength, source_fingerprint: { sha256: sha(other), size: other.byteLength, mime: value.entries[0].mime } }); return value; });
    const { evidence, findings } = runEvidence({ relational, files: { imagePlan, imageReceipt: forged, imageObjects: copy.imageObjects() } });
    expect(evidence.images.complete).toBe(false);
    expect(findings.samples.find((sample) => sample.check === 'external-image-receipt-invalid').reasons).toBe('differs-from-the-plan');
  });

  it('mixes: an object the plan pins and one only the receipt pins', async () => {
    const mixed = relationalFor([pinnedImages[0], { ...V32_IMAGES[1] }]);
    const copy = await localCopy(mixed);
    const { evidence, findings } = runEvidence({ relational: mixed, files: { imagePlan: mixed.image_inventory, imageReceipt: copy.receipt, imageObjects: copy.imageObjects() } });
    expect(findings.counts).toEqual({});
    expect(evidence.images.expected_values).toEqual({ from_plan: 1, from_receipt_fingerprint: 1 });
    expect(stateBasis({ images_complete: true, images: evidence.images }).images_fingerprint).toBe('plan-and-copy-time-receipt');
  });
});

// A v3.2 re-embedding job cannot name the object it embeds either: the receipt has to, and it has to be the object that was copied.
describe('the re-embedding of an image is held to the object that was copied', () => {
  const relational = relationalFor(V32_IMAGES);
  const imagePlan = relational.image_inventory;
  const receiptsFor = (copy, change = {}) => JSON.parse(JSON.stringify({
    format_version: 1, migration_id: MIGRATION_ID, plan_sha256: relational.reembed_jobs.plan_sha256, bundle_manifest_sha256: relational.reembed_jobs.bundle_manifest_sha256, compiled_policy_sha256: relational.reembed_jobs.compiled_policy_sha256,
    receipts: relational.reembed_jobs.jobs.map((job) => {
      const base = { job_id: job.job_id, migration_id: MIGRATION_ID, plan_sha256: relational.reembed_jobs.plan_sha256, bundle_manifest_sha256: relational.reembed_jobs.bundle_manifest_sha256, compiled_policy_sha256: relational.reembed_jobs.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'test-model', dimension: 3, content_hash: job.content_hash };
      if (job.modality !== 'image') return base;
      const copied = copy.receipt.entries.find((entry) => entry.target_key === job.target_key);
      return { ...base, source_logical_path: job.source_logical_path, target_key: job.target_key, object_sha256: copied.sha256, source_sha256: copied.sha256, object_size: copied.size, object_mime: copied.mime, ...change };
    }),
  }));

  it('plans image jobs that state no object, and completes when the receipts name exactly the copied objects', async () => {
    const jobs = relational.reembed_jobs.jobs.filter((job) => job.modality === 'image');
    expect(jobs).toHaveLength(2);
    for (const job of jobs) expect(job).toMatchObject({ object_sha256: null, object_size: null, object_mime: null });
    const copy = await localCopy(relational);
    const files = { imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects(), reembedPlan: relational.reembed_jobs, reembedReceipts: receiptsFor(copy) };
    const { evidence, findings } = runEvidence({ relational, files });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, basis: 'tool-rehashed-objects' });
    expect(evidence.reembed).toMatchObject({ complete: true, basis: 'receipts-attested', observed_by_tool: false });
  });

  it.each([
    ['another object', (copy) => ({ object_sha256: 'e'.repeat(64), source_sha256: 'e'.repeat(64) })],
    ['another size', (copy) => ({ object_size: 1 })],
    ['another type', () => ({ object_mime: 'image/gif' })],
    ['a source hash that is not the object hash', () => ({ source_sha256: 'd'.repeat(64) })],
    ['no object at all', () => ({ object_sha256: undefined, source_sha256: undefined, object_size: undefined, object_mime: undefined })],
  ])('refuses image receipts that name %s', async (_label, change) => {
    const copy = await localCopy(relational);
    const files = { imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects(), reembedPlan: relational.reembed_jobs, reembedReceipts: receiptsFor(copy, change(copy)) };
    const { evidence, findings } = runEvidence({ relational, files });
    expect(findings.counts).toEqual({ 'external-reembed-receipt-invalid': 1 });
    expect(findings.samples[0].reasons).toBe('object-binding-mismatch');
    expect(evidence.reembed.complete).toBe(false);
    expect(evidence.images.complete).toBe(true);
  });

  it('cannot verify an image job without the evidence of the copy it embeds, and says so', async () => {
    const copy = await localCopy(relational);
    const reembed = { reembedPlan: relational.reembed_jobs, reembedReceipts: receiptsFor(copy) };
    const noImageEvidence = runEvidence({ relational, files: reembed });
    expect(noImageEvidence.findings.samples[0].reasons).toBe('object-binding-unverifiable');
    expect(noImageEvidence.evidence.reembed.complete).toBe(false);
    // and an image copy that did not hold up is no better
    writeFileSync(join(copy.target, ...imagePlan.entries[0].target_key.split('/')), PNG('damaged'));
    const damaged = runEvidence({ relational, files: { ...reembed, imagePlan, imageReceipt: copy.receipt, imageObjects: copy.imageObjects() } });
    expect(damaged.evidence.images.complete).toBe(false);
    expect(damaged.findings.samples.find((sample) => sample.check === 'external-reembed-receipt-invalid').reasons).toBe('object-binding-unverifiable');
  });
});
