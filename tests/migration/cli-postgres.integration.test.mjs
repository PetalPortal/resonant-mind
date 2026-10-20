import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasAdminDatabase, withScratchSource } from './helpers/postgres-scratch.mjs';

// The operator's own commands (inspect-source, export, verify-bundle) driven as separate processes
// against a real PostgreSQL v3.2 database, with the connection only in an environment variable.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = resolve(repositoryRoot, 'scripts/v32-to-v4/cli.mjs');

const SEED = `
INSERT INTO entities (id, name, entity_type, created_at) VALUES (1, 'CLI person', 'person', '2026-01-02 03:04:05.123456+00'), (2, 'CLI idea', 'concept', '2026-01-02 03:04:06+00');
INSERT INTO observations (id, entity_id, content, added_at) VALUES (1, 1, 'cli observation', '2026-01-02 04:00:00.5+00');
INSERT INTO embeddings (id, source_type, source_id, embedding, content, metadata) VALUES ('e1', 'observation', 1, (SELECT array_fill(0.5::real, ARRAY[768])::vector), 'x', '{"a": 1}');
`;

function cli(args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, ...env } });
}

describe.skipIf(!hasAdminDatabase)('migrator CLI against a live PostgreSQL v3.2 source (TEST_ADMIN_DATABASE_URL)', () => {
  it('inspects, exports and verifies without the connection string appearing anywhere', async () => {
    const work = mkdtempSync(join(tmpdir(), 'rmig-cli-pg-'));
    try {
      await withScratchSource({ seed: (client) => client.query(SEED) }, async (url) => {
        const env = { RMIG_CLI_SOURCE: url };
        const report = join(work, 'source-report.json');
        const bundle = join(work, 'bundle.rmigrate');
        const passphrase = join(work, 'passphrase');
        writeFileSync(passphrase, 'cli-live-passphrase', { mode: 0o600 });

        const inspect = cli(['inspect-source', '--source-kind', 'postgres', '--source', 'env:RMIG_CLI_SOURCE', '--report', report], env);
        expect(inspect.status, inspect.stderr).toBe(0);
        expect(inspect.stdout).toMatch(/inspect-source: supported postgres; tables=17; rows=\d+; images=0; embeddings=1/u);
        const parsed = JSON.parse(readFileSync(report, 'utf8'));
        expect(parsed.status).toBe('succeeded');
        expect(parsed.details.catalog_match).toBe(true);
        expect(parsed.details.catalog_diff).toEqual([]);
        expect(parsed.details.tables.find((table) => table.name === 'entities').row_count).toBe('2');
        expect(parsed.details.embedding_inventory).toEqual([{ source_type: 'observation', row_count: '1' }]);

        const exported = cli(['export', '--source-kind', 'postgres', '--source', 'env:RMIG_CLI_SOURCE', '--source-report', report, '--migration-id', 'rmig_cli_live_01', '--bundle', bundle, '--passphrase-file', passphrase], env);
        expect(exported.status, exported.stderr).toBe(0);
        expect(exported.stdout).toMatch(/^export: complete;/u);
        expect(existsSync(join(bundle, 'manifest.json'))).toBe(true);

        const verified = cli(['verify-bundle', '--bundle', bundle, '--passphrase-file', passphrase], {});
        expect(verified.status, verified.stderr).toBe(0);
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
        expect(manifest.source_kind).toBe('postgres');
        expect(manifest.source_fingerprint).toBe(parsed.details.actual_fingerprint);
        expect(manifest.bundle_mode).toBe('encrypted');

        // Nothing the CLI printed or wrote may carry the connection string or its password.
        const parts = new URL(url);
        const everything = [inspect.stdout, inspect.stderr, exported.stdout, exported.stderr, verified.stdout, verified.stderr, readFileSync(report, 'utf8'), readFileSync(join(bundle, 'manifest.json'), 'utf8')].join('\n');
        expect(everything).not.toContain(url);
        if (parts.password) expect(everything).not.toContain(parts.password);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a schema that is not the exact v3.2 one, writes a refused report, and exports nothing', async () => {
    const work = mkdtempSync(join(tmpdir(), 'rmig-cli-pg-'));
    try {
      await withScratchSource({ seed: (client) => client.query('ALTER TABLE entities ADD COLUMN stray text') }, async (url) => {
        const env = { RMIG_CLI_SOURCE: url };
        const report = join(work, 'source-report.json');
        const bundle = join(work, 'bundle.rmigrate');
        const passphrase = join(work, 'passphrase');
        writeFileSync(passphrase, 'cli-live-passphrase', { mode: 0o600 });

        const inspect = cli(['inspect-source', '--source-kind', 'postgres', '--source', 'env:RMIG_CLI_SOURCE', '--report', report], env);
        expect(inspect.status).not.toBe(0);
        expect(`${inspect.stdout}${inspect.stderr}`).toContain('RMIG-E-SOURCE-FINGERPRINT');
        const parsed = JSON.parse(readFileSync(report, 'utf8'));
        expect(parsed.status).toBe('refused');
        expect(JSON.stringify(parsed.details), 'report details').toContain('stray');

        const exported = cli(['export', '--source-kind', 'postgres', '--source', 'env:RMIG_CLI_SOURCE', '--migration-id', 'rmig_cli_live_02', '--bundle', bundle, '--passphrase-file', passphrase], env);
        expect(exported.status).not.toBe(0);
        expect(`${exported.stdout}${exported.stderr}`).toContain('RMIG-E-SOURCE-FINGERPRINT');
        expect(existsSync(join(bundle, 'manifest.json'))).toBe(false);
        expect(`${inspect.stdout}${inspect.stderr}${exported.stdout}${exported.stderr}`).not.toContain(url);
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
