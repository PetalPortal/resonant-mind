import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const userGuide = () => read('USER_MIGRATION_GUIDE.md');
const agentRunbook = () => read('AGENT_MIGRATION_RUNBOOK.md');
const refusalCodes = [
  'RMIG-E-NODE-VERSION',
  'RMIG-E-SOURCE-ARG',
  'RMIG-E-SOURCE-FINGERPRINT',
  'RMIG-E-SOURCE-DRIFT',
  'RMIG-E-SOURCE-NOT-READONLY',
  'RMIG-E-D1-REMOTE-UNSUPPORTED',
  'RMIG-E-D1-SQL-UNSAFE',
  'RMIG-E-BUNDLE-PLAINTEXT-ACK',
  'RMIG-E-BUNDLE-INTEGRITY',
  'RMIG-E-BUNDLE-DECRYPT',
  'RMIG-E-SECRET-DETECTED',
  'RMIG-E-POLICY-UNRESOLVED',
  'RMIG-E-POLICY-MISMATCH',
  'RMIG-E-SAME-SOURCE-TARGET',
  'RMIG-E-TARGET-NOT-FRESH',
  'RMIG-E-TARGET-SCHEMA',
  'RMIG-E-DRY-RUN-REQUIRED',
  'RMIG-E-DRY-RUN',
  'RMIG-E-TARGET-CHANGED',
  'RMIG-E-ENTITY-COMPAT',
  'RMIG-E-RECEIPT-MISMATCH',
  'RMIG-E-IMAGE-INCOMPLETE',
  'RMIG-E-REEMBED-INCOMPLETE',
  'RMIG-E-CHECKPOINT',
  'RMIG-E-CHECKPOINT-FAULT',
  'RMIG-E-VALIDATION',
  'RMIG-E-COMMAND-UNKNOWN',
  'RMIG-E-COMMAND-NOT-IMPLEMENTED',
];

const requiredHeadings = [
  'Support matrix',
  'Source and target safety',
  'What changes in the data',
  'Backup and restore rehearsal',
  'Operator command sequence',
  'Risks, sizing, and quiescence',
  'Troubleshooting',
  'Interruption and restart',
  'Cutover and rollback',
  'Sensitive artifact retention',
];

const exactCommands = [
  'inspect-source', 'export', 'verify-bundle', 'compile-policy', 'inspect-target',
  'prepare-target', 'dry-run', 'import', 'plan-images', 'copy-images',
  'plan-reembed', 'validate', 'status',
];

const forbiddenPositiveClaims = [
  /in-place\s+(?:migration|upgrade|import)\s+(?:is|remains)\s+(?:supported|allowed|available)/iu,
  /(?:support|upgrade|migration|import)\s+(?:is|remains)\s+(?:supported|allowed|available)\s+in-place/iu,
  /automatic(?:ally)?\s+(?:copy|transfer|upload)\s+(?:to\s+)?R2(?![^.\n]{0,40}(?:unsupported|not supported|not permitted))/iu,
  /general\s+resume\s+(?:is|remains)\s+(?:supported|available)/iu,
  /automatic\s+cutover\s+(?:is|remains)\s+(?:supported|available)/iu,
  /release\s+support\s+(?:is|remains)\s+(?:provided|included|promised)/iu,
  /supported\s+release\s+(?:is|remains|ships)/iu,
];

function assertHasEvery(text, values) {
  for (const value of values) expect(text).toContain(value);
}

describe('operator migration documentation', () => {
  it('creates both operator documents with the required sections', () => {
    expect(existsSync(resolve(root, 'USER_MIGRATION_GUIDE.md'))).toBe(true);
    expect(existsSync(resolve(root, 'AGENT_MIGRATION_RUNBOOK.md'))).toBe(true);
    assertHasEvery(userGuide(), requiredHeadings);
    assertHasEvery(agentRunbook(), [
      'State machine', 'Authorization gate', 'Secret boundary', 'Backup evidence',
      'Identity and freshness gate', 'Decision review gate', 'Dry-run receipt gate',
      'External phase evidence', 'Stop conditions', 'Cutover and rollback',
    ]);
  });

  it('states the exact first-release source and target boundary', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    assertHasEvery(text, [
      'PostgreSQL v3.2.0',
      'D1/SQLite v3.2.0',
      'fresh v4 PostgreSQL',
      'read-only',
      'separate',
      'old vectors',
      'operator-assisted',
      'not a product support promise',
    ]);
    expect(text).toMatch(/remote Cloudflare D1[\s\S]{0,500}npx wrangler d1 export <binding-or-name> --remote --output <local\.sql>/iu);
    expect(text).toMatch(/R2[\s\S]{0,500}(?:external|operator).{0,80}(?:receipt|handoff)/iu);
    for (const pattern of forbiddenPositiveClaims) expect(text).not.toMatch(pattern);
  });

  it('documents every current refusal code and exact refusal language', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    assertHasEvery(text, refusalCodes);
    assertHasEvery(text, [
      'exit code 2',
      'Unexpected internal failures use exit code 1',
      'human text on stderr',
      'JSON on stdout when --json is set',
      'No bypass is permitted',
    ]);
  });

  it('contains the current CLI command names and parser options', () => {
    const text = userGuide();
    assertHasEvery(text, exactCommands);
    assertHasEvery(text, [
      '--source-kind', '--source', '--report', '--migration-id', '--bundle',
      '--source-report', '--source-fingerprint', '--passphrase-file',
      '--allow-plaintext-bundle', '--acknowledge-plaintext-risk', '--decisions', '--out',
      '--target', '--bundle-manifest-sha256', '--compiled-policy-sha256',
      '--resume-schema', '--plan', '--staging-schema', '--receipt-out', '--dry-run',
      '--input', '--images', '--adapter', '--external-receipt', '--trusted-public-key',
      '--reembed-plan', '--reembed-receipts', '--dry-run-receipt', '--import-receipt',
      '--target-catalog', '--current-migrations', '--migration-set-sha256',
      '--image-plan', '--image-receipt', '--operator-cutover-ack',
    ]);
    expect(text).toContain('The current top-level --help lists command names only');
  });

  it('links the new guides from the existing entry points', () => {
    const readme = read('README.md');
    const oldGuide = read('docs/migration-from-mind-cloud.md');
    expect(readme).toContain('[User migration guide](USER_MIGRATION_GUIDE.md)');
    expect(readme).toContain('[Agent migration runbook](AGENT_MIGRATION_RUNBOOK.md)');
    expect(oldGuide).toContain('../USER_MIGRATION_GUIDE.md');
    expect(oldGuide).toContain('../AGENT_MIGRATION_RUNBOOK.md');
  });

  it('does not include usable credentials or secret-shaped examples', () => {
    const text = `${userGuide()}\n${agentRunbook()}`;
    expect(text).not.toMatch(/postgres(?:ql)?:\/\/[^<\[\{\s`]+/iu);
    expect(text).not.toMatch(/(?:api[_-]?key|secret|password|token)\s*[=:]\s*['"](?!<|\[|\{)[^'"`\n]+/iu);
    expect(text).not.toMatch(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/u);
    expect(text).toMatch(/env:RMIG_(?:SOURCE|TARGET)/u);
    expect(text).toMatch(/<passphrase-file>/u);
  });
});
