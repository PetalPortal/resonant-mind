import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { canonicalSha256 } from '../../scripts/v32-to-v4/lib/hash.mjs';
import { buildImageInventory } from '../../scripts/v32-to-v4/external/images.mjs';
import { generateDecisionManifest, decisionManifestHash } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { Findings } from '../../scripts/v32-to-v4/validate/compare.mjs';
import { checkExternalEvidence } from '../../scripts/v32-to-v4/validate/external-evidence.mjs';
import { determineMigrationStatus } from '../../scripts/v32-to-v4/validate/reconcile.mjs';

// The evidence check, with no database: the bundle, the decisions and the plan are real, the target is a set of rows.
const MIGRATION_ID = 'rmig_evidence_test';
const bundle = {
  migration_id: MIGRATION_ID, bundle_manifest_sha256: 'b'.repeat(64),
  tables: {
    entities: [{ id: 9, name: 'Ada', entity_type: 'person', primary_context: 'default' }],
    observations: [{ id: 30, entity_id: 9, content: 'a thought about the garden', added_at: '2026-01-01T00:00:00Z' }],
    images: [
      { id: 6, path: 'objects/one.png', description: 'one', observation_id: 30, entity_id: 9, size: 3, sha256: 'c'.repeat(64), mime: 'image/png' },
      { id: 7, path: 'objects/two.png', description: 'two', observation_id: 30, entity_id: 9, size: 4, sha256: 'd'.repeat(64), mime: 'image/png' },
    ],
  },
};

function plan() {
  const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
  for (const item of manifest.items) item.choice = 'exclude-row';
  manifest.reviewed = true; manifest.reviewed_by = 'test-reviewer'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
  const compiled = compilePolicy({ bundle, decisions: manifest });
  return transformRelational({ bundle, compiledPolicy: compiled });
}

function imageReceipt(imagePlan, overrides = {}) {
  const body = {
    format_version: 1, receipt_type: 'image-copy', status: 'complete', migration_id: imagePlan.migration_id, plan_sha256: imagePlan.plan_sha256,
    ...(imagePlan.bundle_manifest_sha256 === undefined ? {} : { bundle_manifest_sha256: imagePlan.bundle_manifest_sha256 }),
    ...(imagePlan.compiled_policy_sha256 === undefined ? {} : { compiled_policy_sha256: imagePlan.compiled_policy_sha256 }),
    entries: imagePlan.entries.map((entry) => ({ target_key: entry.target_key, source_logical_path: entry.source_logical_path, target_locator: entry.target_locator, verified: true, sha256: entry.expected_sha256, source_sha256: entry.expected_sha256, size: entry.expected_size, mime: entry.expected_mime })),
    ...overrides,
  };
  return { ...body, receipt_sha256: canonicalSha256(body) };
}

function reembedReceipts(reembedPlan, { drop = 0 } = {}) {
  return {
    format_version: 1, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256,
    receipts: reembedPlan.jobs.slice(drop).map((job) => ({ job_id: job.job_id, migration_id: reembedPlan.migration_id, plan_sha256: reembedPlan.plan_sha256, bundle_manifest_sha256: reembedPlan.bundle_manifest_sha256, compiled_policy_sha256: reembedPlan.compiled_policy_sha256, target_locator: job.target_locator, status: 'complete', model: 'test-model', dimension: 3, content_hash: job.content_hash, ...(job.modality === 'image' ? { source_logical_path: job.source_logical_path, target_key: job.target_key, object_sha256: job.object_sha256, source_sha256: job.object_sha256, object_size: job.object_size, object_mime: job.object_mime } : {}) })),
  };
}

/** The target as the importer left it: every planned row, the images table holding the planned image rows. */
function targetFor(relational) {
  const tables = {};
  for (const [table, rows] of Object.entries(relational.members)) tables[table] = rows.map((row) => ({ ...row }));
  return tables;
}

// what the tool itself would read from the directory the operator copied the images to
const observedObjects = (imagePlan, change = {}) => ({ observed: Object.fromEntries(imagePlan.entries.map((entry) => [entry.target_key, change[entry.target_key] ?? { sha256: entry.expected_sha256, size: entry.expected_size, mime: entry.expected_mime }])) });
const EMBEDDING_MODEL = 'test-model';
const EMBEDDING_DIMENSION = 3;
// with the evidence the operator would supply: the tool looked at the objects, and states the embedding model
const defaults = (relational) => ({ imageObjects: observedObjects(relational.image_inventory), embeddingModel: EMBEDDING_MODEL });

const run = ({ relational, files, tables = targetFor(relational), columnTypes = {}, columnDefaults = {}, embeddingDimension = EMBEDDING_DIMENSION }) => {
  const findings = new Findings();
  const evidence = checkExternalEvidence({
    derived: { members: relational.members, imageInventory: relational.image_inventory, reembedPlan: relational.reembed_jobs },
    files: { ...defaults(relational), ...files }, migrationId: MIGRATION_ID, live: { tables, columnTypes, columnDefaults, embeddingDimension, importedAt: null }, findings,
  });
  return { evidence, findings };
};

describe('external evidence is held to the plan validate derives, not to the plan it is handed', () => {
  const relational = plan();

  it('accepts the planned inventory with a matching receipt, and the planned re-embedding jobs with receipts for unchanged rows', () => {
    expect(relational.image_inventory.entries).toHaveLength(2);
    const { evidence, findings } = run({ relational, files: { imagePlan: relational.image_inventory, imageReceipt: imageReceipt(relational.image_inventory), reembedPlan: relational.reembed_jobs, reembedReceipts: reembedReceipts(relational.reembed_jobs) } });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, evidence_supplied: true, planned: 2 });
    expect(evidence.reembed).toMatchObject({ complete: true, evidence_supplied: true });
  });

  it.each([
    ['a smaller image plan', (inventory) => buildImageInventory({ images: [bundle.tables.images[0]], migrationId: MIGRATION_ID, bundleManifestSha256: inventory.bundle_manifest_sha256, compiledPolicySha256: inventory.compiled_policy_sha256 })],
    ['an empty image plan', (inventory) => buildImageInventory({ images: [], migrationId: MIGRATION_ID, bundleManifestSha256: inventory.bundle_manifest_sha256, compiledPolicySha256: inventory.compiled_policy_sha256 })],
    ['a different image plan', (inventory) => buildImageInventory({ images: [{ ...bundle.tables.images[0], id: 60, path: 'objects/elsewhere.png' }, { ...bundle.tables.images[1], id: 70, path: 'objects/other.png' }], migrationId: MIGRATION_ID, bundleManifestSha256: inventory.bundle_manifest_sha256, compiledPolicySha256: inventory.compiled_policy_sha256 })],
  ])('refuses %s even when its receipt matches it exactly', (_label, build) => {
    const supplied = build(relational.image_inventory);
    const { evidence, findings } = run({ relational, files: { imagePlan: supplied, imageReceipt: imageReceipt(supplied) } });
    expect(findings.counts['external-image-plan-not-the-planned-inventory']).toBe(1);
    expect(evidence.images.complete).toBe(false);
    // and the report that follows can never reach a ready state
    const report = { relational_reconciliation_complete: true, dry_run_receipt_complete: true, import_receipt_complete: true, target_present: true, imported: true, images_complete: evidence.images.complete, reembed_complete: true };
    expect(determineMigrationStatus(report, { requireReportHash: false })).toBe('data-imported-images-pending');
  });

  it('finds an image row the plan does not list, and a listed image with no row', () => {
    const extra = targetFor(relational);
    extra.images.push({ id: 999 });
    const surplus = run({ relational, files: { imagePlan: relational.image_inventory, imageReceipt: imageReceipt(relational.image_inventory) }, tables: extra });
    expect(surplus.findings.counts['image-row-not-in-image-plan']).toBe(1);
    expect(surplus.evidence.images.complete).toBe(false);
    const fewer = targetFor(relational);
    fewer.images.pop();
    const missing = run({ relational, files: { imagePlan: relational.image_inventory, imageReceipt: imageReceipt(relational.image_inventory) }, tables: fewer });
    expect(missing.findings.counts['image-plan-entry-without-row']).toBe(1);
    expect(missing.evidence.images.complete).toBe(false);
  });

  it('needs the plan and the receipt together', () => {
    const { evidence, findings } = run({ relational, files: { imagePlan: relational.image_inventory } });
    expect(findings.counts['external-image-evidence-incomplete']).toBe(1);
    expect(evidence.images.complete).toBe(false);
  });

  it('checks the re-embedding receipts against the content the target holds now', () => {
    const files = { reembedPlan: relational.reembed_jobs, reembedReceipts: reembedReceipts(relational.reembed_jobs) };
    const changed = targetFor(relational);
    changed.observations[0] = { ...changed.observations[0], content: 'changed after the receipts were issued' };
    const edited = run({ relational, files, tables: changed });
    expect(edited.findings.counts['external-reembed-receipt-invalid']).toBe(1);
    expect(edited.findings.samples[0].reasons).toContain('target-content-changed');
    expect(edited.evidence.reembed.complete).toBe(false);

    const gone = targetFor(relational);
    gone.observations = [];
    const missing = run({ relational, files, tables: gone });
    expect(missing.findings.samples[0].reasons).toContain('target-row-missing');
  });

  it('refuses a re-embedding plan that is not the one these imported rows produce', () => {
    const foreign = { ...relational.reembed_jobs, jobs: relational.reembed_jobs.jobs.slice(1) };
    delete foreign.plan_sha256;
    foreign.plan_sha256 = canonicalSha256(foreign);
    const { findings, evidence } = run({ relational, files: { reembedPlan: foreign, reembedReceipts: reembedReceipts(foreign) } });
    expect(findings.counts['reembed-plan-not-derived-from-imported-rows']).toBe(1);
    expect(evidence.reembed.complete).toBe(false);
  });
});

// Who decides that a signature is needed: the operator's invocation, never a field of the receipt.
describe('an image receipt is signed unless the tool re-hashed the objects itself', () => {
  const relational = plan();
  const imagePlan = relational.image_inventory;
  const withoutObjects = { imageObjects: undefined };

  function signedImageReceipt(inventory, extra = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { receipt_sha256: _hash, ...body } = imageReceipt(inventory, extra);
    const value = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString('base64');
    return { receipt: { ...body, signature: { algorithm: 'ed25519', key_id: 'test-key', value } }, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) };
  }
  const outcome = (files) => run({ relational, files: { imagePlan, ...files } });

  it('does not let an unsigned receipt complete the images where a signature is required, whatever the receipt says about itself', () => {
    for (const handoff of [undefined, false, true]) {
      const unsigned = imageReceipt(imagePlan, handoff === undefined ? {} : { external_handoff: handoff });
      const { evidence, findings } = outcome({ ...withoutObjects, imageReceipt: unsigned });
      expect(evidence.images.complete, `external_handoff=${handoff}`).toBe(false);
      expect(findings.counts['external-image-receipt-invalid'], `external_handoff=${handoff}`).toBe(1);
      expect(findings.samples[0]).toMatchObject({ signature_required: true, trusted_key_configured: false });
      expect(evidence.images.signature_required).toBe(true);
    }
  });

  it('still requires the signature when a trusted key is configured, even for objects the tool re-hashed', () => {
    const { publicKey } = signedImageReceipt(imagePlan);
    const { evidence, findings } = outcome({ imageReceipt: imageReceipt(imagePlan), trustedPublicKey: publicKey });
    expect(evidence.images.complete).toBe(false);
    expect(findings.counts['external-image-receipt-invalid']).toBe(1);
    expect(evidence.images.signature_required).toBe(true);
  });

  it('completes unsigned only where the tool re-read every object, and says so', () => {
    const { evidence, findings } = outcome({ imageReceipt: imageReceipt(imagePlan) });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, basis: 'tool-rehashed-objects', objects_rehashed_by_tool: true, receipt_signature_verified: false, signature_required: false });
  });

  it('completes with a valid signature on a key the operator trusts, and calls that attested, not verified', () => {
    const { receipt, publicKey } = signedImageReceipt(imagePlan);
    const { evidence, findings } = outcome({ ...withoutObjects, imageReceipt: receipt, trustedPublicKey: publicKey });
    expect(findings.counts).toEqual({});
    expect(evidence.images).toMatchObject({ complete: true, basis: 'signed-receipt-attested', objects_rehashed_by_tool: false, receipt_signature_verified: true, signature_required: true });
    // a signature from another key, or over a changed body, is not a signature
    const other = signedImageReceipt(imagePlan);
    expect(outcome({ ...withoutObjects, imageReceipt: receipt, trustedPublicKey: other.publicKey }).evidence.images.complete).toBe(false);
    expect(outcome({ ...withoutObjects, imageReceipt: { ...receipt, entries: receipt.entries.slice(1) }, trustedPublicKey: publicKey }).evidence.images.complete).toBe(false);
  });

  it('refuses an object the tool finds missing or different, however good the receipt is', () => {
    const [first, second] = imagePlan.entries;
    const different = outcome({ imageReceipt: imageReceipt(imagePlan), imageObjects: observedObjects(imagePlan, { [first.target_key]: { sha256: 'e'.repeat(64), size: first.expected_size, mime: first.expected_mime } }) });
    expect(different.findings.counts['image-object-differs-from-plan']).toBe(1);
    expect(different.evidence.images).toMatchObject({ complete: false, basis: 'not-complete' });
    const missing = outcome({ imageReceipt: imageReceipt(imagePlan), imageObjects: observedObjects(imagePlan, { [second.target_key]: { missing: true } }) });
    expect(missing.findings.counts['image-object-missing-in-target-dir']).toBe(1);
    expect(missing.evidence.images.complete).toBe(false);
  });

  it('the receipt check itself defaults to requiring a signature', async () => {
    const { validateImageReceipt, imageSignatureRequired } = await import('../../scripts/v32-to-v4/external/images.mjs');
    expect(() => validateImageReceipt({ plan: imagePlan, receipt: imageReceipt(imagePlan) })).toThrow(/Ed25519|signature/u);
    expect(() => validateImageReceipt({ plan: imagePlan, receipt: imageReceipt(imagePlan, { external_handoff: false }) })).toThrow(/Ed25519|signature/u);
    expect(validateImageReceipt({ plan: imagePlan, receipt: imageReceipt(imagePlan), requireSignature: false })).toMatchObject({ complete: true, signature_verified: false });
    expect(imageSignatureRequired({})).toBe(true);
    expect(imageSignatureRequired({ toolObservedObjects: true })).toBe(false);
    expect(imageSignatureRequired({ toolObservedObjects: true, trustedPublicKey: 'a key' })).toBe(true);
    expect(imageSignatureRequired({ toolObservedObjects: false, trustedPublicKey: 'a key' })).toBe(true);
  });
});

// Re-embedding happens outside the tool: its receipts are held to the configuration, and named for what they are.
describe('re-embedding receipts are held to the v4 target model and dimension, and are only ever attested', () => {
  const relational = plan();
  const files = () => ({ reembedPlan: relational.reembed_jobs, reembedReceipts: reembedReceipts(relational.reembed_jobs) });

  it('accepts receipts that match the stated model and the dimension of the target, as attested and not observed', () => {
    const { evidence, findings } = run({ relational, files: files() });
    expect(findings.counts).toEqual({});
    expect(evidence.reembed).toMatchObject({ complete: true, basis: 'receipts-attested', observed_by_tool: false, held_to_model: EMBEDDING_MODEL, held_to_dimension: EMBEDDING_DIMENSION });
  });

  it('refuses receipts for another model than the one the operator states', () => {
    const { evidence, findings } = run({ relational, files: { ...files(), embeddingModel: 'another-model' } });
    expect(findings.counts['external-reembed-receipt-invalid']).toBe(1);
    expect(findings.samples[0].reasons).toContain('model-mismatch');
    expect(evidence.reembed).toMatchObject({ complete: false, basis: 'not-complete' });
  });

  it('refuses receipts for another dimension than the one the embeddings column of the target has', () => {
    const { evidence, findings } = run({ relational, files: files(), embeddingDimension: 768 });
    expect(findings.counts['external-reembed-receipt-invalid']).toBe(1);
    expect(findings.samples[0].reasons).toContain('dimension-mismatch');
    expect(evidence.reembed.complete).toBe(false);
  });

  it('is not complete while the model is not stated or the dimension of the target is unknown', () => {
    const unstated = run({ relational, files: { ...files(), embeddingModel: undefined } });
    expect(unstated.findings.counts['external-reembed-model-not-stated']).toBe(1);
    expect(unstated.evidence.reembed).toMatchObject({ complete: false, basis: 'not-complete' });
    const unknown = run({ relational, files: files(), embeddingDimension: null });
    expect(unknown.findings.counts['target-embedding-dimension-unknown']).toBe(1);
    expect(unknown.evidence.reembed.complete).toBe(false);
  });

  it('is only as good as the receipts agree with each other: one receipt for another model fails', () => {
    const mixed = files();
    mixed.reembedReceipts.receipts[0] = { ...mixed.reembedReceipts.receipts[0], model: 'other-model' };
    const { findings } = run({ relational, files: mixed });
    expect(findings.samples[0].reasons).toMatch(/model-/u);
  });
});

// A plan row need not state every v4 column; a value in a column it did not state must still be the database's own.
describe('the full target row is compared, not only the columns the plan states', () => {
  const relational = plan();
  const files = () => ({ reembedPlan: relational.reembed_jobs, reembedReceipts: reembedReceipts(relational.reembed_jobs) });

  it('treats an extra non-default value in a text row as a change to the content that was embedded', () => {
    const tables = targetFor(relational);
    tables.observations[0] = { ...tables.observations[0], sneaked_in: 'a value nobody planned' };
    const edited = run({ relational, files: files(), tables });
    expect(edited.findings.counts['external-reembed-receipt-invalid']).toBe(1);
    expect(edited.findings.samples[0].reasons).toContain('target-content-changed');
    // NULL, or the own default of the column, is what the database does to a column the plan left out
    const quiet = targetFor(relational);
    quiet.observations[0] = { ...quiet.observations[0], sneaked_in: null, defaulted: 'active', computed: 7, now_default: '2026-10-20T00:00:00.000000Z' };
    const columnDefaults = { observations: { sneaked_in: { default: null }, defaulted: { default: "'active'::text" }, computed: { default: null, generated: true }, now_default: { default: 'now()' } } };
    const fine = run({ relational, files: files(), tables: quiet, columnDefaults });
    expect(fine.findings.counts).toEqual({});
    expect(fine.evidence.reembed.complete).toBe(true);
    const wrongDefault = targetFor(relational);
    wrongDefault.observations[0] = { ...wrongDefault.observations[0], defaulted: 'something else' };
    expect(run({ relational, files: files(), tables: wrongDefault, columnDefaults }).findings.samples[0].reasons).toContain('target-content-changed');
  });

  it('holds the stored images row to the planned images row, not only to its existence', () => {
    const tables = targetFor(relational);
    tables.images[0] = { ...tables.images[0], description: 'edited after the import' };
    const edited = run({ relational, files: files(), tables });
    expect(edited.findings.counts['external-reembed-receipt-invalid']).toBe(1);
    expect(edited.findings.samples[0].reasons).toContain('target-content-changed');
    const extra = targetFor(relational);
    extra.images[1] = { ...extra.images[1], an_extra_column: 'x' };
    expect(run({ relational, files: files(), tables: extra }).findings.samples[0].reasons).toContain('target-content-changed');
    const gone = targetFor(relational);
    gone.images = [];
    expect(run({ relational, files: files(), tables: gone }).findings.samples[0].reasons).toContain('target-row-missing');
  });
});
