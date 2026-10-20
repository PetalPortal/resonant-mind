import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../scripts/v32-to-v4/lib/canonical-json.mjs';
import { MigrationRefusal, serializeRefusal } from '../../scripts/v32-to-v4/lib/refusal.mjs';

// A refusal names the report the command really wrote, or says the path was withheld. It never names a
// path that does not exist (the redactor used to rewrite a secret-looking part of a path in place).
const SECRET = 'correct-horse-battery-staple-9';
const refusalFor = (reportPath) => new MigrationRefusal({ code: 'RMIG-E-VALIDATION', phase: 'validate', summary: 'Validation found 1 finding(s).', safe_details: {}, report_path: reportPath });

afterEach(() => { delete process.env.RMIG_TEST_DATABASE_PASSWORD; });

describe('the report path in a refusal', () => {
  it('is kept exactly, on a Windows-style path as on a POSIX one', () => {
    for (const path of ['C:\\Users\\operator\\runs\\2026-10-20\\validation report.json', 'D:\\data\\run 1\\report.json', '\\\\server\\share\\validation.json', '/home/fable/run/validation.json', 'reports/source.json']) {
      const refusal = refusalFor(path);
      expect(refusal.report_path, path).toBe(path);
      expect(refusal.toJSON().report_path_withheld, path).toBeUndefined();
      expect(serializeRefusal(refusal)).toContain(`Report: ${path}`);
      expect(JSON.parse(serializeRefusal(refusal, { json: true })).report_path).toBe(path);
    }
  });

  it('is withheld, not rewritten, when an environment secret occurs in it', () => {
    process.env.RMIG_TEST_DATABASE_PASSWORD = SECRET;
    const path = `C:\\Users\\operator\\runs\\${SECRET}\\validation.json`;
    const refusal = refusalFor(path);
    // it must not be the old rewritten path, which named a directory that does not exist
    expect(refusal.report_path).toBeNull();
    expect(refusal.report_path_withheld).toBe(true);
    const json = serializeRefusal(refusal, { json: true });
    expect(JSON.parse(json)).toMatchObject({ report_path: null, report_path_withheld: true });
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('REDACTED');
    const human = serializeRefusal(refusal);
    expect(human).toMatch(/path is withheld/u);
    expect(human).not.toContain(SECRET);
    expect(human).not.toMatch(/Report: /u);
  });

  it('keeps the canonical form of a refusal with no report unchanged', () => {
    const refusal = refusalFor(null);
    expect(refusal.report_path_withheld).toBeUndefined();
    expect(canonicalJson(refusal.toJSON())).not.toContain('withheld');
  });

  it('withholds a path with a control character instead of failing the refusal', () => {
    const refusal = refusalFor('reports/line\nbreak.json');
    expect(refusal.report_path).toBeNull();
    expect(refusal.report_path_withheld).toBe(true);
  });
});
