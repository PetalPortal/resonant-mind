import { types } from 'node:util';

const MAX_DEPTH = 100;
const HEX = '0123456789abcdef';
const arraySort = Function.call.bind(Array.prototype.sort);

function defineArrayIndex(array, index, value) {
  Object.defineProperty(array, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function unsupported(path, detail) {
  throw new TypeError(`Unsupported value at ${path}: ${detail}.`);
}

function unicodeEscape(code) {
  return `\\u${HEX[(code >>> 12) & 0xf]}${HEX[(code >>> 8) & 0xf]}${HEX[(code >>> 4) & 0xf]}${HEX[code & 0xf]}`;
}

function quoteString(value) {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) {
      output += '\\"';
    } else if (code === 0x5c) {
      output += '\\\\';
    } else if (code === 0x08) {
      output += '\\b';
    } else if (code === 0x0c) {
      output += '\\f';
    } else if (code === 0x0a) {
      output += '\\n';
    } else if (code === 0x0d) {
      output += '\\r';
    } else if (code === 0x09) {
      output += '\\t';
    } else if (code < 0x20) {
      output += unicodeEscape(code);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += unicodeEscape(code);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += unicodeEscape(code);
    } else {
      output += value[index];
    }
  }
  return `${output}"`;
}

function assertPlainArray(value, path) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    unsupported(path, 'non-plain array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    unsupported(path, 'invalid array length');
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys[length] !== 'length') {
    unsupported(path, 'sparse arrays or extra array properties');
  }
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) {
      unsupported(path, 'sparse arrays or extra array properties');
    }
  }
  return length;
}

function sortProperties(properties) {
  arraySort(properties, (left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
}

function serialize(value, ancestors, path, depth) {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`Maximum canonical JSON depth of ${MAX_DEPTH} exceeded at ${path}.`);
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(`Invalid JSON number at ${path}.`);
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value !== 'object') {
    unsupported(path, typeof value);
  }
  if (types.isProxy(value)) {
    unsupported(path, 'proxy object');
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Cycle detected at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = assertPlainArray(value, path);
      let output = '[';
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          unsupported(`${path}[${index}]`, 'accessor property');
        }
        if (index > 0) {
          output += ',';
        }
        output += serialize(descriptor.value, ancestors, `${path}[${index}]`, depth + 1);
      }
      return `${output}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      unsupported(path, 'non-plain object');
    }

    const properties = [];
    let propertyCount = 0;
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key === 'symbol') {
        unsupported(path, 'symbol keys');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        continue;
      }
      if (!Object.hasOwn(descriptor, 'value')) {
        unsupported(`${path}.${key}`, 'accessor property');
      }
      defineArrayIndex(properties, propertyCount, [key, descriptor.value]);
      propertyCount += 1;
    }
    sortProperties(properties);

    let output = '{';
    for (let index = 0; index < propertyCount; index += 1) {
      const property = properties[index];
      const key = property[0];
      const propertyValue = property[1];
      if (index > 0) {
        output += ',';
      }
      output += `${quoteString(key)}:${serialize(
        propertyValue,
        ancestors,
        `${path}.${key}`,
        depth + 1,
      )}`;
    }
    return `${output}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return `${serialize(value, new WeakSet(), '$', 0)}\n`;
}
