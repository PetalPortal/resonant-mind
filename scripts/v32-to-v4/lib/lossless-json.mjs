// JSON compared without losing a digit, a key or an exponent.
//
// JSON.parse turns 12345678901234567891 into the double 12345678901234567000, so two documents that differ
// in a large number compare equal once parsed. It also keeps only the last of two equal keys, so
// {"a":12345678901234567891,"a":1} parses as {"a":1} and a value is hidden without any error. This reads the
// number's own text instead (the parser hands the source text of every primitive to the reviver), reduces it
// to an exact decimal (sign, digits, power of ten, the power held as a BigInt so an exponent beyond 2^53 is
// still exact), refuses a document that repeats a key at any depth, and compares documents by a canonical
// form built from those. 1.0, 1e0 and 1 are one number; 12345678901234567891 and 12345678901234567000 are
// two; 1e9007199254740993 and 1e9007199254740992 are two. Keys are sorted, so key order and whitespace never
// matter.
//
// Zero has no sign here: -0, -0.0 and 0 are one value. That is deliberate. PostgreSQL's numeric (and so
// jsonb) has no negative zero and prints -0 as 0, so a comparison that told them apart would flag every
// stored copy of a source -0 and nothing could ever repair it; the sign of a zero is not information the
// target can hold. Every other digit, sign and power is compared exactly.

class ExactNumber {
  constructor(source) { this.source = source; }
}

/** An exact, canonical text for a JSON number: "<sign><digits>e<exponent>" with no trailing zero digits; every zero is "0". */
export function exactNumberText(source) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  if (!match) throw new Error('Not a JSON number.');
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = `${whole}${fraction}`.replace(/^0+/u, '');
  if (digits === '') return '0';
  const trimmed = digits.replace(/0+$/u, '');
  const power = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - trimmed.length);
  return `${sign}${trimmed}e${power.toString(10)}`;
}

/**
 * True when a JSON text names any object key twice, at any depth, after decoding escapes ("a" and "a"
 * are one key). The text must be valid JSON; anything else is another finding's business and is false here.
 */
export function hasDuplicateKeys(text) {
  try { JSON.parse(text); } catch { return false; }
  const stack = [];
  const top = () => stack[stack.length - 1];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const frame = top();
      if (frame !== undefined && frame.keys !== null && frame.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectKey = false;
      }
      index = end + 1;
    } else if (char === '{') { stack.push({ keys: new Set(), expectKey: true }); index += 1; }
    else if (char === '[') { stack.push({ keys: null, expectKey: false }); index += 1; }
    else if (char === '}' || char === ']') { stack.pop(); index += 1; }
    else if (char === ',') { const frame = top(); if (frame !== undefined && frame.keys !== null) frame.expectKey = true; index += 1; }
    else index += 1; // whitespace, ':' and the characters of a number, true, false or null
  }
  return false;
}

function toExact(value) {
  if (typeof value === 'number') {
    // a number that is already a JavaScript number is as exact as it will ever be
    if (!Number.isFinite(value)) throw new Error('Not a JSON number.');
    return new ExactNumber(JSON.stringify(value));
  }
  if (Array.isArray(value)) return value.map(toExact);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toExact(child)]));
  return value;
}

/** Parses JSON text keeping every number as its source text. Throws on invalid JSON and on a repeated key. */
export function parseLossless(text) {
  const parsed = JSON.parse(text, (_key, value, context) => (typeof value === 'number' ? new ExactNumber(context.source) : value));
  if (hasDuplicateKeys(text)) throw new Error('JSON repeats an object key.');
  return parsed;
}

function canonical(value) {
  if (value instanceof ExactNumber) return exactNumberText(value.source);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The canonical, lossless text of a JSON document given as text or as an already-parsed value. */
export function losslessCanonical(input) {
  return canonical(typeof input === 'string' ? parseLossless(input) : toExact(input));
}

/** True when two JSON documents (text or parsed) are the same document, number for number, digit for digit, key for key. */
export function sameJsonLossless(left, right) {
  try { const a = losslessCanonical(left); return typeof a === 'string' && a === losslessCanonical(right); } catch { return false; }
}

/**
 * True when every number in the JSON text survives a trip through a JavaScript number unchanged. A number
 * that does not (too many digits, or out of range) cannot be carried by this migrator's JSON handling
 * without silently changing it, so it needs a reviewed decision instead.
 */
export function numbersSurviveParsing(text) {
  try {
    let exact = true;
    JSON.parse(text, (_key, value, context) => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || exactNumberText(context.source) !== exactNumberText(JSON.stringify(value))) exact = false;
      }
      return value;
    });
    return exact;
  } catch { return true; } // text that is not JSON is another finding's business
}

/**
 * True when reading the JSON text with JSON.parse loses nothing: every number survives, and no object key is
 * repeated (JSON.parse would silently keep the last one). A text for which this is false cannot be migrated
 * as it is; it needs a reviewed decision (a `malformed-json` item). Text that is not JSON at all is another
 * finding's business and is true here.
 */
export function jsonSurvivesParsing(text) {
  return numbersSurviveParsing(text) && !hasDuplicateKeys(text);
}
