import { describe, expect, it, vi } from 'vitest';
import {
  REQUIRED_SOURCE_ADAPTER_METHODS,
  assertSourceAdapter,
  normalizeRow,
  streamNormalizedTable,
  withSnapshot,
} from '../../scripts/v32-to-v4/source/adapter.mjs';

function fakeAdapter(rows = [{ id: 2, value: null }, { id: 1, value: 4n }]) {
  const calls = [];
  return {
    calls,
    identity: vi.fn(async () => ({ kind: 'fake' })),
    catalog: vi.fn(async () => ({ tables: [] })),
    beginSnapshot: vi.fn(async () => { calls.push('begin'); }),
    streamTable: vi.fn(async function* () { for (const row of rows) yield row; }),
    endSnapshot: vi.fn(async () => { calls.push('end'); }),
    close: vi.fn(async () => { calls.push('close'); }),
  };
}

describe('common source adapter contract', () => {
  it('requires the six source methods', () => {
    expect(REQUIRED_SOURCE_ADAPTER_METHODS).toEqual([
      'identity', 'catalog', 'beginSnapshot', 'streamTable', 'endSnapshot', 'close',
    ]);
    expect(() => assertSourceAdapter(fakeAdapter())).not.toThrow();
    expect(() => assertSourceAdapter({ identity() {} })).toThrow(/streamTable|catalog/i);
  });

  it('normalizes bigint values to decimal strings and keeps null', () => {
    expect(normalizeRow({ id: 4n, optional: null, label: 'ok', flag: false })).toEqual({
      id: '4', optional: null, label: 'ok', flag: false,
    });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects unsafe numeric row values %j', (value) => {
      expect(() => normalizeRow({ id: value })).toThrow(/unsafe|finite|safe/i);
    },
  );

  it('rejects byte-bearing row values', () => {
    expect(() => normalizeRow({ payload: new Uint8Array([1, 2]) })).toThrow(/byte|binary|unsupported/i);
    expect(() => normalizeRow({ payload: new ArrayBuffer(2) })).toThrow(/byte|binary|unsupported/i);
  });

  it('sorts a deliberately out-of-order adapter stream by primary key', async () => {
    const adapter = fakeAdapter();
    const rows = [];
    for await (const row of streamNormalizedTable(adapter, 'items', ['id'])) rows.push(row);
    expect(rows).toEqual([{ id: 1, value: '4' }, { id: 2, value: null }]);
    expect(adapter.calls).toEqual(['begin', 'end']);
  });

  it('ends the snapshot when row normalization or iteration fails', async () => {
    const adapter = fakeAdapter([{ id: 1, value: new Uint8Array([9]) }]);
    await expect(async () => {
      for await (const _row of streamNormalizedTable(adapter, 'items', ['id'])) { /* consume */ }
    }).rejects.toThrow(/byte|binary|unsupported/i);
    expect(adapter.endSnapshot).toHaveBeenCalledTimes(1);
  });

  it('ends a callback snapshot even when the callback throws', async () => {
    const adapter = fakeAdapter();
    await expect(withSnapshot(adapter, async () => { throw new Error('iterator failed'); })).rejects.toThrow('iterator failed');
    expect(adapter.calls).toEqual(['begin', 'end']);
  });
});
