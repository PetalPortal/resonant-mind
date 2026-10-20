#!/usr/bin/env node
// Regenerates scripts/v32-to-v4/spec/v3.2-postgres.json from a real PostgreSQL catalog.
//
// The fingerprint of the public v3.2 PostgreSQL schema is not written by hand. This script creates a
// scratch database on an admin connection, applies the byte-verified tagged fixture
// tests/fixtures/migration/v3.2/postgres.sql (the v3.2.0 migrations/postgres.sql, hashed in
// PROVENANCE.json), reads the catalog through the SAME adapter code the CLI uses
// (createPostgresV32Adapter -> catalog()), and writes it in the fingerprint's own normal form
// (normalizeCatalog). The scratch database is dropped afterwards.
//
//   node scripts/v32-to-v4/spec/generate-postgres-spec.mjs --admin env:NAME [--check]
//
// --admin env:NAME   an environment variable holding a postgres:// URL of a role that may
//                    CREATE DATABASE and CREATE EXTENSION vector. The URL is never printed.
// --check            do not write; exit 1 if the committed spec differs from what a live database yields.
//
// The integration test tests/migration/postgres-spec.integration.test.mjs runs the same comparison,
// so the committed spec cannot drift from the schema the fixture really creates.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { normalizeCatalog } from '../lib/fingerprint.mjs';
import { redactText } from '../lib/redact.mjs';
import { createPostgresV32Adapter, parseEnvReference } from '../source/postgres-v32.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(here, '../../..');
export const SPEC_PATH = join(here, 'v3.2-postgres.json');
export const FIXTURE_DIR = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'migration', 'v3.2');
const SCRATCH_ENV = 'RMIG_SPEC_SCRATCH_URL';

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

function scratchUrl(adminUrl, database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** The tagged fixture's bytes, refused unless they are exactly the file PROVENANCE.json hashes. */
export function readVerifiedFixture(fixtureDir = FIXTURE_DIR) {
  const provenance = JSON.parse(readFileSync(join(fixtureDir, 'PROVENANCE.json'), 'utf8'));
  const entry = provenance.files?.find((file) => file.path === 'postgres.sql');
  const bytes = readFileSync(join(fixtureDir, 'postgres.sql'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (provenance.tag !== 'v3.2.0' || !entry || entry.sha256 !== sha256 || entry.bytes !== bytes.length) {
    throw new Error('The PostgreSQL fixture is not the byte-verified v3.2.0 migrations/postgres.sql; refusing to derive a fingerprint from it.');
  }
  return { sql: bytes.toString('utf8'), sha256, tag: provenance.tag };
}

/** The spec text exactly as it is committed: the normal form, two-space JSON, trailing newline. */
export function specText(catalog) {
  return `${JSON.stringify(normalizeCatalog(catalog), null, 2)}\n`;
}

/**
 * Builds the catalog a real v3.2 PostgreSQL database has, on a scratch database that is dropped
 * again. Returns { catalog, text, serverVersion, extensions, fixtureSha256 }.
 */
export async function generatePostgresSpec({ adminUrl, fixtureDir = FIXTURE_DIR } = {}) {
  if (typeof adminUrl !== 'string' || adminUrl.length === 0) throw new TypeError('An admin connection URL is required.');
  const fixture = readVerifiedFixture(fixtureDir);
  const { Client } = require('pg');
  const database = `rmig_spec_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: adminUrl });
  let client;
  let adapter;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    const url = scratchUrl(adminUrl, database);
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(fixture.sql);
    const serverVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    const extensions = Object.fromEntries((await client.query("SELECT extname, extversion FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql' ORDER BY extname")).rows.map((row) => [row.extname, row.extversion]));
    await client.end();
    client = undefined;

    adapter = createPostgresV32Adapter({ source: `env:${SCRATCH_ENV}`, env: { [SCRATCH_ENV]: url } });
    await adapter.beginSnapshot();
    const catalog = normalizeCatalog(await adapter.catalog());
    await adapter.endSnapshot();
    return { catalog, text: specText(catalog), serverVersion, extensions, fixtureSha256: fixture.sha256 };
  } finally {
    await adapter?.close().catch(() => {});
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

function parseArgs(argv) {
  const args = { admin: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--admin') args.admin = argv[++index];
    else if (argv[index] === '--check') args.check = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.admin) throw new Error('Usage: generate-postgres-spec.mjs --admin env:NAME [--check]');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = parseEnvReference(args.admin);
  const adminUrl = process.env[name];
  if (!adminUrl) throw new Error(`Environment variable ${name} is unset or empty.`);
  const result = await generatePostgresSpec({ adminUrl });
  const committed = readFileSync(SPEC_PATH, 'utf8');
  const same = committed === result.text;
  const note = `PostgreSQL ${result.serverVersion}, ${Object.entries(result.extensions).map(([extension, version]) => `${extension} ${version}`).join(', ')}; fixture sha256 ${result.fixtureSha256}`;
  if (args.check) {
    process.stdout.write(same ? `v3.2-postgres.json matches a live catalog (${note}).\n` : `v3.2-postgres.json DIFFERS from a live catalog (${note}).\n`);
    process.exitCode = same ? 0 : 1;
    return;
  }
  if (!same) writeFileSync(SPEC_PATH, result.text, 'utf8');
  process.stdout.write(`${same ? 'v3.2-postgres.json already up to date' : 'v3.2-postgres.json written'} (${note}).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${redactText(error?.message ?? 'generator failed')}\n`);
    process.exitCode = 1;
  });
}
