import { createRequire } from 'node:module';
import { canonicalSha256 } from '../lib/hash.mjs';
import { redactText } from '../lib/redact.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { sourceSpecFor } from '../lib/fingerprint.mjs';
import { assertSourceAdapter } from './adapter.mjs';

const require = createRequire(import.meta.url);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SCHEMA = 'public';
const TABLES = new Set(sourceSpecFor('postgres').tables.map(({ name }) => name));

export const POSTGRES_CATALOG_QUERIES = Object.freeze({
  columns: `SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS column_default, a.attnum AS ordinal_position FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
  constraints: `SELECT c.conname AS constraint_name, c.contype AS constraint_type, rel.relname AS table_name, array_agg(att.attname ORDER BY key.ord) AS columns, refrel.relname AS referenced_table, array_agg(refatt.attname ORDER BY key.ord) AS referenced_columns, c.confdeltype AS delete_action, c.confupdtype AS update_action FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_catalog.pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = key.attnum LEFT JOIN pg_catalog.pg_class refrel ON refrel.oid = c.confrelid LEFT JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS refkey(attnum, ord) ON refkey.ord = key.ord LEFT JOIN pg_catalog.pg_attribute refatt ON refatt.attrelid = c.confrelid AND refatt.attnum = refkey.attnum WHERE n.nspname = $1 AND c.contype IN ('p', 'u', 'f') GROUP BY c.conname, c.contype, rel.relname, refrel.relname, c.confdeltype, c.confupdtype ORDER BY rel.relname, c.conname`,
  checks: `SELECT c.conname AS constraint_name, rel.relname AS table_name, pg_get_constraintdef(c.oid) AS expression FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace WHERE n.nspname = $1 AND c.contype = 'c' ORDER BY rel.relname, c.conname`,
  indexes: `SELECT tab.relname AS table_name, idx.relname AS index_name, i.indisunique AS is_unique, am.amname AS index_method, pg_get_indexdef(i.indexrelid) AS definition, pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid JOIN pg_catalog.pg_class tab ON tab.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = tab.relnamespace JOIN pg_catalog.pg_am am ON am.oid = idx.relam WHERE n.nspname = $1 ORDER BY tab.relname, idx.relname`,
  identity: `SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port, current_setting('server_version_num') AS server_version`,
  embeddings: `SELECT source_type, count(*)::text AS row_count FROM public.embeddings GROUP BY source_type ORDER BY source_type`,
});

function refusal(code, summary, safeDetails = {}) {
  return new MigrationRefusal({ code, phase: 'inspect-source', summary, safe_details: safeDetails, report_path: null });
}

export function parseEnvReference(value) {
  if (typeof value !== 'string' || !value.startsWith('env:')) throw refusal('RMIG-E-SOURCE-ARG', 'PostgreSQL sources must use an env:NAME reference.');
  const name = value.slice(4);
  if (!ENV_NAME.test(name)) throw refusal('RMIG-E-SOURCE-ARG', 'The PostgreSQL environment reference name is invalid.', { reference: 'env:NAME' });
  return name;
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new TypeError('PostgreSQL identifier is not allowlisted.');
  return `"${value}"`;
}

function qualifiedTable(value) {
  return `${quoteIdentifier(SCHEMA)}.${quoteIdentifier(value)}`;
}

function actionName(value) {
  return ({ c: 'CASCADE', n: 'NO ACTION', r: 'RESTRICT', a: 'NO ACTION', d: 'SET DEFAULT', })[value] ?? 'NO ACTION';
}

function matchingParen(text, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote && text[index + 1] === quote) { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote && text[index + 1] === quote) { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function unquoteIdentifier(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('`') && trimmed.endsWith('`'))) return trimmed.slice(1, -1).replaceAll(trimmed[0] + trimmed[0], trimmed[0]);
  return trimmed;
}

export function parseIndexDefinition(definition) {
  if (typeof definition !== 'string') return { columns: [], expressions: [], opclass: null, where: null, options: null };
  const using = definition.match(/\bUSING\s+([A-Za-z_][A-Za-z0-9_]*)\s*/iu);
  const open = using ? definition.indexOf('(', using.index + using[0].length) : definition.indexOf('(');
  const close = open < 0 ? -1 : matchingParen(definition, open);
  if (open < 0 || close < 0) return { columns: [], expressions: [], opclass: null, where: null, options: null };
  const columns = [];
  const expressions = [];
  let opclass = null;
  for (const rawPart of splitTopLevel(definition.slice(open + 1, close))) {
    const part = rawPart.replace(/\s+(?:ASC|DESC)\b(?:\s+NULLS\s+(?:FIRST|LAST))?\s*$/iu, '').trim();
    const opclassMatch = part.match(/^(.*?)(?:\s+([A-Za-z_][A-Za-z0-9_]*))$/u);
    const expression = (opclassMatch ? opclassMatch[1] : part).trim();
    const candidateOpclass = opclassMatch?.[2] ?? null;
    const normalized = unquoteIdentifier(expression);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized) || /^"(?:[^"]|"")+"$/u.test(expression)) columns.push(normalized);
    else expressions.push(normalized);
    if (candidateOpclass && /_ops$/iu.test(candidateOpclass)) opclass ??= candidateOpclass.toLowerCase();
  }
  const rest = definition.slice(close + 1);
  const optionsMatch = rest.match(/\bWITH\s*\((.*)\)/iu);
  const options = optionsMatch ? splitTopLevel(optionsMatch[1]).map((entry) => entry.trim().replace(/\s*=\s*/u, ' = ')).join(', ') : null;
  const whereMatch = rest.match(/\bWHERE\s+(.+?)(?:\s+WITH\s*\(|$)/iu);
  return { columns, expressions, opclass, where: whereMatch?.[1]?.trim() ?? null, options };
}

function buildCatalog(columnRows, constraintRows, checkRows, indexRows) {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, { name, columns: [], primary_key: [], unique_constraints: [], foreign_keys: [], checks: [], indexes: [] });
    return tables.get(name);
  };
  for (const row of columnRows) {
    table(row.table_name).columns.push({ name: row.column_name, type: String(row.data_type).toLowerCase(), nullable: !row.not_null, default: row.column_default ?? null, pk_position: 0 });
  }
  for (const row of constraintRows) {
    const target = table(row.table_name);
    const columns = Array.isArray(row.columns) ? row.columns : [];
    if (row.constraint_type === 'p') {
      target.primary_key = columns;
      columns.forEach((name, index) => { const column = target.columns.find((item) => item.name === name); if (column) column.pk_position = index + 1; });
    } else if (row.constraint_type === 'u') {
      target.unique_constraints.push({ name: row.constraint_name, unique: true, columns, where: null });
    } else if (row.constraint_type === 'f') {
      target.foreign_keys.push({ name: row.constraint_name, columns, references: { table: row.referenced_table, columns: row.referenced_columns ?? [] }, on_delete: actionName(row.delete_action), on_update: actionName(row.update_action) });
    }
  }
  for (const row of checkRows) table(row.table_name).checks.push({ name: row.constraint_name, expression: row.expression });
  for (const row of indexRows) {
    const parsed = parseIndexDefinition(row.definition);
    const method = row.index_method ? String(row.index_method).toLowerCase() : null;
    const index = {
      name: row.index_name,
      unique: Boolean(row.is_unique),
      columns: parsed.columns,
      where: row.predicate ?? parsed.where,
      ...(parsed.expressions.length > 0 ? { expressions: parsed.expressions } : {}),
      ...(method && method !== 'btree' ? { method } : {}),
      ...(parsed.opclass ? { opclass: parsed.opclass } : {}),
      ...(parsed.options ? { options: parsed.options } : {}),
    };
    table(row.table_name).indexes.push(index);
  }
  return { family: 'postgres-v3.2.0', catalog_version: 'v3.2.0', tables: [...tables.values()] };
}

export class PostgresV32Adapter {
  constructor({ source, env = process.env, clientFactory, batchSize = 1000 } = {}) {
    const name = parseEnvReference(source);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw refusal('RMIG-E-SOURCE-ARG', 'The PostgreSQL batch size is invalid.', { batch_size: '1-10000' });
    const value = env?.[name];
    if (typeof value !== 'string' || value.length === 0) throw refusal('RMIG-E-SOURCE-ARG', 'The PostgreSQL environment variable is unset or empty.', { reference: `env:${name}` });
    this.sourceReference = `env:${name}`;
    this.#connectionString = value;
    this.#clientFactory = clientFactory ?? ((connectionString) => {
      const { Client } = require('pg');
      return new Client({ connectionString });
    });
    this.#batchSize = batchSize;
    this.#client = null;
    this.#snapshot = false;
    this.#transactionStarted = false;
    this.#closed = false;
  }

  #connectionString;
  #clientFactory;
  #client;
  #batchSize;
  #snapshot;
  #transactionStarted;
  #closed;

  async #clientOrConnect() {
    if (this.#closed) throw new Error('PostgreSQL source adapter is closed.');
    if (!this.#client) {
      this.#client = this.#clientFactory(this.#connectionString);
      await this.#client.connect();
    }
    return this.#client;
  }

  async #query(text, values = []) {
    if (!/^(?:SELECT|SHOW|BEGIN|ROLLBACK)\b/iu.test(text.trim())) throw new Error('PostgreSQL source query is not read-only allowlisted SQL.');
    try { return await (await this.#clientOrConnect()).query(text, values); }
    catch (error) {
      throw refusal('RMIG-E-SOURCE-DRIFT', 'PostgreSQL source inspection failed.', { operation: 'read-only catalog query', reason: redactText(error?.message ?? 'database error') });
    }
  }

  async identity() {
    const result = await this.#query(POSTGRES_CATALOG_QUERIES.identity);
    const row = result.rows[0] ?? {};
    const stable = { database_name: row.database_name ?? null, server_address: row.server_address ?? null, server_port: row.server_port ?? null, server_version: row.server_version ?? null };
    return { kind: 'postgres', source_reference: this.sourceReference, host: '[REDACTED]', port: '[REDACTED]', database: '[REDACTED]', server_identity_sha256: canonicalSha256({ server_address: stable.server_address, server_port: stable.server_port, server_version: stable.server_version }), database_identity_sha256: canonicalSha256(stable), };
  }

  async catalog() {
    const [columns, constraints, checks, indexes] = await Promise.all([
      this.#query(POSTGRES_CATALOG_QUERIES.columns, [SCHEMA]),
      this.#query(POSTGRES_CATALOG_QUERIES.constraints, [SCHEMA]),
      this.#query(POSTGRES_CATALOG_QUERIES.checks, [SCHEMA]),
      this.#query(POSTGRES_CATALOG_QUERIES.indexes, [SCHEMA]),
    ]);
    return buildCatalog(columns.rows, constraints.rows, checks.rows, indexes.rows);
  }

  async beginSnapshot() {
    if (this.#snapshot) return;
    await this.#query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    this.#transactionStarted = true;
    try {
      const result = await this.#query('SHOW transaction_read_only');
      if (String(result.rows[0]?.transaction_read_only).toLowerCase() !== 'on') throw refusal('RMIG-E-SOURCE-NOT-READONLY', 'PostgreSQL did not confirm a read-only transaction.');
      this.#snapshot = true;
    } catch (error) {
      await this.endSnapshot();
      throw error;
    }
  }

  async *streamTable(table, primaryKey = undefined) {
    if (!TABLES.has(table)) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The requested table is not in the exact public v3.2 catalog.', { table });
    const catalogTable = sourceSpecFor('postgres').tables.find((item) => item.name === table);
    const order = primaryKey ?? catalogTable?.primary_key ?? [];
    if (!Array.isArray(order) || order.length === 0 || order.some((column) => !catalogTable?.primary_key.includes(column))) throw refusal('RMIG-E-BUNDLE-INTEGRITY', 'The requested table order is not its exact primary key.', { table });
    const qualified = qualifiedTable(table);
    const orderBy = order.map((column) => `${qualified}.${quoteIdentifier(column)}`).join(', ');
    let previous;
    for (;;) {
      const values = [];
      let where = '';
      if (previous !== undefined) {
        const placeholders = order.map((_column, index) => `$${index + 1}`);
        values.push(...order.map((column) => previous[column]));
        where = ` WHERE (${order.map((column) => `${qualified}.${quoteIdentifier(column)}`).join(', ')}) > (${placeholders.join(', ')})`;
      }
      values.push(this.#batchSize);
      const limitPlaceholder = `$${values.length}`;
      const result = await this.#query(`SELECT * FROM ${qualified}${where} ORDER BY ${orderBy} LIMIT ${limitPlaceholder}`, values);
      if (result.rows.length === 0) break;
      for (const row of result.rows) yield row;
      previous = result.rows[result.rows.length - 1];
      if (result.rows.length < this.#batchSize) break;
    }
  }

  async rowCount(table) {
    if (!TABLES.has(table)) throw refusal('RMIG-E-SOURCE-FINGERPRINT', 'The requested table is not allowlisted.', { table });
    const result = await this.#query(`SELECT count(*)::text AS row_count FROM ${qualifiedTable(table)}`);
    return String(result.rows[0]?.row_count ?? '0');
  }

  async embeddingInventory() {
    try { return (await this.#query(POSTGRES_CATALOG_QUERIES.embeddings)).rows.map((row) => ({ source_type: row.source_type, row_count: String(row.row_count) })); }
    catch (error) {
      if (error?.code === '42P01') return [];
      throw error;
    }
  }

  async endSnapshot() {
    if (!this.#client || !this.#transactionStarted) return;
    try { await this.#query('ROLLBACK'); }
    finally { this.#snapshot = false; this.#transactionStarted = false; }
  }

  async close() {
    let failure;
    try { await this.endSnapshot(); } catch (error) { failure = error; }
    if (this.#client) {
      try { await this.#client.end(); } catch (error) { failure ??= error; }
    }
    this.#closed = true;
    if (failure) throw failure;
  }
}

export function createPostgresV32Adapter(options) {
  const adapter = new PostgresV32Adapter(options);
  return assertSourceAdapter(adapter);
}
