import { describe, expect, it } from 'vitest';
import { formatInstantMicros, offsetMinutes, parseInstantMicros } from '../../scripts/v32-to-v4/lib/instant.mjs';

describe('timestamps as exact microsecond instants', () => {
  it('agrees with Date to the millisecond over a wide range, before and after 1970, in leap years and not', () => {
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let index = 0; index < 4000; index += 1) {
      const ms = (next() % 8_000_000_000_000) - 3_000_000_000_000; // roughly 1875 .. 2223
      const iso = new Date(ms).toISOString();
      expect(parseInstantMicros(iso)).toBe(BigInt(ms) * 1000n);
      expect(formatInstantMicros(BigInt(ms) * 1000n + 123n)).toBe(`${iso.slice(0, 19)}.${String(((ms % 1000) + 1000) % 1000).padStart(3, '0')}123Z`);
    }
    for (const day of ['2000-02-29', '2024-02-29', '1900-03-01', '2100-03-01', '1969-12-31', '1970-01-01', '0001-01-01', '9999-12-31']) {
      const iso = `${day}T00:00:00.000Z`;
      expect(parseInstantMicros(iso)).toBe(BigInt(Date.parse(iso)) * 1000n);
    }
  });

  it('keeps every microsecond and treats T and a space alike', () => {
    expect(parseInstantMicros('2026-01-02T03:04:05.123456Z') - parseInstantMicros('2026-01-02T03:04:05Z')).toBe(123456n);
    expect(parseInstantMicros('2026-01-02 03:04:05.000001+00')).toBe(parseInstantMicros('2026-01-02T03:04:05.000001Z'));
    expect(parseInstantMicros('2026-01-02T03:04:05.5Z')).toBe(parseInstantMicros('2026-01-02T03:04:05.500000Z'));
    expect(parseInstantMicros('2026-01-02T03:04:05.123456000Z')).toBe(parseInstantMicros('2026-01-02T03:04:05.123456Z'));
    expect(formatInstantMicros(parseInstantMicros('2026-01-02 03:04:05.123456+00'))).toBe('2026-01-02T03:04:05.123456Z');
    expect(formatInstantMicros(-1n)).toBe('1969-12-31T23:59:59.999999Z');
  });

  it('applies an offset in the text, or the reviewed offset for a naive text, and never guesses', () => {
    expect(parseInstantMicros('2026-01-02T03:04:05+01:00')).toBe(parseInstantMicros('2026-01-02T02:04:05Z'));
    expect(parseInstantMicros('2026-01-02 03:04:05-05:30')).toBe(parseInstantMicros('2026-01-02T08:34:05Z'));
    expect(parseInstantMicros('2026-01-02 03:04:05-08')).toBe(parseInstantMicros('2026-01-02T11:04:05Z'));
    expect(parseInstantMicros('2026-06-30 23:30:00+14')).toBe(parseInstantMicros('2026-06-30T09:30:00Z'));
    expect(parseInstantMicros('2026-01-02 03:04:05.654321', { naiveOffset: '+02:00' })).toBe(parseInstantMicros('2026-01-02T01:04:05.654321Z'));
    expect(parseInstantMicros('2026-01-02 03:04:05', { naiveOffset: 'UTC' })).toBe(parseInstantMicros('2026-01-02T03:04:05Z'));
    expect(() => parseInstantMicros('2026-01-02 03:04:05')).toThrow(/no offset/u);
    expect(() => parseInstantMicros('2026-01-02 03:04:05', { naiveOffset: 'Nowhere/Zone' })).toThrow(/offset/u);
  });

  it('refuses what it cannot read exactly instead of rounding or repairing it', () => {
    for (const bad of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01', 'yesterday', '', '2026-01-02T03:04:05.1234567Z', '2026-01-02T03:04:05+16:00', '1767225600']) {
      expect(() => parseInstantMicros(bad), bad).toThrow();
    }
    expect(() => parseInstantMicros(5)).toThrow(/text/u);
    expect(offsetMinutes('+05:30')).toBe(330);
    expect(offsetMinutes('-08')).toBe(-480);
    expect(offsetMinutes('UTC')).toBe(0);
    expect(offsetMinutes('+25:00')).toBeNull();
  });
});
