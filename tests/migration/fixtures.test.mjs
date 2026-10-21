import { describe, expect, it } from 'vitest';
import { verifyV32Fixtures } from '../../scripts/verify-v32-fixtures.mjs';

describe('v3.2 fixture provenance', () => {
  it('verifies byte-identical tagged PostgreSQL and D1 migration fixtures', () => {
    const result = verifyV32Fixtures();
    expect(result.tag).toBe('v3.2.0');
    expect(result.files).toHaveLength(4);
    expect(result.files.every((file) => file.matches_provenance)).toBe(true);
    expect(result.git_tag_checked).toBe(true);
  });
});
