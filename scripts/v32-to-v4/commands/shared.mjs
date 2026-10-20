import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

/** A structured refusal for a bad option or a missing input. */
export function refuseArgument(phase, summary, code = 'RMIG-E-SOURCE-ARG', safeDetails = {}) {
  return new MigrationRefusal({ code, phase, summary, safe_details: safeDetails, report_path: null });
}

/**
 * Parses `--name value` options against a table. Every option is single-use, takes exactly one value that
 * does not itself start with `--` (a listed switch takes none and is true when present), and must be listed; `required` options must be present. Nothing is
 * defaulted here and an unknown option is a refusal, never ignored.
 */
export function parseOptions(phase, argv, { required = [], optional = [], switches = [] } = {}) {
  const allowed = new Set([...required, ...optional, ...switches]);
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw refuseArgument(phase, `${phase} accepts only its documented options; run --help for usage.`);
    if (switches.includes(key)) {
      if (values[key] !== undefined) throw refuseArgument(phase, `${phase} option ${key} may be supplied only once.`);
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw refuseArgument(phase, `${phase} requires one value for ${key}.`);
    if (values[key] !== undefined) throw refuseArgument(phase, `${phase} option ${key} may be supplied only once.`);
    values[key] = value;
    index += 1;
  }
  const missing = required.filter((key) => values[key] === undefined);
  if (missing.length > 0) throw refuseArgument(phase, `${phase} requires ${required.join(', ')}.`, 'RMIG-E-SOURCE-ARG', { missing });
  return values;
}

export function readJsonFile(phase, path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw refuseArgument(phase, `${label} is missing or is not valid JSON.`); }
}

/**
 * Publishes a finished temporary file at `path` without ever replacing what is there: a hard link fails
 * with EEXIST if the path exists (renameSync would silently overwrite it), and the temporary name is then
 * removed. On a filesystem with no hard links the content is copied into an exclusively created file.
 */
export function publishNew(phase, temporary, path) {
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      try { unlinkSync(temporary); } catch { /* the refusal is the point */ }
      throw refuseArgument(phase, 'The output file already exists; this command never overwrites an earlier artifact. Choose a new path.');
    }
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP'].includes(error?.code)) { try { unlinkSync(temporary); } catch { /* the original error matters */ } throw error; }
    const bytes = readFileSync(temporary);
    let descriptor;
    try { descriptor = openSync(path, 'wx', 0o600); } catch (openError) {
      try { unlinkSync(temporary); } catch { /* the refusal is the point */ }
      if (openError?.code === 'EEXIST') throw refuseArgument(phase, 'The output file already exists; this command never overwrites an earlier artifact. Choose a new path.');
      throw openError;
    }
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset); } finally { closeSync(descriptor); }
  }
  try { unlinkSync(temporary); } catch { /* a leftover temporary name is harmless */ }
}

/**
 * Writes bytes with owner-only permissions, via a temporary file, and never over an existing file.
 * Every command that produces an artifact goes through here (or through an exclusive create of its own).
 */
export function writeBytesNew(phase, path, bytes) {
  if (existsSync(path)) throw refuseArgument(phase, 'The output file already exists; this command never overwrites an earlier artifact. Choose a new path.');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  } catch (error) {
    closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* the write error is the one that matters */ }
    throw error;
  }
  closeSync(descriptor);
  publishNew(phase, temporary, path);
}

/**
 * Writes JSON (canonical, or indented for a file a person will read) with owner-only permissions, via a
 * temporary file, and never over an existing file. The hashes in the artifacts are over their content, so
 * indentation never matters to them.
 */
export function writeJsonNew(phase, path, value, { pretty = false } = {}) {
  const text = pretty ? `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}
` : canonicalJson(value);
  writeBytesNew(phase, path, Buffer.from(text, 'utf8'));
}
