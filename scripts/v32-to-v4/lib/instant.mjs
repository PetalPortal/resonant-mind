// Timestamps as exact instants, without a JavaScript Date.
//
// A Date counts milliseconds; PostgreSQL timestamptz counts microseconds. Validation has to say whether
// two timestamp texts are the same instant to the microsecond, so this reads RFC 3339 / ISO-8601 text
// (with a "T" or a space between date and time) into a BigInt count of microseconds since the Unix
// epoch using only integer arithmetic. It never rounds: a fraction finer than a microsecond is refused
// unless the extra digits are zeros, and a text with no offset is refused unless the caller names the
// offset that was reviewed for it.

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)?$/u;
const MICROS_PER_SECOND = 1_000_000n;

function isLeap(year) { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; }
function daysInMonth(year, month) { return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]; }

// Howard Hinnant's days-from-civil: whole days from 1970-01-01 to a proleptic Gregorian date.
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** "+05:30", "-08", "Z" or "UTC" as minutes east of UTC, or null if it is none of those. */
export function offsetMinutes(text) {
  if (text === 'Z' || text === 'UTC') return 0;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/u.exec(String(text));
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  if (hours > 15 || minutes > 59) return null;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Microseconds since the Unix epoch for an ISO-8601 text. `naiveOffset` is the reviewed offset to apply
 * to a text that carries none ("UTC", "Z" or "+HH:MM"). Throws on anything it cannot read exactly.
 */
export function parseInstantMicros(text, { naiveOffset } = {}) {
  if (typeof text !== 'string') throw new TypeError('A timestamp must be text.');
  const match = PATTERN.exec(text);
  if (!match) throw new Error('Not an ISO-8601 timestamp.');
  const [, y, mo, d, h, mi, s, fraction = '', zulu, sign, oh, om] = match;
  const year = Number(y); const month = Number(mo); const day = Number(d); const hour = Number(h); const minute = Number(mi); const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) throw new Error('Not a valid calendar timestamp.');
  if (/[1-9]/u.test(fraction.slice(6))) throw new Error('Timestamp has more than microsecond precision.');
  const micros = BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  let offset;
  if (zulu !== undefined) offset = 0;
  else if (sign !== undefined) offset = offsetMinutes(`${sign}${oh}${om === undefined ? '' : `:${om}`}`);
  else if (naiveOffset !== undefined) offset = offsetMinutes(naiveOffset);
  else throw new Error('Timestamp has no offset and none was reviewed.');
  if (offset === null || offset === undefined) throw new Error('Timestamp offset is not valid.');
  const seconds = BigInt(daysFromCivil(year, month, day)) * 86400n + BigInt(hour * 3600 + minute * 60 + second) - BigInt(offset * 60);
  return seconds * MICROS_PER_SECOND + micros;
}

/** The same instant as a UTC RFC 3339 text with six fractional digits. */
export function formatInstantMicros(value) {
  const total = BigInt(value);
  let seconds = total / MICROS_PER_SECOND;
  let micros = total % MICROS_PER_SECOND;
  if (micros < 0n) { micros += MICROS_PER_SECOND; seconds -= 1n; }
  const days = Number(seconds / 86400n - (seconds % 86400n < 0n ? 1n : 0n));
  const rest = Number(seconds - BigInt(days) * 86400n);
  // civil-from-days
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor((rest % 3600) / 60), 2)}:${pad(rest % 60, 2)}.${pad(micros, 6)}Z`;
}
