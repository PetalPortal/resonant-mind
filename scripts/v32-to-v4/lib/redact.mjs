import { types } from 'node:util';

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 100;
const MAX_CLASSIFIED_KEY_LENGTH = 256;
const MIN_ENVIRONMENT_SECRET_LENGTH = 8;
const SENSITIVE_KEY_SUFFIX = /(?:password|passphrase|secret|token|apikey|authorization|auth|pwd)$/u;
const SECRET_ENVIRONMENT_KEY_SUFFIX = /(?:password|passphrase|pwd|secret|token|apikey|authorization|auth|credential|credentials|databaseurl|dburl|postgresurl|postgresqlurl|connectionstring|dsn|privatekey|clientkey)$/u;
const URL_CANDIDATE = /\b[a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/)[^\s"'<>]+/giu;
const QUERY_PARAMETER = /([?&])([^=&#\s"'<>]+)=([^&#\s"'<>]*)/gu;
const POSTGRES_USER = /(password authentication failed for user\s+)["'][^"'\r\n]+["']/giu;
const TEXT_SECRET_LABEL = /^(?:user|dsn|databaseurl|dburl|postgresurl|postgresqlurl|connectionstring)$/u;

function defineArrayIndex(array, index, value) {
  Object.defineProperty(array, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function plainArrayValues(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('environmentValues must be a plain array or object of strings.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  const keys = Reflect.ownKeys(value);
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    keys.length !== length + 1 ||
    keys[length] !== 'length'
  ) {
    throw new TypeError('environmentValues must be a plain array or object of strings.');
  }
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) {
      throw new TypeError('environmentValues must be a plain array or object of strings.');
    }
  }

  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('environmentValues must not contain accessors.');
    }
    defineArrayIndex(values, index, descriptor.value);
  }
  return values;
}

function plainObjectValues(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('environmentValues must be a plain array or object of strings.');
  }

  const values = [];
  let valueCount = 0;
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key === 'symbol') {
      throw new TypeError('environmentValues must not contain symbol keys.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('environmentValues must not contain accessors.');
    }
    defineArrayIndex(values, valueCount, descriptor.value);
    valueCount += 1;
  }
  return values;
}

function environmentSecrets(environmentValues) {
  if (environmentValues === undefined) {
    return [];
  }
  if (
    environmentValues !== null &&
    typeof environmentValues === 'object' &&
    types.isProxy(environmentValues)
  ) {
    throw new TypeError('environmentValues must not be a proxy.');
  }

  const values = Array.isArray(environmentValues)
    ? plainArrayValues(environmentValues)
    : environmentValues !== null && typeof environmentValues === 'object'
      ? plainObjectValues(environmentValues)
      : null;

  if (values === null) {
    throw new TypeError('environmentValues must be an array or object of strings.');
  }

  const unique = new Set();
  const secrets = [];
  let secretCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'string') {
      throw new TypeError('environmentValues must be an array or object of strings.');
    }
    if (value.length === 0 || unique.has(value)) {
      continue;
    }
    unique.add(value);
    let insertionIndex = secretCount;
    while (insertionIndex > 0 && secrets[insertionIndex - 1].length < value.length) {
      defineArrayIndex(secrets, insertionIndex, secrets[insertionIndex - 1]);
      insertionIndex -= 1;
    }
    defineArrayIndex(secrets, insertionIndex, value);
    secretCount += 1;
  }
  return secrets;
}

function isSecretEnvironmentKey(key) {
  const normalized = key.slice(-MAX_CLASSIFIED_KEY_LENGTH).normalize('NFKC').toLowerCase();
  const finalToken = normalized.split(/[^a-z0-9]+/u).at(-1);
  return finalToken === 'pass' || SECRET_ENVIRONMENT_KEY_SUFFIX.test(secretSkeleton(key));
}

function defaultEnvironmentValues() {
  const values = [];
  let valueCount = 0;
  for (const key of Object.getOwnPropertyNames(process.env)) {
    if (!isSecretEnvironmentKey(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(process.env, key);
    const value = descriptor?.value;
    if (
      typeof value === 'string' &&
      value.length >= MIN_ENVIRONMENT_SECRET_LENGTH &&
      value.trim().length >= MIN_ENVIRONMENT_SECRET_LENGTH
    ) {
      defineArrayIndex(values, valueCount, value);
      valueCount += 1;
    }
  }
  return values;
}

function combinedEnvironmentSecrets(environmentValues) {
  const defaults = defaultEnvironmentValues();
  const explicit = environmentSecrets(environmentValues);
  const combined = [];
  for (let index = 0; index < defaults.length; index += 1) {
    defineArrayIndex(combined, combined.length, defaults[index]);
  }
  for (let index = 0; index < explicit.length; index += 1) {
    defineArrayIndex(combined, combined.length, explicit[index]);
  }
  return environmentSecrets(combined);
}

function safeOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Redaction options must be an object.');
  }
  if (types.isProxy(options)) {
    throw new TypeError('Redaction options must not be a proxy.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'environmentValues');
  if (descriptor && !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError('Redaction options must not contain accessors.');
  }
  return { environmentSecrets: combinedEnvironmentSecrets(descriptor?.value) };
}

function redactUrlUserinfo(value) {
  return value.replace(URL_CANDIDATE, (url) => {
    const escaped = url.includes(':\\/\\/');
    const separator = escaped ? ':\\/\\/' : '://';
    const schemeEnd = url.indexOf(separator) + separator.length;
    const authorityEndOffset = url.slice(schemeEnd).search(escaped ? /[\\/?#]/u : /[/?#]/u);
    const authorityEnd = authorityEndOffset === -1 ? url.length : schemeEnd + authorityEndOffset;
    const userinfoEnd = url.lastIndexOf('@', authorityEnd - 1);

    if (userinfoEnd < schemeEnd) {
      return url;
    }
    return `${url.slice(0, schemeEnd)}${REDACTED}@${url.slice(userinfoEnd + 1)}`;
  });
}

function redactQueryParameters(value) {
  return value.replace(QUERY_PARAMETER, (parameter, separator, rawKey, rawValue) => {
    const decodedKey = decodeQueryKey(rawKey);
    if (decodedKey === null) {
      return `${separator}${rawKey}=${REDACTED}`;
    }

    return isSensitiveKey(decodedKey)
      ? `${separator}${rawKey}=${REDACTED}`
      : `${separator}${rawKey}=${rawValue}`;
  });
}

function decodeQueryKey(rawKey) {
  let decoded = rawKey;
  for (let round = 0; round < 3; round += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) {
      return decoded;
    }
    decoded = next;
  }
  return decoded.includes('%') ? null : decoded;
}

function confusableAscii(character) {
  switch (character) {
    case 'а':
    case 'α':
      return 'a';
    case 'с':
    case 'ϲ':
      return 'c';
    case 'ԁ':
      return 'd';
    case 'е':
    case 'ε':
      return 'e';
    case 'һ':
      return 'h';
    case 'і':
    case 'ι':
      return 'i';
    case 'к':
    case 'κ':
      return 'k';
    case 'о':
    case 'ο':
      return 'o';
    case 'р':
    case 'ρ':
      return 'p';
    case 'г':
      return 'r';
    case 'ѕ':
      return 's';
    case 'т':
    case 'τ':
      return 't';
    case 'υ':
      return 'u';
    case 'ν':
      return 'n';
    case 'ω':
      return 'w';
    case 'х':
    case 'χ':
      return 'x';
    case 'у':
      return 'y';
    default:
      return null;
  }
}

function secretSkeleton(key) {
  const normalized = key.slice(-MAX_CLASSIFIED_KEY_LENGTH).normalize('NFKC').toLowerCase();
  let compact = '';
  for (const character of normalized) {
    if (
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9')
    ) {
      compact += character;
      continue;
    }
    const mapped = confusableAscii(character);
    if (mapped !== null) {
      compact += mapped;
    } else if (character.codePointAt(0) > 0x7f) {
      compact += '#';
    }
  }
  return compact;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_SUFFIX.test(secretSkeleton(key));
}

function isTextSecretLabel(label) {
  const compact = secretSkeleton(label);
  return isSensitiveKey(label) || TEXT_SECRET_LABEL.test(compact);
}

function lineEnd(value, start) {
  const carriageReturn = value.indexOf('\r', start);
  const lineFeed = value.indexOf('\n', start);
  if (carriageReturn === -1) {
    return lineFeed === -1 ? value.length : lineFeed;
  }
  if (lineFeed === -1) {
    return carriageReturn;
  }
  return Math.min(carriageReturn, lineFeed);
}

function consumeCredential(value, start) {
  if (value[start] === '"' || value[start] === "'") {
    const quote = value[start];
    const endOfLine = lineEnd(value, start);
    for (let index = start + 1; index < endOfLine; index += 1) {
      if (value[index] === '\\') {
        index += 1;
      } else if (value[index] === quote) {
        return index + 1;
      }
    }
    return endOfLine;
  }

  let end = start;
  while (end < value.length && !/[\s,;&#]/u.test(value[end])) {
    end += 1;
  }
  return end;
}

function isLabelCharacter(character) {
  return character !== undefined && /[\p{L}\p{N}\p{Pc}\p{Pd}_-]/u.test(character);
}

function authorizationLabel(label) {
  return secretSkeleton(label).endsWith('authorization');
}

function assignedLabelAt(value, start) {
  if (start > 0 && isLabelCharacter(value[start - 1])) {
    return null;
  }

  const quote = value[start] === '"' || value[start] === "'" ? value[start] : '';
  let cursor = start + (quote ? 1 : 0);
  const labelStart = cursor;
  while (cursor < value.length && cursor - labelStart < 128 && isLabelCharacter(value[cursor])) {
    cursor += 1;
  }
  if (cursor === labelStart || (isLabelCharacter(value[cursor]) && cursor - labelStart === 128)) {
    return null;
  }
  const label = value.slice(labelStart, cursor);
  if (quote) {
    if (value[cursor] !== quote) {
      return null;
    }
    cursor += 1;
  }
  while (value[cursor] === ' ' || value[cursor] === '\t') {
    cursor += 1;
  }
  if (value[cursor] !== ':' && value[cursor] !== '=') {
    return null;
  }
  cursor += 1;
  while (value[cursor] === ' ' || value[cursor] === '\t') {
    cursor += 1;
  }
  return { label, valueStart: cursor };
}

function redactAssignedCredentials(value) {
  let output = '';
  let cursor = 0;
  let scan = 0;
  while (scan < value.length) {
    const assignment = assignedLabelAt(value, scan);
    if (!assignment || !isTextSecretLabel(assignment.label)) {
      scan += 1;
      continue;
    }

    let credentialStart = assignment.valueStart;
    let replacement = REDACTED;
    const quote = value[credentialStart] === '"' || value[credentialStart] === "'"
      ? value[credentialStart]
      : '';
    if (!quote && authorizationLabel(assignment.label)) {
      const schemeMatch = /^(bearer|basic)([ \t]+)/iu.exec(value.slice(credentialStart));
      if (schemeMatch) {
        replacement = `${schemeMatch[1]} ${REDACTED}`;
        credentialStart += schemeMatch[0].length;
      }
    }

    const credentialEnd = consumeCredential(value, credentialStart);
    if (quote) {
      const closed = value[credentialEnd - 1] === quote;
      replacement = `${quote}${REDACTED}${closed ? quote : ''}`;
    }
    output += value.slice(cursor, assignment.valueStart) + replacement;
    cursor = credentialEnd;
    scan = credentialEnd;
  }
  return output + value.slice(cursor);
}

function redactTextWithSecrets(value, secrets) {
  if (typeof value !== 'string') {
    throw new TypeError('Text to redact must be a string.');
  }

  let output = value;
  for (let index = 0; index < secrets.length; index += 1) {
    const secret = secrets[index];
    output = output.split(secret).join(REDACTED);
  }

  output = redactAssignedCredentials(output);
  output = redactUrlUserinfo(output);
  output = redactQueryParameters(output);
  return output.replace(POSTGRES_USER, `$1"${REDACTED}"`);
}

export function redactText(value, options = {}) {
  const validatedOptions = safeOptions(options);
  return redactTextWithSecrets(value, validatedOptions.environmentSecrets);
}

function redactValue(value, options, ancestors, path, depth) {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`Maximum redaction depth of ${MAX_DEPTH} exceeded at ${path}.`);
  }
  if (typeof value === 'string') {
    return redactTextWithSecrets(value, options.environmentSecrets);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported value for redaction at ${path}.`);
  }
  if (types.isProxy(value)) {
    throw new TypeError(`Unsupported proxy for redaction at ${path}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Cycle detected during redaction at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`Unsupported non-plain array at ${path}.`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      const keys = Reflect.ownKeys(value);
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        keys.length !== length + 1 ||
        keys[length] !== 'length'
      ) {
        throw new TypeError(`Unsupported sparse or extended array at ${path}.`);
      }
      for (let index = 0; index < length; index += 1) {
        if (keys[index] !== String(index)) {
          throw new TypeError(`Unsupported sparse or extended array at ${path}.`);
        }
      }
      const output = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`Unsupported accessor for redaction at ${path}[${index}].`);
        }
        defineArrayIndex(output, index, redactValue(
          descriptor.value,
          options,
          ancestors,
          `${path}[${index}]`,
          depth + 1,
        ));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Unsupported non-plain object for redaction at ${path}.`);
    }

    const output = Object.create(null);
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key === 'symbol') {
        throw new TypeError(`Unsupported symbol key for redaction at ${path}.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        continue;
      }
      if (!Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`Unsupported accessor for redaction at ${path}.${key}.`);
      }
      output[key] = isSensitiveKey(key)
        ? REDACTED
        : redactValue(descriptor.value, options, ancestors, `${path}.${key}`, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function redact(value, options = {}) {
  const validatedOptions = safeOptions(options);
  return redactValue(value, validatedOptions, new WeakSet(), '$', 0);
}
