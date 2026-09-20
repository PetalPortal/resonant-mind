import { describe, expect, it } from 'vitest';
import { scanRows, reviewDecisionId } from '../../scripts/v32-to-v4/lib/secret-scan.mjs';

const rows = [{ id: 7, content: 'connect postgres://alice:secret@example.test/mind' }];

describe('content-aware migration secret scanner', () => {
  it('refuses high-confidence credentials in metadata/config without exposing values', () => {
    const result = scanRows([{ id: 1, config: { database_url: 'postgres://alice:secret@example.test/mind' } }], { table: 'metadata' });
    expect(result.highConfidence).toHaveLength(1);
    expect(result.highConfidence[0]).toMatchObject({ table: 'metadata', column: 'config.database_url', kind: 'postgres-credential-url' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('alice');
  });

  it('creates hash-bound review items for lived content and requires explicit decisions', () => {
    const result = scanRows(rows, { table: 'observations' });
    expect(result.highConfidence).toHaveLength(0);
    expect(result.reviewItems).toHaveLength(1);
    const item = result.reviewItems[0];
    expect(item.review_id).toBe(reviewDecisionId(item));
    expect(item.value_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('supports explicit false-positive acknowledgements without suppressing unrelated findings', () => {
    const first = scanRows([{ id: 1, note: 'Bearer example-not-a-token' }], { table: 'notes' });
    const acknowledged = scanRows([{ id: 1, note: 'Bearer example-not-a-token' }], {
      table: 'notes', falsePositiveAcknowledgements: [first.reviewItems[0].review_id],
    });
    expect(acknowledged.reviewItems).toHaveLength(0);
  });
});
