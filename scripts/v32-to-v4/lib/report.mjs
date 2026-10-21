import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { canonicalJson } from './canonical-json.mjs';
import {
  assertExactKeys,
  assertPlainData,
  FORMAT_VERSION,
  reportHashInput,
  validateReport,
} from './contracts.mjs';
import { canonicalSha256 } from './hash.mjs';
import { redact } from './redact.mjs';

const CREATE_REPORT_KEYS = [
  'migrator_version',
  'phase',
  'timestamp',
  'migration_id',
  'status',
  'details',
];

function optionFields(options, allowed, label) {
  const fields = Object.create(null);
  if (options === undefined) {
    return fields;
  }
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(options);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new TypeError(`${label} contains an unknown option.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain only enumerable data fields.`);
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

export function reportArtifactHash(report) {
  return canonicalSha256(reportHashInput(report));
}

export function createReport(input, options = {}) {
  const fields = assertExactKeys(input, CREATE_REPORT_KEYS, 'Report input');
  const option = optionFields(options, ['environmentValues'], 'Report options');
  assertPlainData(fields.details);
  const report = {
    format_version: FORMAT_VERSION,
    migrator_version: fields.migrator_version,
    phase: fields.phase,
    timestamp: fields.timestamp,
    migration_id: fields.migration_id,
    status: fields.status,
    artifact_sha256: '0'.repeat(64),
    details: redact(fields.details, { environmentValues: option.environmentValues }),
  };
  report.artifact_sha256 = reportArtifactHash(report);
  validateReport(report);
  return report;
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function assertSafeDestination(filePath, overwrite) {
  if (typeof filePath !== 'string' || filePath.length === 0 || /[\u0000\r\n]/u.test(filePath)) {
    throw new TypeError('Report path must be a non-empty filesystem path.');
  }
  const destination = resolve(filePath);
  const parent = dirname(destination);
  const name = basename(destination);
  if (name === '.' || name === '..' || name.length === 0) {
    throw new TypeError('Report path must name a file.');
  }

  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    throw new TypeError(`Report parent directory is unavailable: ${error.code ?? 'unknown'}.`);
  }
  if (parentStat.isSymbolicLink()) {
    throw new TypeError('Report parent directory must not be a symlink.');
  }
  if (!parentStat.isDirectory()) {
    throw new TypeError('Report parent must be a directory.');
  }
  if (resolve(realpathSync.native(parent)) !== parent) {
    throw new TypeError('Report parent path must not traverse a symlink.');
  }

  let targetStat = null;
  try {
    targetStat = lstatSync(destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (targetStat?.isSymbolicLink()) {
    throw new TypeError('Report target must not be a symlink.');
  }
  if (targetStat && !targetStat.isFile()) {
    throw new TypeError('Report overwrite target must be a regular file, not a directory or special file.');
  }
  if (targetStat && !overwrite) {
    throw new Error('Report target already exists; explicit overwrite is required.');
  }
  return { destination, parent, name };
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error('Atomic report write made no progress.');
    }
    offset += written;
  }
}

function syncDirectory(parent) {
  let fd;
  try {
    fd = openSync(parent, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function writeReportAtomic(filePath, report, options = {}) {
  validateReport(report);
  const option = optionFields(options, ['overwrite', 'beforeRename'], 'Atomic report options');
  const overwrite = option.overwrite ?? false;
  if (typeof overwrite !== 'boolean') {
    throw new TypeError('Atomic report overwrite option must be boolean.');
  }
  if (option.beforeRename !== undefined && typeof option.beforeRename !== 'function') {
    throw new TypeError('Atomic report beforeRename option must be a function.');
  }

  const { destination, parent, name } = assertSafeDestination(filePath, overwrite);
  const lockPath = `${destination}.lock`;
  const tempPath = resolve(parent, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let lockFd;
  let tempFd;
  let renamed = false;
  let cleanupError;
  try {
    try {
      lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('Another writer already holds the exclusive report lock.');
      }
      throw error;
    }

    // Recheck after acquiring the lock so concurrent writers cannot bypass no-overwrite.
    assertSafeDestination(destination, overwrite);
    tempFd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeAll(tempFd, Buffer.from(canonicalJson(report), 'utf8'));
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    option.beforeRename?.({ destination, tempPath });
    renameSync(tempPath, destination);
    renamed = true;
    syncDirectory(parent);
    return destination;
  } finally {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (!renamed) {
      try {
        safeUnlink(tempPath);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        safeUnlink(lockPath);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}
