import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { assertSourceAdapter } from './adapter.mjs';
import { SqliteV32Adapter } from './sqlite-v32.mjs';

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: 'inspect-source', summary, safe_details: safeDetails, report_path: null });
}

function localSqlExport(source) {
  if (typeof source !== 'string' || /^(?:https?|d1):/iu.test(source) || !source.toLowerCase().endsWith('.sql')) throw refusal('RMIG-E-D1-REMOTE-UNSUPPORTED', 'D1 sources must be local .sql exports; remote identifiers are refused.');
  return resolve(source);
}

function assertNoDirectives(sql) {
  const lines = sql.split(/\r?\n/u);
  const line = lines.find((value) => /^\s*\./u.test(value));
  if (line) throw refusal('RMIG-E-D1-REMOTE-UNSUPPORTED', 'D1 SQL exports must not contain SQLite shell directives.', { directive: line.trim().split(/\s+/u)[0] });
}

export function createD1ExportAdapter({ source } = {}) {
  const exportPath = localSqlExport(source);
  let sql;
  try { sql = readFileSync(exportPath, 'utf8'); }
  catch { throw refusal('RMIG-E-SOURCE-ARG', 'The local D1 SQL export could not be read.', { source_kind: 'd1-export' }); }
  assertNoDirectives(sql);
  const tempDirectory = mkdtempSync(join(tmpdir(), 'rm-d1-materialized-'));
  const materializedPath = join(tempDirectory, 'materialized.sqlite');
  try {
    const database = new DatabaseSync(materializedPath);
    try { database.exec(sql); } finally { database.close(); }
    return assertSourceAdapter(new SqliteV32Adapter({ source: materializedPath, allowAnyTables: true, tempDirectory, cleanupTemp: true }));
  } catch (error) {
    try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* preserve the original refusal */ }
    if (error instanceof MigrationRefusal) throw error;
    throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The local D1 SQL export could not be materialized safely.', { source_kind: 'd1-export', reason: String(error?.code ?? 'invalid-sql') });
  }
}
