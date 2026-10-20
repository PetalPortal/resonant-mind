import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { parseEnvReference } from '../source/postgres-v32.mjs';
import { createV4MigrationRunner } from '../../migrate-postgres.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { buildDryRunReport, dryRunStaging, importPlan, inspectTarget, prepareTarget, readTargetIdentity } from '../target/postgres.mjs';

const { Client } = pg;

function refuse(summary) { return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'runtime', summary, safe_details: {}, report_path: null }); }
function flags(argv) {
  const allowed = new Set(['--target', '--source', '--source-kind', '--migration-id', '--bundle-manifest-sha256', '--compiled-policy-sha256', '--resume-schema', '--staging-schema', '--plan', '--dry-run', '--receipt-out']);
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!allowed.has(key)) throw refuse('Target commands accept only documented options.');
    const value = argv[++i];
    if (typeof value !== 'string' || value.startsWith('--') || out[key] !== undefined) throw refuse(`Target command requires one value for ${key}.`);
    out[key] = value;
  }
  return out;
}
function hash(value, label) { if (!/^[0-9a-f]{64}$/u.test(value ?? '')) throw refuse(`${label} must be a lowercase SHA-256 digest.`); return value; }
function loadJson(path, label) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw refuse(`${label} is missing or invalid JSON.`); } }
export function connectionFor(reference) {
  const name = parseEnvReference(reference);
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw refuse('The target PostgreSQL environment variable is unset or empty.');
  return { connectionString: value, ssl: sslFor(value) };
}
// TLS to the target is verified unless the operator says otherwise. An explicit sslmode=disable in the
// connection string (a local PostgreSQL without TLS) is honoured as libpq honours it; PG_SSL_NO_VERIFY=1
// (or sslmode=no-verify) keeps TLS but skips certificate verification. Nothing here ever prints the string.
export function sslFor(connectionString) {
  let mode = null;
  try { mode = new URL(connectionString).searchParams.get('sslmode'); } catch { mode = null; }
  if (mode === 'disable') return false;
  if (process.env.PG_SSL_NO_VERIFY === '1' || mode === 'no-verify') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}
// A PostgreSQL source is named by env:NAME and its identity is the database's own (so a target that is the
// same database is refused). A SQLite or D1-export source is a local file: it has no database identity to
// collide with a PostgreSQL target, so its identity is the file's, read through the same read-only adapter.
async function sourceIdentity(reference, sourceKind = 'postgres') {
  if (sourceKind !== 'postgres') {
    const { adapterFor } = await import('./export.mjs');
    const adapter = await adapterFor(sourceKind, reference);
    try { return await adapter.identity(); } finally { await adapter.close(); }
  }
  const { connectionString, ssl } = connectionFor(reference);
  const adapter = (await import('../source/postgres-v32.mjs')).createPostgresV32Adapter({ source: 'env:RMIG_SOURCE_INTERNAL', env: { RMIG_SOURCE_INTERNAL: connectionString }, clientFactory: (value) => new Client({ connectionString: value, ssl }) });
  try { return await adapter.identity(); } finally { await adapter.close(); }
}
const SOURCE_KINDS = new Set(['postgres', 'sqlite', 'd1-export']);
async function withTarget(reference, callback) {
  const { connectionString, ssl } = connectionFor(reference);
  const client = new Client({ connectionString, ssl });
  await client.connect();
  try { return await callback(client, { connectionString, ssl }); } finally { await client.end().catch(() => {}); }
}
function reserveOutput(path) {
  if (existsSync(path)) throw refuse('The receipt output already exists; a receipt is never overwritten. Choose a new path.');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  closeSync(openSync(temporary, 'wx', 0o600));
  return {
    release() { try { unlinkSync(temporary); } catch { /* nothing to release */ } },
    commit(value) { writeFileSync(temporary, canonicalJson(value), { mode: 0o600 }); renameSync(temporary, path); },
  };
}
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp-${process.pid}`; writeFileSync(temp, canonicalJson(value), { mode: 0o600 }); renameSync(temp, path); }
function requireValue(values, key) { if (typeof values[key] !== 'string') throw refuse(`Target command requires ${key}.`); return values[key]; }

export function parseTargetCommandArgs(command, argv) {
  const values = flags(argv);
  requireValue(values, '--target');
  if (values['--source-kind'] !== undefined && !SOURCE_KINDS.has(values['--source-kind'])) throw refuse('--source-kind must be postgres, sqlite, or d1-export.');
  if (values['--source-kind'] !== undefined && !['inspect-target', 'prepare-target'].includes(command)) throw refuse('--source-kind applies only to inspect-target and prepare-target.');
  if (command === 'inspect-target') requireValue(values, '--source');
  if (command === 'prepare-target') {
    requireValue(values, '--source'); requireValue(values, '--migration-id');
    hash(requireValue(values, '--bundle-manifest-sha256'), 'bundle-manifest-sha256');
    hash(requireValue(values, '--compiled-policy-sha256'), 'compiled-policy-sha256');
  }
  if (command === 'dry-run') { requireValue(values, '--plan'); requireValue(values, '--staging-schema'); requireValue(values, '--receipt-out'); }
  if (command === 'import') { requireValue(values, '--plan'); requireValue(values, '--dry-run'); requireValue(values, '--staging-schema'); requireValue(values, '--receipt-out'); }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase()), value]));
}

export async function targetCommand(command, argv) {
  const parsed = parseTargetCommandArgs(command, argv);
  if (command === 'inspect-target') return withTarget(parsed.target, async (client) => ({ command, ...(await inspectTarget({ client, sourceIdentity: await sourceIdentity(parsed.source, parsed.sourceKind) })) }));
  if (command === 'prepare-target') return withTarget(parsed.target, async (client, config) => {
    const source = await sourceIdentity(parsed.source, parsed.sourceKind);
    const runner = createV4MigrationRunner({ connectionString: config.connectionString, ssl: config.ssl });
    try {
      return { command, ...(await prepareTarget({ client, migrationRunner: runner, sourceIdentity: source, migrationId: parsed.migrationId, bundleManifestSha256: parsed.bundleManifestSha256, compiledPolicySha256: parsed.compiledPolicySha256, resumeSchema: parsed.resumeSchema, plan: parsed.plan === undefined ? undefined : loadJson(parsed.plan, 'The relational staging plan') })) };
    } finally { await runner.close().catch(() => {}); }
  });
  if (command === 'dry-run') return withTarget(parsed.target, async (client) => {
    const plan = loadJson(parsed.plan, 'The relational staging plan');
    const target = await readTargetIdentity({ client });
    if (existsSync(parsed.receiptOut)) throw refuse('The receipt output already exists; a receipt is never overwritten. Choose a new path.');
    const report = await dryRunStaging({ client, plan, stagingSchema: parsed.stagingSchema, targetIdentity: target });
    writeJson(parsed.receiptOut, report);
    return { command, receipt_sha256: report.receipt_sha256, report_path: parsed.receiptOut };
  });
  if (command === 'import') return withTarget(parsed.target, async (client) => {
    const plan = loadJson(parsed.plan, 'The relational staging plan');
    const dryRun = loadJson(parsed.dryRun, 'The dry-run receipt');
    const target = await readTargetIdentity({ client });
    // The import commits exactly once. Make sure the receipt can be written before it does, so that a
    // committed import is never left without its receipt because the output path was unwritable.
    const reservation = reserveOutput(parsed.receiptOut);
    let receipt;
    try { receipt = await importPlan({ client, plan, dryRun, targetIdentity: target, stagingSchema: parsed.stagingSchema }); } catch (error) { reservation.release(); throw error; }
    reservation.commit(receipt);
    return { command, ...receipt, report_path: parsed.receiptOut };
  });
  throw refuse('Unknown target command.');
}

export function humanTargetResult(result) {
  if (result.command === 'inspect-target') return `inspect-target: fresh=${result.object_count === 0}; pgvector=${result.pgvector}\n`;
  if (result.command === 'prepare-target') return `prepare-target: schema=${result.schema}; status=${result.status}\n`;
  if (result.command === 'dry-run') return `dry-run: receipt_sha256=${result.receipt_sha256}; report=${result.report_path}\n`;
  return `import: status=${result.status}; receipt_sha256=${result.receipt_sha256}; rows=${result.inserted_rows}; receipt=${result.report_path}\n`;
}
