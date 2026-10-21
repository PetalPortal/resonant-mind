import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from './canonical-json.mjs';
import { canonicalSha256 } from './hash.mjs';
import { MigrationRefusal } from './refusal.mjs';

const CHECKPOINT_NAME = /^(?:source-inspected|bundle-member:.+|bundle-finalized|policy-compiled|target-prepared|stage-member:.+|dry-run-accepted|import-committed|images-complete|reembed-complete|validation-complete)$/u;
const RANKS = new Map([['source-inspected', 10], ['bundle-member', 20], ['bundle-finalized', 30], ['policy-compiled', 40], ['target-prepared', 50], ['stage-member', 60], ['dry-run-accepted', 70], ['import-committed', 80], ['images-complete', 90], ['reembed-complete', 100], ['validation-complete', 110]]);
function refuse(summary, details = {}) { return new MigrationRefusal({ code: 'RMIG-E-CHECKPOINT', phase: 'runtime', summary, safe_details: details, report_path: null }); }
function stateOf(name) { if (name.startsWith('bundle-member:')) return 'bundle-member'; if (name.startsWith('stage-member:')) return 'stage-member'; return name; }
function hashInput(entry) { const { checkpoint_sha256: _ignored, ...input } = entry; return input; }
function checkpointHash(entry) { return canonicalSha256(hashInput(entry)); }
function parseFile(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw refuse('Checkpoint receipt is truncated or invalid JSON.'); } }
function fileNames(dir) { try { return readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; } }
function validateTransition(previous, current) {
  const currentState = stateOf(current.name);
  if (!previous) return currentState === 'source-inspected' ? null : refuse('Checkpoint chain must begin with source inspection.');
  const previousState = stateOf(previous.name);
  const allowed = {
    'source-inspected': new Set(['bundle-member']),
    'bundle-member': new Set(['bundle-member', 'bundle-finalized']),
    'bundle-finalized': new Set(['policy-compiled']),
    'policy-compiled': new Set(['target-prepared']),
    'target-prepared': new Set(['stage-member']),
    'stage-member': new Set(['stage-member', 'dry-run-accepted']),
    'dry-run-accepted': new Set(['import-committed']),
    'import-committed': new Set(['images-complete']),
    'images-complete': new Set(['reembed-complete']),
    'reembed-complete': new Set(['validation-complete']),
  };
  if (!allowed[previousState]?.has(currentState)) throw refuse('Checkpoint chain skips a required semantic phase; restart the interrupted migration from a fresh target.');
  return null;
}
function validateEntry(entry, index, previous, expectedIdentity) {
  if (!entry || entry.sequence !== index + 1 || typeof entry.name !== 'string' || !CHECKPOINT_NAME.test(entry.name) || typeof entry.migration_id !== 'string' || typeof entry.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.artifact_sha256) || typeof entry.previous_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.previous_sha256) || typeof entry.checkpoint_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.checkpoint_sha256) || entry.checkpoint_sha256 !== checkpointHash(entry) || !entry.details || typeof entry.details !== 'object') throw refuse('Checkpoint hash chain is tampered or truncated.', { sequence: index + 1 });
  if (index === 0 ? entry.previous_sha256 !== '0'.repeat(64) : entry.previous_sha256 !== previous.checkpoint_sha256) throw refuse('Checkpoint hash chain is broken.', { sequence: index + 1 });
  if (expectedIdentity.migration_id !== undefined && entry.migration_id !== expectedIdentity.migration_id || expectedIdentity.artifact_sha256 !== undefined && entry.artifact_sha256 !== expectedIdentity.artifact_sha256) throw refuse('Checkpoint identity or artifact binding does not match the current migration.');
  validateTransition(previous, entry);
}
export function readCheckpointChain(dir, identity = {}) {
  const names = fileNames(dir); const files = names.filter((name) => /^\d{6}\.json$/u.test(name)); if (names.length !== files.length) throw refuse('Checkpoint directory contains an unexpected receipt file.');
  const chain = []; const seen = new Set(); for (let index = 0; index < files.length; index += 1) { if (files[index] !== `${String(index + 1).padStart(6, '0')}.json`) throw refuse('Checkpoint receipt numbering is truncated or has a gap.'); const entry = parseFile(join(dir, files[index])); if (seen.has(entry.name)) throw refuse('Checkpoint chain contains a duplicate phase receipt.'); validateEntry(entry, index, chain.at(-1), chain.at(-1) ?? identity); seen.add(entry.name); chain.push(entry); }
  const expectedTerminal = identity.expected_terminal ?? identity.expectedTerminal; if (expectedTerminal !== undefined && (chain.at(-1)?.name !== expectedTerminal && stateOf(chain.at(-1)?.name ?? '') !== stateOf(expectedTerminal))) throw refuse('Checkpoint chain does not end at the exact requested terminal phase.');
  return chain;
}
function writeExclusive(path, value) { const temp = `${path}.tmp-${process.pid}-${randomUUID()}`; let fd; try { fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); const bytes = Buffer.from(canonicalJson(value)); let offset = 0; while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) throw new Error('Checkpoint write made no progress.'); offset += count; } fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} } }
export function appendCheckpoint(dir, input, identity = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Checkpoint input must be an object.'); mkdirSync(dir, { recursive: true }); const chain = readCheckpointChain(dir, identity); const existing = chain.find((entry) => entry.name === input.name);
  const artifact = input.artifact_sha256 ?? identity.artifact_sha256; const migration = input.migration_id ?? identity.migration_id; if (typeof artifact !== 'string' || !/^[0-9a-f]{64}$/u.test(artifact) || typeof migration !== 'string') throw refuse('Checkpoint requires a migration identity and artifact hash.');
  if (existing) { if (existing.migration_id !== migration || existing.artifact_sha256 !== artifact || canonicalJson(existing.details) !== canonicalJson(input.details ?? {})) throw refuse('Checkpoint identity or artifact mismatch prevents resume.'); return existing; }
  const previous = chain.at(-1)?.checkpoint_sha256 ?? '0'.repeat(64); const candidate = { format_version: 1, sequence: chain.length + 1, name: input.name, migration_id: migration, artifact_sha256: artifact, previous_sha256: previous, details: input.details ?? {} }; validateTransition(chain.at(-1), candidate); candidate.checkpoint_sha256 = checkpointHash(candidate); writeExclusive(join(dir, `${String(candidate.sequence).padStart(6, '0')}.json`), candidate); return candidate;
}
export function maybeInjectCheckpointFault(name) { const requested = process.env.RM_MIGRATOR_FAULT_AFTER; if (requested === undefined) return; if (process.env.NODE_ENV !== 'test') throw refuse('Fault injection is available only when NODE_ENV=test.'); if (requested === name) throw new MigrationRefusal({ code: 'RMIG-E-CHECKPOINT-FAULT', phase: 'runtime', summary: 'Test-only fault injected after checkpoint.', safe_details: { checkpoint: name }, report_path: null }); }
export function resumeFromCheckpoints(dir, identity = {}) { const chain = readCheckpointChain(dir, identity); return chain.at(-1) ?? null; }
export function checkpointResumeState(dir, identity = {}) { const chain = readCheckpointChain(dir, identity); return { completed: chain.map(({ name }) => name), last: chain.at(-1) ?? null, next: chain.at(-1)?.name === 'validation-complete' ? null : chain.at(-1)?.name ?? 'source-inspected' }; }
export { checkpointHash, CHECKPOINT_NAME, stateOf };
