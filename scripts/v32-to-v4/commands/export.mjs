import { readFileSync } from 'node:fs';
import { createBundle } from '../lib/bundle.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

import { createRequire } from 'node:module';
// The release that wrote the artifact (package.json), so a report says which migrator made it.
const VERSION = createRequire(import.meta.url)('../../../package.json').version;

function refusal(summary) {
  return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'export', summary, safe_details: {}, report_path: null });
}

function parseFlags(argv, allowed) {
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw refusal('export accepts only documented options; pass --help for usage.');
    if (key === '--allow-plaintext-bundle' || key === '--acknowledge-plaintext-risk') {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) throw refusal(`export requires a value for ${key}.`);
    if (result[key] !== undefined) throw refusal(`export option ${key} may be supplied only once.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

export function parseExportArgs(argv) {
  const values = parseFlags(argv, new Set([
    '--source-kind', '--source', '--source-report', '--source-fingerprint', '--migration-id', '--bundle', '--passphrase-file',
    '--allow-plaintext-bundle', '--acknowledge-plaintext-risk',
  ]));
  const required = ['--source-kind', '--source', '--migration-id', '--bundle'];
  if (required.some((key) => typeof values[key] !== 'string')) throw refusal('export requires --source-kind, --source, --migration-id, and --bundle.');
  let sourceReport;
  try { sourceReport = values['--source-report'] === undefined ? undefined : JSON.parse(readFileSync(values['--source-report'], 'utf8')); }
  catch { throw refusal('The source report is missing or invalid JSON.'); }
  const plaintextFlags = values['--allow-plaintext-bundle'] === true || values['--acknowledge-plaintext-risk'] === true;
  const plaintext = values['--allow-plaintext-bundle'] === true && values['--acknowledge-plaintext-risk'] === true;
  if (plaintextFlags && !plaintext) throw new MigrationRefusal({ code: 'RMIG-E-BUNDLE-PLAINTEXT-ACK', phase: 'export', summary: 'Plaintext bundles require both explicit acknowledgement flags.', safe_details: {}, report_path: null });
  return {
    sourceKind: values['--source-kind'], source: values['--source'], sourceReport,
    sourceFingerprint: values['--source-fingerprint'] ?? sourceReport?.details?.actual_fingerprint,
    migrationId: values['--migration-id'], outputPath: values['--bundle'], passphraseFile: values['--passphrase-file'],
    mode: plaintext ? 'plaintext' : 'encrypted',
    allowPlaintextBundle: plaintext, acknowledgePlaintextRisk: plaintext,
  };
}

async function adapterFor(sourceKind, source) {
  if (sourceKind === 'postgres') return (await import('../source/postgres-v32.mjs')).createPostgresV32Adapter({ source });
  if (sourceKind === 'sqlite') return (await import('../source/sqlite-v32.mjs')).createSqliteV32Adapter({ source });
  if (sourceKind === 'd1-export') return (await import('../source/d1-export.mjs')).createD1ExportAdapter({ source });
  throw refusal('export requires a supported source kind.');
}

export async function exportCommand(args) {
  const adapter = await adapterFor(args.sourceKind, args.source);
  const result = await createBundle({ ...args, adapter, migratorVersion: VERSION });
  return result;
}

export function humanExportResult(result) {
  return `export: complete; path=${result.path}; members=${result.manifest.members.length}\n`;
}

export { adapterFor };
