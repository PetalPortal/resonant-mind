import { describe, expect, it } from 'vitest';
import { exactNumberText, losslessCanonical, numbersSurviveParsing, sameJsonLossless } from '../../scripts/v32-to-v4/lib/lossless-json.mjs';
import { decisionManifestHash, generateDecisionItems, generateDecisionManifest } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { normalizeJson } from '../../scripts/v32-to-v4/transform/value-map.mjs';
import { planCellMismatch, sameJson } from '../../scripts/v32-to-v4/validate/compare.mjs';

describe('JSON is compared digit for digit', () => {
  it('tells apart two numbers that JSON.parse would round to the same double', () => {
    expect(JSON.parse('12345678901234567891')).toBe(JSON.parse('12345678901234567000')); // the old comparison could not see this
    expect(sameJson('{"n": 12345678901234567891}', '{"n": 12345678901234567000}')).toBe(false);
    expect(sameJson('[12345678901234567891]', '[12345678901234567891]')).toBe(true);
    expect(sameJson('{"deep":{"list":[1,{"n":0.12345678901234567891234}]}}', '{"deep":{"list":[1,{"n":0.12345678901234567891235}]}}')).toBe(false);
    expect(sameJson('[1e400]', '[1e401]')).toBe(false);
  });

  it('still treats formatting as formatting: whitespace, key order, and the many spellings of one number', () => {
    expect(sameJson('{"b": 1, "a": [1.0, 2e2, -0, 0.50]}', '{ "a": [1, 200, 0, 0.5],"b":1 }')).toBe(true);
    expect(sameJson({ a: 1, b: [true, null, 'x'] }, '{"b":[true,null,"x"],"a":1}')).toBe(true);
    expect(exactNumberText('100')).toBe('1e2');
    expect(exactNumberText('1.0e2')).toBe('1e2');
    expect(exactNumberText('0.001')).toBe('1e-3');
    expect(exactNumberText('-0.0')).toBe('0');
  });

  it('does not confuse types or values', () => {
    expect(sameJson('1', '"1"')).toBe(false);
    expect(sameJson('[1,2]', '[2,1]')).toBe(false);
    expect(sameJson('{"a":1}', '{"a":1,"b":null}')).toBe(false);
    expect(sameJson('not json', 'not json')).toBe(false);
    expect(losslessCanonical('{"é":"\\u00e9"}')).toBe(losslessCanonical({ 'é': 'é' }));
    expect(sameJsonLossless(undefined, null)).toBe(false);
  });

  it('is what the plan-to-target comparison uses for a json column', () => {
    const mismatch = (planned, stored) => planCellMismatch({ table: 'subconscious', column: 'data', value: planned, dbValue: stored, columnType: 'jsonb', importedAt: null });
    expect(mismatch({ n: 1.5, s: 'x' }, '{"s": "x", "n": 1.5}')).toBeNull();
    expect(mismatch({ n: 12345678901234567000 }, '{"n": 12345678901234567891}')).toBe('json');
  });
});

describe('a JSON number JavaScript cannot carry is a decision, not a silent change', () => {
  it('knows which numbers survive a trip through a JavaScript number', () => {
    expect(numbersSurviveParsing('[1, 2.5, 0.1, 1.10, 1e21, 123456789012]')).toBe(true);
    expect(numbersSurviveParsing('{"id": 12345678901234567891}')).toBe(false);
    expect(numbersSurviveParsing('[1e400]')).toBe(false);
    expect(numbersSurviveParsing('[0.12345678901234567891234]')).toBe(false);
  });

  const bundle = {
    migration_id: 'rmig_lossless_test', bundle_manifest_sha256: 'b'.repeat(64),
    tables: { entities: [{ id: 1, name: 'Ada', entity_type: 'person', primary_context: 'default' }], context_entries: [{ id: 'ctx-1', scope: 'work', content: 'now', links: '[12345678901234567891]', updated_at: '2026-01-02T08:00:00Z' }] },
  };

  it('raises a malformed-json item for it, and refuses to normalize it without a reviewed value', () => {
    const items = generateDecisionItems(bundle).filter((item) => item.type === 'malformed-json');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ field: 'links', source_table: 'context_entries' });
    expect(() => normalizeJson('[12345678901234567891]', 'array')).toThrow(/reviewed/u);
    expect(normalizeJson('[1, 2]', 'array')).toEqual([1, 2]);
    expect(normalizeJson('[12345678901234567891]', 'array', { choice: { action: 'map-json', value: ['12345678901234567891'] } })).toEqual(['12345678901234567891']);
  });

  it('compiles once a person has chosen how the value is to be stored', () => {
    const manifest = generateDecisionManifest(bundle, { now: '2026-09-20T00:00:00.000Z' });
    manifest.items = manifest.items.map((item) => ({ ...item, choice: { action: 'map-json', value: ['12345678901234567891'] } }));
    manifest.reviewed = true; manifest.reviewed_by = 'test'; manifest.reviewed_at = '2026-09-20T00:00:00.000Z'; manifest.manifest_sha256 = decisionManifestHash(manifest);
    expect(compilePolicy({ bundle, decisions: manifest }).value_map.json).toBeTruthy();
  });
});
