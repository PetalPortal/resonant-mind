import { canonicalJson } from './canonical-json.mjs';
import {
  assertExactKeys,
  assertPlainData,
  assertPlainObject,
  assertSafeDetails,
  MIGRATION_PHASES,
} from './contracts.mjs';
import { redact, redactText } from './redact.mjs';

const REMEDIATIONS = Object.freeze({
  'RMIG-E-NODE-VERSION': 'Install and run the migrator with Node.js 22 or newer.',
  'RMIG-E-SOURCE-ARG': 'Pass a supported source kind and a local path or env:VARIABLE_NAME reference.',
  'RMIG-E-SOURCE-FINGERPRINT': 'Use an exact public v3.2 source schema or export from a supported source.',
  'RMIG-E-SOURCE-DRIFT': 'Restore an unchanged supported source snapshot and restart inspection.',
  'RMIG-E-SOURCE-NOT-READONLY': 'Grant read-only source access and rerun the operation.',
  'RMIG-E-D1-REMOTE-UNSUPPORTED': 'Export D1 to a local SQL file and pass that file as a d1-export source.',
  'RMIG-E-BUNDLE-PLAINTEXT-ACK': 'Use encryption or supply both explicit plaintext-risk acknowledgement flags.',
  'RMIG-E-BUNDLE-INTEGRITY': 'Regenerate the bundle from the verified source and do not reuse altered members.',
  'RMIG-E-BUNDLE-DECRYPT': 'Use the matching passphrase file for this unchanged bundle.',
  'RMIG-E-SECRET-DETECTED': 'Remove or explicitly resolve every reported secret finding before continuing.',
  'RMIG-E-POLICY-UNRESOLVED': 'Resolve every policy decision and compile the reviewed policy again.',
  'RMIG-E-POLICY-MISMATCH': 'Compile a policy against the exact unchanged bundle for this migration.',
  'RMIG-E-SAME-SOURCE-TARGET': 'Choose a distinct fresh v4 PostgreSQL database as the target.',
  'RMIG-E-TARGET-NOT-FRESH': 'Choose a distinct PostgreSQL database with no non-system objects.',
  'RMIG-E-TARGET-SCHEMA': 'Prepare a fresh target with the exact released v4 schema.',
  'RMIG-E-DRY-RUN-REQUIRED': 'Complete a successful dry run for the same bound inputs before applying.',
  'RMIG-E-RECEIPT-MISMATCH': 'Regenerate the receipt from the exact bound migration inputs.',
  'RMIG-E-IMAGE-INCOMPLETE': 'Complete and verify every planned image copy before final validation.',
  'RMIG-E-REEMBED-INCOMPLETE': 'Complete the re-embedding plan or use a reviewed defer policy.',
  'RMIG-E-VALIDATION': 'Resolve every validation finding and rerun final validation.',
  'RMIG-E-COMMAND-UNKNOWN': 'Run with --help and choose one listed migration command.',
  'RMIG-E-COMMAND-NOT-IMPLEMENTED': 'Use an implemented migration command or install a release that provides this phase.',
});

export const EXPECTED_REFUSAL_CODES = Object.freeze(Object.keys(REMEDIATIONS));
const REFUSAL_CODES = new Set(EXPECTED_REFUSAL_CODES);
const PHASES = new Set(MIGRATION_PHASES);
const REQUIRED_FIELDS = ['code', 'phase', 'summary', 'safe_details', 'report_path'];

function assertSafeText(value, label, { nullable = false } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    redactText(value) !== value
  ) {
    throw new TypeError(`${label} contains unsafe text or is not a non-empty single line.`);
  }
}

function frozenSnapshot(value) {
  const snapshot = JSON.parse(canonicalJson(value));
  const pending = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current)) {
        if (child !== null && typeof child === 'object') {
          pending.push(child);
        }
      }
      Object.freeze(current);
    }
  }
  return snapshot;
}

export class MigrationRefusal extends Error {
  constructor(options) {
    const fields = assertExactKeys(options, REQUIRED_FIELDS, 'MigrationRefusal options');
    if (!REFUSAL_CODES.has(fields.code)) {
      throw new TypeError(`Unknown refusal code: ${String(fields.code)}.`);
    }
    if (!PHASES.has(fields.phase)) {
      throw new TypeError('MigrationRefusal phase must be a supported migration phase.');
    }
    const safeSummary = redactText(fields.summary);
    assertPlainObject(fields.safe_details, 'safe_details');
    assertPlainData(fields.safe_details, 'safe_details');
    const safeDetailsValue = redact(fields.safe_details);
    const safeReportPath = fields.report_path === null ? null : redactText(fields.report_path);
    assertSafeText(safeSummary, 'MigrationRefusal summary');
    assertSafeDetails(safeDetailsValue);
    assertSafeText(safeReportPath, 'MigrationRefusal report_path', { nullable: true });
    const safeDetails = frozenSnapshot(safeDetailsValue);

    super(safeSummary);
    this.name = 'MigrationRefusal';
    this.code = fields.code;
    this.phase = fields.phase;
    this.summary = safeSummary;
    this.safe_details = safeDetails;
    this.remediation = REMEDIATIONS[fields.code];
    this.report_path = safeReportPath;
    Object.freeze(this);
  }

  toJSON() {
    return {
      code: this.code,
      phase: this.phase,
      summary: this.summary,
      safe_details: this.safe_details,
      remediation: this.remediation,
      report_path: this.report_path,
    };
  }
}

export function isMigrationRefusal(value) {
  return value instanceof MigrationRefusal;
}

export function exitCodeFor(error) {
  if (error === undefined || error === null) {
    return 0;
  }
  return isMigrationRefusal(error) ? 2 : 1;
}

export function serializeRefusal(refusal, { json = false } = {}) {
  if (!isMigrationRefusal(refusal)) {
    throw new TypeError('serializeRefusal requires a MigrationRefusal.');
  }
  if (typeof json !== 'boolean') {
    throw new TypeError('serializeRefusal json option must be boolean.');
  }
  if (json) {
    return canonicalJson(refusal.toJSON());
  }
  const report = refusal.report_path === null ? '' : ` Report: ${refusal.report_path}`;
  return `${refusal.code}: ${refusal.summary} ${refusal.remediation}${report}\n`;
}

export function remediationFor(code) {
  if (!REFUSAL_CODES.has(code)) {
    throw new TypeError(`Unknown refusal code: ${String(code)}.`);
  }
  return REMEDIATIONS[code];
}
