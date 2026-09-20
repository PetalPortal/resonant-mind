import { MigrationRefusal } from './refusal.mjs';

const WORD = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const SAFE_PRAGMAS = new Set(['foreign_keys', 'defer_foreign_keys', 'recursive_triggers', 'legacy_alter_table']);
const SAFE_PRAGMA_VALUES = new Set(['on', 'off', 'true', 'false', '0', '1']);
const BANNED_WORDS = new Set(['attach', 'detach', 'vacuum', 'load_extension', 'loadextension']);

function unsafe(summary, details = {}) {
  return new MigrationRefusal({
    code: 'RMIG-E-D1-SQL-UNSAFE',
    phase: 'inspect-source',
    summary,
    safe_details: details,
    report_path: null,
  });
}

function pushToken(tokens, kind, value) {
  tokens.push({ kind, value });
}

export function tokenizeSql(sql) {
  if (typeof sql !== 'string' || sql.includes('\u0000')) throw unsafe('The D1 SQL export contains invalid SQL text.');
  const statements = [];
  let tokens = [];
  let statementStart = 0;
  let index = 0;
  const finish = (end) => {
    const text = sql.slice(statementStart, end);
    if (tokens.length > 0) statements.push({ text, tokens });
    tokens = [];
    statementStart = end + 1;
  };
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      index += 2;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '*' && sql[index + 1] === '/') { index += 2; closed = true; break; }
        index += 1;
      }
      if (!closed) throw unsafe('The D1 SQL export contains an unterminated comment.');
      continue;
    }
    if (char === ';') { finish(index); index += 1; statementStart = index; continue; }
    if (char === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { index += 2; continue; }
          index += 1; closed = true; break;
        }
        index += 1;
      }
      if (!closed) throw unsafe('The D1 SQL export contains an unterminated string literal.');
      pushToken(tokens, 'string', sql.slice(start, index));
      continue;
    }
    if (char === '"' || char === '`') {
      const quote = char;
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { index += 2; continue; }
          index += 1; closed = true; break;
        }
        index += 1;
      }
      if (!closed) throw unsafe('The D1 SQL export contains an unterminated quoted identifier.');
      pushToken(tokens, 'identifier', sql.slice(start, index));
      continue;
    }
    if (char === '[') {
      const start = index;
      index += 1;
      const close = sql.indexOf(']', index);
      if (close < 0) throw unsafe('The D1 SQL export contains an unterminated quoted identifier.');
      index = close + 1;
      pushToken(tokens, 'identifier', sql.slice(start, index));
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/u);
    if (word) {
      pushToken(tokens, 'word', word[0]);
      index += word[0].length;
      continue;
    }
    const number = sql.slice(index).match(/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/u);
    if (number) {
      pushToken(tokens, 'number', number[0]);
      index += number[0].length;
      continue;
    }
    pushToken(tokens, 'punctuation', char);
    index += 1;
  }
  if (tokens.length > 0) statements.push({ text: sql.slice(statementStart), tokens });
  return statements;
}

function word(token) {
  return token?.kind === 'word' ? token.value.toLowerCase() : null;
}

function isIdentifier(token) {
  return token?.kind === 'word' && WORD.test(token.value) || token?.kind === 'identifier';
}

function assertUnqualifiedIdentifier(tokens, index, label) {
  if (!isIdentifier(tokens[index])) throw unsafe(`The D1 SQL export contains an invalid ${label}.`);
  if (tokens[index + 1]?.value === '.') throw unsafe('The D1 SQL export cannot address another SQLite schema.', { capability: 'qualified-identifier' });
  return index + 1;
}

function rejectBanned(tokens) {
  for (const token of tokens) {
    const value = word(token);
    if (BANNED_WORDS.has(value)) throw unsafe('The D1 SQL export contains a refused external-I/O or extension capability.', { capability: value });
  }
}

function validatePragma(tokens) {
  if (!SAFE_PRAGMAS.has(word(tokens[1]))) throw unsafe('The D1 SQL export contains a refused PRAGMA capability.', { capability: 'pragma' });
  if (tokens[2]?.value === '.') throw unsafe('The D1 SQL export cannot address a schema-qualified PRAGMA.');
  if (tokens.length < 4 || tokens[2].value !== '=' || tokens.length !== 4 || !SAFE_PRAGMA_VALUES.has(word(tokens[3]))) {
    throw unsafe('The D1 SQL export contains a PRAGMA form that may target external state.', { capability: 'pragma-assignment' });
  }
}

function validateTransaction(tokens) {
  const first = word(tokens[0]);
  if (first === 'begin') {
    if (tokens.length > 4 || (tokens[1] && !['transaction', 'deferred', 'immediate'].includes(word(tokens[1]))) || (tokens[2] && !['deferred', 'immediate'].includes(word(tokens[2])))) throw unsafe('The D1 SQL export contains an unsupported transaction form.');
    return;
  }
  if (first === 'commit' || first === 'end' || first === 'rollback') {
    if (tokens.length > 2 || (tokens[1] && word(tokens[1]) !== 'transaction')) throw unsafe('The D1 SQL export contains an unsupported transaction form.');
    return;
  }
}

function validateCreate(tokens) {
  let index = 1;
  if (word(tokens[index]) === 'unique') index += 1;
  if (word(tokens[index]) === 'if') {
    if (word(tokens[index + 1]) !== 'not' || word(tokens[index + 2]) !== 'exists') throw unsafe('The D1 SQL export contains an invalid CREATE form.');
    index += 3;
  }
  const kind = word(tokens[index]);
  if (kind !== 'table' && kind !== 'index') throw unsafe('The D1 SQL export contains an unsupported CREATE capability.', { capability: kind ?? 'unknown' });
  index += 1;
  index = assertUnqualifiedIdentifier(tokens, index, 'CREATE target');
  if (kind === 'index') {
    if (word(tokens[index]) !== 'on') throw unsafe('The D1 SQL export contains an invalid CREATE INDEX form.');
    index += 1;
    index = assertUnqualifiedIdentifier(tokens, index, 'index table');
  }
  if (tokens.slice(index).some((token) => ['as', 'select', 'using', 'virtual'].includes(word(token)))) throw unsafe('The D1 SQL export contains a refused schema escape form.');
  if (!tokens.slice(index).some((token) => token.value === '(')) throw unsafe('The D1 SQL export contains an invalid schema statement.');
}

function validateAlter(tokens) {
  if (word(tokens[1]) !== 'table') throw unsafe('The D1 SQL export contains an unsupported ALTER capability.');
  let index = assertUnqualifiedIdentifier(tokens, 2, 'ALTER target');
  if (word(tokens[index]) !== 'add' || word(tokens[index + 1]) !== 'column') throw unsafe('The D1 SQL export contains an unsupported ALTER form.');
  if (!isIdentifier(tokens[index + 2])) throw unsafe('The D1 SQL export contains an invalid ALTER column.');
}

function validateDrop(tokens) {
  if (word(tokens[1]) !== 'table') throw unsafe('The D1 SQL export contains an unsupported DROP capability.');
  let index = 2;
  if (word(tokens[index]) === 'if') index += 2;
  assertUnqualifiedIdentifier(tokens, index, 'DROP target');
}

function validateInsert(tokens) {
  const first = word(tokens[0]);
  let index = 1;
  if (first === 'insert' && word(tokens[index]) === 'or') index += 2;
  if (word(tokens[index]) !== 'into') throw unsafe('The D1 SQL export contains an invalid INSERT form.');
  index = assertUnqualifiedIdentifier(tokens, index + 1, 'INSERT target');
  if (tokens.slice(index).some((token) => ['select', 'returning', 'attach', 'detach'].includes(word(token)))) throw unsafe('The D1 SQL export contains a refused INSERT capability.');
  if (!tokens.slice(index).some((token) => word(token) === 'values')) throw unsafe('The D1 SQL export contains an INSERT without VALUES.');
}

export function validateD1Sql(sql) {
  const statements = tokenizeSql(sql);
  for (const statement of statements) {
    rejectBanned(statement.tokens);
    const first = word(statement.tokens[0]);
    if (!first) continue;
    if (['begin', 'commit', 'end', 'rollback'].includes(first)) validateTransaction(statement.tokens);
    else if (first === 'pragma') validatePragma(statement.tokens);
    else if (first === 'create') validateCreate(statement.tokens);
    else if (first === 'alter') validateAlter(statement.tokens);
    else if (first === 'drop') validateDrop(statement.tokens);
    else if (first === 'insert' || first === 'replace') validateInsert(statement.tokens);
    else throw unsafe('The D1 SQL export contains an unsupported SQL statement.', { statement: first });
  }
  return statements;
}
