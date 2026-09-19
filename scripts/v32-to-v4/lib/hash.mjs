import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { types } from 'node:util';
import { canonicalJson } from './canonical-json.mjs';

const arraySort = Function.call.bind(Array.prototype.sort);

function defineArrayIndex(array, index, value) {
  Object.defineProperty(array, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function sha256Hex(input) {
  if (typeof input !== 'string' && !ArrayBuffer.isView(input)) {
    throw new TypeError('SHA-256 input must be a string or byte array.');
  }
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalSha256(value) {
  return sha256Hex(canonicalJson(value));
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_CHECKSUM_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function assertSafeBundleMemberPath(name, label = 'Bundle member path') {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name !== name.trim() ||
    name.startsWith('/') ||
    win32.isAbsolute(name) ||
    /^[a-z]:/iu.test(name) ||
    name.includes('\\') ||
    !SAFE_CHECKSUM_PATH.test(name)
  ) {
    throw new TypeError(`${label} must be a safe relative POSIX path.`);
  }

  let segmentStart = 0;
  while (segmentStart < name.length) {
    const slash = name.indexOf('/', segmentStart);
    const segmentEnd = slash === -1 ? name.length : slash;
    const segment = name.slice(segmentStart, segmentEnd);
    const dot = segment.indexOf('.');
    const basename = dot === -1 ? segment : segment.slice(0, dot);
    if (
      segment === '.' ||
      segment === '..' ||
      /[.]$/u.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(basename)
    ) {
      throw new TypeError(`${label} must be a safe relative POSIX path.`);
    }
    segmentStart = segmentEnd + 1;
  }
}

function checksumArrayLength(entries) {
  if (
    types.isProxy(entries) ||
    !Array.isArray(entries) ||
    Object.getPrototypeOf(entries) !== Array.prototype
  ) {
    throw new TypeError('Checksum entries must be a plain array.');
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(entries, 'length');
  const length = lengthDescriptor?.value;
  const keys = Reflect.ownKeys(entries);
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    keys.length !== length + 1 ||
    keys[length] !== 'length'
  ) {
    throw new TypeError('Checksum entries must be a dense array without extra properties.');
  }
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) {
      throw new TypeError('Checksum entries must be a dense array without extra properties.');
    }
  }
  return length;
}

function snapshotChecksumEntry(entry, index) {
  if (entry === null || typeof entry !== 'object' || types.isProxy(entry)) {
    throw new TypeError(`Checksum entry at index ${index} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(entry);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Checksum entry at index ${index} must be a plain object.`);
  }

  const keys = Reflect.ownKeys(entry);
  let nameDescriptor;
  let sha256Descriptor;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    if (
      typeof key !== 'string' ||
      (key !== 'name' && key !== 'sha256') ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(
        `Checksum entry at index ${index} must contain only enumerable name and sha256 data fields.`,
      );
    }
    if (key === 'name') {
      nameDescriptor = descriptor;
    } else {
      sha256Descriptor = descriptor;
    }
  }
  if (keys.length !== 2 || !nameDescriptor || !sha256Descriptor) {
    throw new TypeError(`Checksum entry at index ${index} must contain only name and sha256.`);
  }
  return { name: nameDescriptor.value, sha256: sha256Descriptor.value };
}

export function formatChecksumLines(entries) {
  const length = checksumArrayLength(entries);
  const seen = new Set();
  const seenWindowsFolded = new Map();
  const validated = [];
  for (let index = 0; index < length; index += 1) {
    const arrayDescriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!arrayDescriptor || !Object.hasOwn(arrayDescriptor, 'value')) {
      throw new TypeError(`Checksum entry at index ${index} must be a data property.`);
    }
    const { name, sha256 } = snapshotChecksumEntry(arrayDescriptor.value, index);
    assertSafeBundleMemberPath(name, 'Checksum name');
    if (seen.has(name)) {
      throw new TypeError(`Duplicate checksum name: ${name}.`);
    }
    seen.add(name);
    const windowsFoldedName = name.toLowerCase();
    const caseCollision = seenWindowsFolded.get(windowsFoldedName);
    if (caseCollision !== undefined) {
      throw new TypeError(`Checksum name case collision: ${caseCollision} and ${name}.`);
    }
    seenWindowsFolded.set(windowsFoldedName, name);
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new TypeError(`Invalid SHA-256 digest for ${name}.`);
    }
    defineArrayIndex(validated, index, { name, sha256 });
  }

  arraySort(validated, (left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  let output = '';
  for (let index = 0; index < validated.length; index += 1) {
    output += `${validated[index].sha256}  ${validated[index].name}\n`;
  }
  return output;
}
