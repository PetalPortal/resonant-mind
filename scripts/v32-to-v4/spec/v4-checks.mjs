// The CHECK constraints the released v4 schema has, as the database prints them.
//
// Validation re-proves every CHECK constraint against the stored rows by evaluating its expression, and
// that expression is text read from the target's own catalog. Evaluating text a target supplies would run
// whatever functions it names (pg_sleep, lo_export, dblink, ...) with the validator's rights, read-only or
// not. So only a constraint that is exactly one of the released schema's is evaluated; any other CHECK is a
// finding and is never run. The expected set is not written by hand: this module derives it by applying the
// released migrations to a scratch database and reading the catalog back with the same session settings the
// validator uses, and v4-checks.json is the committed result. It is bound to the exact migration set, so a
// change to the migrations without a regenerated spec fails a test.
//
//   node scripts/v32-to-v4/spec/v4-checks.mjs --admin env:NAME [--check]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { applyV4Migrations, migrationSetSha256, readV4Migrations } from '../../migrate-postgres.mjs';
import { SOURCE_SESSION_SETTINGS } from '../source/postgres-v32.mjs';
import { redactText } from '../lib/redact.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const CHECKS_SPEC_PATH = join(here, 'v4-checks.json');

export const CHECKS_QUERY = "SELECT c.conname::text AS name, rel.relname::text AS table_name, pg_catalog.pg_get_expr(c.conbin, c.conrelid) AS expression FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname = 'public' AND c.contype = 'c' ORDER BY rel.relname, c.conname";
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const squash = (text) => String(text).replace(/\s+/gu, ' ').trim();

/** The committed expected set: [{ table, name, expression }] with the migration set it was derived from. */
export function loadExpectedChecks(path = CHECKS_SPEC_PATH) {
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(spec.checks) || typeof spec.migration_set_sha256 !== 'string') throw new Error('v4-checks.json is not a CHECK constraint spec.');
  return spec;
}

/**
 * Splits the CHECK constraints a target holds into the ones that are exactly the released schema's (safe to
 * evaluate), the ones that are not (never evaluated), and the released ones the target lacks.
 */
export function classifyChecks(live, expectedChecks) {
  const expected = new Map(expectedChecks.map((check) => [`${check.table}\u0000${check.name}`, squash(check.expression)]));
  const evaluate = []; const unexpected = []; const seen = new Set();
  for (const check of live) {
    const key = `${check.table_name}\u0000${check.name}`;
    if (!expected.has(key)) { unexpected.push({ table: check.table_name, constraint: check.name, reason: 'not-in-the-released-schema' }); continue; }
    seen.add(key);
    if (expected.get(key) !== squash(check.expression)) { unexpected.push({ table: check.table_name, constraint: check.name, reason: 'expression-differs-from-the-released-schema' }); continue; }
    evaluate.push(check);
  }
  const missing = expectedChecks.filter((check) => !seen.has(`${check.table}\u0000${check.name}`)).map((check) => ({ table: check.table, constraint: check.name }));
  return { evaluate, unexpected, missing };
}

async function sessionRead(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SELECT ${SOURCE_SESSION_SETTINGS.map((_s, index) => `set_config($${index * 2 + 1}, $${index * 2 + 2}, true)`).join(', ')}`, SOURCE_SESSION_SETTINGS.flatMap(({ name, value }) => [name, value]));
    return (await client.query(CHECKS_QUERY)).rows;
  } finally { await client.query('ROLLBACK').catch(() => {}); }
}

/** Applies the released migrations to a scratch database and reads the CHECK constraints back. */
export async function generateV4ChecksSpec({ adminUrl } = {}) {
  if (typeof adminUrl !== 'string' || adminUrl.length === 0) throw new TypeError('An admin connection URL is required.');
  const { Client } = require('pg');
  const database = `rmig_checks_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: adminUrl });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    const url = new URL(adminUrl); url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    const migrations = await readV4Migrations();
    await applyV4Migrations({ client, migrations });
    const serverVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    const rows = await sessionRead(client);
    const spec = {
      description: 'CHECK constraints of the released v4 schema, as pg_get_expr prints them with the validator session settings (generated on PostgreSQL 18.6). Derived by spec/v4-checks.mjs; validate evaluates only these.',
      migration_set_sha256: migrationSetSha256(migrations),
      checks: rows.map((row) => ({ table: row.table_name, name: row.name, expression: squash(row.expression) })),
    };
    return { spec, text: `${JSON.stringify(spec, null, 2)}\n` };
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const adminIndex = argv.indexOf('--admin');
  const reference = adminIndex >= 0 ? argv[adminIndex + 1] : undefined;
  const name = /^env:([A-Za-z_][A-Za-z0-9_]*)$/u.exec(reference ?? '')?.[1];
  if (!name || !process.env[name]) throw new Error('Usage: v4-checks.mjs --admin env:NAME [--check]');
  const result = await generateV4ChecksSpec({ adminUrl: process.env[name] });
  const same = readFileSync(CHECKS_SPEC_PATH, 'utf8').replaceAll('\r\n', '\n') === result.text;
  if (argv.includes('--check')) { process.stdout.write(same ? 'v4-checks.json matches the released migrations.\n' : 'v4-checks.json DIFFERS from the released migrations.\n'); process.exitCode = same ? 0 : 1; return; }
  if (!same) writeFileSync(CHECKS_SPEC_PATH, result.text, 'utf8');
  process.stdout.write(`${same ? 'v4-checks.json already up to date' : 'v4-checks.json written'} (PostgreSQL ${result.serverVersion}, ${result.spec.checks.length} checks).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${redactText(error?.message ?? 'generator failed')}\n`); process.exitCode = 1; });
}
