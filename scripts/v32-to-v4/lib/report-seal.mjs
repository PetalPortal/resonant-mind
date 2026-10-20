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
function macFor(key, report) {
  return createHmac('sha256', key).update(canonicalJson({ purpose: 'rmig-validation-report', migration_id: report.migration_id, report_sha256: report.report_sha256 })).digest();
}

/** The seal object to store as `report_seal`, over a report whose `report_sha256` is already set. */
export function sealReport(report, passphrase) {
  const salt = randomBytes(16);
  const key = keyFor(passphrase, salt);
  try { return { algorithm: ALGORITHM, salt: salt.toString('hex'), mac: macFor(key, report).toString('hex') }; } finally { key.fill(0); }
}

/** True only when the report carries a well-formed seal that verifies under this passphrase. */
export function verifyReportSeal(report, passphrase) {
  const seal = report?.report_seal;
  if (!seal || seal.algorithm !== ALGORITHM || !/^[0-9a-f]{32}$/u.test(String(seal.salt)) || !/^[0-9a-f]{64}$/u.test(String(seal.mac))) return false;
  const key = keyFor(passphrase, Buffer.from(seal.salt, 'hex'));
  try { return timingSafeEqual(macFor(key, report), Buffer.from(seal.mac, 'hex')); } finally { key.fill(0); }
}
