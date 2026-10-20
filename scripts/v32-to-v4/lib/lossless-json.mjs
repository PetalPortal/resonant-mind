// JSON compared without losing a digit.
//
// JSON.parse turns 12345678901234567891 into the double 12345678901234567000, so two documents that differ
// in a large number compare equal once parsed. This reads the number's own text instead (the parser hands
// the source text of every primitive to the reviver), reduces it to an exact decimal (sign, digits, power of
// ten), and compares documents by a canonical form built from those. 1.0, 1e0 and 1 are one number; 12345678901234567891 and
// 12345678901234567000 are two. Keys are sorted, so key order and whitespace never matter.

class ExactNumber {
  constructor(source) { this.source = source; }
}

/** An exact, canonical text for a JSON number: "<sign><digits>e<exponent>" with no trailing zero digits. */
export function exactNumberText(source) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  if (!match) throw new Error('Not a JSON number.');
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  let digits = `${whole}${fraction}`.replace(/^0+/u, '');
  let power = Number(exponent) - fraction.length;
  if (digits === '') return '0';
  const trimmed = digits.replace(/0+$/u, '');
  power += digits.length - trimmed.length;
  digits = trimmed;
  return `${sign}${digits}e${power}`;
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

/** Parses JSON text keeping every number as its source text. Throws on invalid JSON. */
export function parseLossless(text) {
  return JSON.parse(text, (_key, value, context) => (typeof value === 'number' ? new ExactNumber(context.source) : value));
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

/** True when two JSON documents (text or parsed) are the same document, number for number, digit for digit. */
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
