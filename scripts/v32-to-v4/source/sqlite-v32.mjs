import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { sourceSpecFor } from '../lib/fingerprint.mjs';
import { assertSourceAdapter } from './adapter.mjs';

const SQLITE_TABLES = new Set(sourceSpecFor('sqlite').tables.map(({ name }) => name));

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: 'inspect-source', summary, safe_details: safeDetails, report_path: null });
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceFile(path) {
  if (typeof path !== 'string' || path.length === 0 || /^(?:https?|d1):/iu.test(path)) throw refusal('RMIG-E-D1-REMOTE-UNSUPPORTED', 'Only local SQLite files are supported; remote identifiers are refused.');
  const resolved = resolve(path);
  let linkStat;
  try { linkStat = lstatSync(resolved); } catch { throw refusal('RMIG-E-SOURCE-ARG', 'The SQLite source path does not exist.', { source_kind: 'sqlite' }); }
  const real = realpathSync.native(resolved);
  const stat = statSync(real);
  if (!linkStat.isFile() && !linkStat.isSymbolicLink() || !stat.isFile()) throw refusal('RMIG-E-SOURCE-ARG', 'The SQLite source must resolve to a regular file.', { source_kind: 'sqlite' });
  return real;
}

function pragma(db, name) {
  return db.prepare(`PRAGMA ${name}`).all();
}

function quotePragmaName(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildCatalog(db) {
  const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const tables = tableRows.map(({ name }) => {
    const columns = pragma(db, `table_xinfo(${quotePragmaName(name)})`).filter((row) => row.hidden === 0).map((row) => ({ name: row.name, type: String(row.type ?? '').toUpperCase(), nullable: row.notnull === 0, default: row.dflt_value ?? null, pk_position: Number(row.pk ?? 0) }));
    const primary_key = columns.filter((row) => row.pk_position > 0).sort((a, b) => a.pk_position - b.pk_position).map((row) => row.name);
    const foreign_keys = pragma(db, `foreign_key_list(${quotePragmaName(name)})`).sort((a, b) => a.id - b.id || a.seq - b.seq).map((row) => ({ name: `${name}_fk_${row.id}`, columns: [row.from], references: { table: row.table, columns: [row.to] }, on_delete: row.on_delete, on_update: row.on_update }));
    const unique_constraints = [];
    const indexes = [];
    for (const index of pragma(db, `index_list(${quotePragmaName(name)})`).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (index.origin === 'pk') continue;
      const indexColumns = pragma(db, `index_xinfo(${quotePragmaName(index.name)})`).filter((row) => row.key === 1).sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
      const item = { name: index.name, unique: index.unique === 1, columns: indexColumns, where: null };
      if (index.unique === 1 && (index.origin === 'u' || index.origin === 'c')) unique_constraints.push(item);
      else indexes.push(item);
    }
    return { name, columns, primary_key, unique_constraints, foreign_keys, checks: [], indexes };
  });
  return { family: 'sqlite-v3.2-post-0003', catalog_version: 'v3.2.0-post-0003', tables };
}

export class SqliteV32Adapter {
  constructor({ source, destination, allowAnyTables = false, tempDirectory = null, cleanupTemp = false } = {}) {
    const real = sourceFile(source);
    if (destination && real === realpathSync.native(resolve(destination))) throw refusal('RMIG-E-SAME-SOURCE-TARGET', 'A source cannot also be its destination.', { source_kind: 'sqlite' });
    this.sourcePath = real;
    this.tempDirectory = tempDirectory;
    this.cleanupTemp = cleanupTemp;
    this.#allowAnyTables = allowAnyTables;
    this.#initial = { hash: hashFile(real), mtimeMs: statSync(real).mtimeMs, size: statSync(real).size };
    try {
      this.#db = new DatabaseSync(real, { readOnly: true });
    } catch (error) {
      throw refusal('RMIG-E-SOURCE-NOT-READONLY', 'SQLite source could not be opened read-only.', { source_kind: 'sqlite', reason: String(error?.code ?? 'open-failed') });
    }
    this.#snapshot = false;
    this.#closed = false;
  }

  #db;
  #allowAnyTables;
  #initial;
  #snapshot;
  #closed;

  identity() {
    return { kind: this.tempDirectory ? 'd1-export' : 'sqlite', source_path: this.sourcePath, source_sha256: this.#initial.hash, size: this.#initial.size, mtime_ms: this.#initial.mtimeMs };
  }

  catalog() { return buildCatalog(this.#db); }

  beginSnapshot() {
    if (this.#snapshot) return;
    try { this.#db.exec('BEGIN'); this.#snapshot = true; }
    catch (error) { throw refusal('RMIG-E-SOURCE-DRIFT', 'SQLite source snapshot could not be started.', { reason: String(error?.code ?? 'begin-failed') }); }
  }

  async *streamTable(table) {
    const allowed = this.#allowAnyTables ? new Set(this.catalog().tables.map(({ name }) => name)) : SQLITE_TABLES;
    if (!allowed.has(table)) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The requested table is not in the exact post-0003 SQLite catalog.', { table });
    for (const row of this.#db.prepare(`SELECT * FROM "${table}"`).iterate()) yield row;
  }

  rowCount(table) {
    const allowed = this.#allowAnyTables ? new Set(this.catalog().tables.map(({ name }) => name)) : SQLITE_TABLES;
    if (!allowed.has(table)) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The requested table is not allowlisted.', { table });
    return String(this.#db.prepare(`SELECT count(*) AS row_count FROM "${table}"`).get().row_count);
  }

  endSnapshot() {
    if (!this.#snapshot) return;
    try { this.#db.exec('ROLLBACK'); } finally { this.#snapshot = false; }
  }

  #assertUnchanged() {
    const current = statSync(this.sourcePath);
    if (current.size !== this.#initial.size || current.mtimeMs !== this.#initial.mtimeMs || hashFile(this.sourcePath) !== this.#initial.hash) throw refusal('RMIG-E-SOURCE-DRIFT', 'The SQLite source changed during read-only inspection.', { source_kind: this.identity().kind });
  }

  close() {
    let failure;
    try { this.endSnapshot(); } catch (error) { failure = error; }
    try { this.#db.close(); } catch (error) { failure ??= error; }
    try { this.#assertUnchanged(); } catch (error) { failure ??= error; }
    if (this.cleanupTemp && this.tempDirectory) {
      try { rmSync(this.tempDirectory, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    }
    this.#closed = true;
    if (failure) throw failure;
  }
}

export function createSqliteV32Adapter(options) {
  return assertSourceAdapter(new SqliteV32Adapter(options));
}

export { buildCatalog as sqliteCatalog };
