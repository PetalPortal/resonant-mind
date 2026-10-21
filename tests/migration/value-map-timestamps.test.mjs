import { describe, expect, it } from 'vitest';
import { normalizeTimestamp } from '../../scripts/v32-to-v4/transform/value-map.mjs';

describe('timestamp normalization keeps the instant the source stored', () => {
  it('keeps microseconds, which PostgreSQL timestamptz stores and a JavaScript Date does not', () => {
    expect(normalizeTimestamp('2026-01-02T03:04:05.123456Z')).toBe('2026-01-02T03:04:05.123456Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.000001Z')).toBe('2026-01-02T03:04:05.000001Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.987650Z')).toBe('2026-01-02T03:04:05.987650Z');
  });

  it('converts an offset to UTC without touching the fraction', () => {
    expect(normalizeTimestamp('2026-01-02T03:04:05.123456+01:00')).toBe('2026-01-02T02:04:05.123456Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.123456-05:30')).toBe('2026-01-02T08:34:05.123456Z');
  });

  it('keeps the usual millisecond form for seconds, milliseconds and padded zeros, as before', () => {
    expect(normalizeTimestamp('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.123Z')).toBe('2026-01-02T03:04:05.123Z');
    expect(normalizeTimestamp('2026-01-02T03:04:05.123000Z')).toBe('2026-01-02T03:04:05.123Z');
    expect(normalizeTimestamp('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeTimestamp(null)).toBeNull();
  });

  it('refuses a fraction finer than a microsecond instead of rounding it', () => {
    expect(() => normalizeTimestamp('2026-01-02T03:04:05.1234567Z')).toThrow(/microsecond/u);
    expect(normalizeTimestamp('2026-01-02T03:04:05.1234560Z')).toBe('2026-01-02T03:04:05.123456Z');
  });

  it('applies the reviewed timezone to a naive value and still keeps its fraction', () => {
    const choice = { action: 'normalize-utc', timezone: '+02:00' };
    expect(normalizeTimestamp('2026-01-02T03:04:05.654321', { choice })).toBe('2026-01-02T01:04:05.654321Z');
    expect(() => normalizeTimestamp('2026-01-02T03:04:05.654321')).toThrow(/ambiguous/u);
  });

  it('keeps the fraction of a space-separated value as well as a T-separated one (the form PostgreSQL itself prints)', () => {
    const choice = { action: 'normalize-utc', timezone: '+02:00' };
    expect(normalizeTimestamp('2026-01-02 03:04:05.654321', { choice })).toBe('2026-01-02T01:04:05.654321Z');
    expect(normalizeTimestamp('2026-01-02 03:04:05.654321', { choice: { action: 'normalize-utc', timezone: 'UTC' } })).toBe('2026-01-02T03:04:05.654321Z');
    expect(() => normalizeTimestamp('2026-01-02 03:04:05.1234567', { choice })).toThrow(/microsecond/u);
  });
});
