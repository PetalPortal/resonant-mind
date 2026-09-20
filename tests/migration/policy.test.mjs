import { describe, expect, it } from 'vitest';
import { generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { validateDecisionManifest } from '../../scripts/v32-to-v4/policy/validate.mjs';

const bundle = {
  format_version: 1,
  migration_id: 'rmig_policy_test',
  bundle_manifest_sha256: 'a'.repeat(64),
  tables: {
    entities: [
      { id: 2, name: 'Ada', entity_type: 'person', primary_context: 'default' },
      { id: 7, name: 'Ada', entity_type: 'person', primary_context: 'private' },
    ],
    observations: [{ id: 1, entity_id: 999, content: 'hello' }],
  },
};

describe('ambiguity policy', () => {
  it('drafts every ambiguity without lived content and binds source rows', () => {
    const draft = generateDecisionManifest(bundle);
    expect(draft.reviewed).toBe(false);
    expect(draft.items.length).toBeGreaterThanOrEqual(2);
    for (const item of draft.items) {
      expect(item.source_table).toBeTypeOf('string');
      expect(item.source_row_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(item).not.toHaveProperty('content');
      expect(item.allowed_choices.length).toBeGreaterThan(0);
    }
    expect(() => validateDecisionManifest(draft)).not.toThrow();
  });

  it('rejects a draft marked reviewed without complete reviewed metadata and choices', () => {
    const draft = generateDecisionManifest(bundle);
    draft.reviewed = true;
    expect(() => validateDecisionManifest(draft)).toThrow();
  });
});
