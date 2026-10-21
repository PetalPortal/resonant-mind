import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { MigrationRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';
import { inspectSource, parseInspectSourceArgs } from '../../scripts/v32-to-v4/commands/inspect-source.mjs';

function adapterFor(catalog = sourceSpecFor('sqlite')) {
  return {
    identity: vi.fn(() => ({ kind: 'sqlite', source_path: '/tmp/source.sqlite', source_sha256: 'a'.repeat(64) })),
    catalog: vi.fn(() => catalog),
    beginSnapshot: vi.fn(),
    streamTable: vi.fn(async function* () {}),
    rowCount: vi.fn((table) => table === 'images' ? '2' : '3'),
    ambiguityCounts: vi.fn(() => ({ duplicate_entity_names: 1, ambiguous_timestamps: 0, invalid_json: 0 })),
    imageInventory: vi.fn(() => ({ row_count: 2, referenced_objects: 2 })),
    endSnapshot: vi.fn(),
    close: vi.fn(),
  };
}

describe('inspect-source reports', () => {
  it('writes a success report with counts and inventories but no row content', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rm-inspect-success-'));
    const reportPath = join(directory, 'source-report.json');
    const adapter = adapterFor();
    const report = await inspectSource({ sourceKind: 'sqlite', source: 'source.sqlite', reportPath, adapter, timestamp: '2026-09-19T12:34:56.000Z' });
    expect(report.status).toBe('succeeded');
    const serialized = readFileSync(reportPath, 'utf8');
    expect(serialized).toContain('duplicate_entity_names');
    expect(serialized).toContain('row_count');
    expect(serialized).not.toContain('private memory content');
    expect(adapter.beginSnapshot).toHaveBeenCalledTimes(1);
    expect(adapter.endSnapshot).toHaveBeenCalledTimes(1);
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('persists a bounded catalog diff and refuses drift before row inspection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rm-inspect-refusal-'));
    const reportPath = join(directory, 'source-report.json');
    const altered = sourceSpecFor('sqlite');
    altered.tables.push({ name: 'private_notes', columns: [], primary_key: [], unique_constraints: [], foreign_keys: [], checks: [], indexes: [] });
    const adapter = adapterFor(altered);
    await expect(inspectSource({ sourceKind: 'sqlite', source: 'source.sqlite', reportPath, adapter, timestamp: '2026-09-19T12:34:56.000Z', maxDiffs: 1 })).rejects.toMatchObject({ code: 'RMIG-E-SOURCE-FINGERPRINT', report_path: reportPath });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.status).toBe('refused');
    expect(report.details.catalog_diff).toHaveLength(1);
    expect(adapter.rowCount).not.toHaveBeenCalled();
    expect(adapter.endSnapshot).toHaveBeenCalledTimes(1);
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('parses only the explicit inspect-source source arguments', () => {
    expect(parseInspectSourceArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite', '--report', 'report.json'])).toEqual({ sourceKind: 'sqlite', source: 'db.sqlite', reportPath: 'report.json' });
    expect(() => parseInspectSourceArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite'])).toThrow(MigrationRefusal);
    expect(() => parseInspectSourceArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite', '--report', 'report.json', '--unsafe'])).toThrow(MigrationRefusal);
  });
});
