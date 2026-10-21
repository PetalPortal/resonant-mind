// A keyed seal on the validation report.
//
// `report_sha256` is a plain hash: anyone who edits a report can recompute it. So `validate` also seals the
// report with an HMAC whose key is derived (scrypt, a fresh salt per report) from the migration passphrase
// file, the same secret that protects the bundle. `status` verifies the seal with the same file and will not
// report a state from a report whose seal does not verify. A report with no seal (validate was run without a
// passphrase file) can still be read, but status says plainly that it is not proof.
//
// What this does and does not give: it shows that the report was produced by a holder of the passphrase
// file (the operator) and is unchanged since. It does not make the operator trustworthy, and anyone who holds
// the passphrase file can seal a report; it is a guard against edits and against a report from elsewhere.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json.mjs';

const ALGORITHM = 'hmac-sha256/scrypt-v1';

function keyFor(passphrase, salt) {
  return scryptSync(passphrase, Buffer.concat([Buffer.from('rmig-report-seal-v1\0', 'utf8'), salt]), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
// What a seal covers: the purpose (so a seal made for one kind of document cannot stand for another), the
// migration, and the document's own content hash.
function macFor(key, document, { purpose = 'rmig-validation-report', hashField = 'report_sha256' } = {}) {
  return createHmac('sha256', key).update(canonicalJson({ purpose, migration_id: document.migration_id, [hashField]: document[hashField] })).digest();
}
const RECEIPT_SEAL = Object.freeze({ purpose: 'rmig-image-copy-receipt', hashField: 'receipt_sha256' });

/** The seal object to store as `report_seal`, over a report whose `report_sha256` is already set. */
export function sealReport(report, passphrase) {
  const salt = randomBytes(16);
  const key = keyFor(passphrase, salt);
  try { return { algorithm: ALGORITHM, salt: salt.toString('hex'), mac: macFor(key, report).toString('hex') }; } finally { key.fill(0); }
}

function verifySeal(seal, document, passphrase, options) {
  if (!seal || seal.algorithm !== ALGORITHM || !/^[0-9a-f]{32}$/u.test(String(seal.salt)) || !/^[0-9a-f]{64}$/u.test(String(seal.mac))) return false;
  if (typeof document?.[options?.hashField ?? 'report_sha256'] !== 'string') return false;
  const key = keyFor(passphrase, Buffer.from(seal.salt, 'hex'));
  try { return timingSafeEqual(macFor(key, document, options), Buffer.from(seal.mac, 'hex')); } finally { key.fill(0); }
}

/** True only when the report carries a well-formed seal that verifies under this passphrase. */
export function verifyReportSeal(report, passphrase) {
  return verifySeal(report?.report_seal, report, passphrase);
}

/**
 * The same keyed seal over an image copy receipt (`receipt_seal`, over a receipt whose `receipt_sha256` is set).
 * The filesystem copy writes a plain JSON receipt, and a plain hash can be recomputed by anyone who can write the
 * file, including from the target directory itself; the seal shows that the receipt was written by a holder of
 * the migration passphrase (the operator running the copy) and is unchanged since. It proves who wrote the
 * receipt, not that the copy is right: validate still re-reads the objects.
 */
export function sealImageReceipt(receipt, passphrase) {
  const salt = randomBytes(16);
  const key = keyFor(passphrase, salt);
  try { return { algorithm: ALGORITHM, salt: salt.toString('hex'), mac: macFor(key, receipt, RECEIPT_SEAL).toString('hex') }; } finally { key.fill(0); }
}
export function verifyImageReceiptSeal(receipt, passphrase) {
  return verifySeal(receipt?.receipt_seal, receipt, passphrase, RECEIPT_SEAL);
}
