import { readFileSync, writeFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseExportArgs } from '../../scripts/v32-to-v4/commands/export.mjs';
import { parseVerifyBundleArgs } from '../../scripts/v32-to-v4/commands/verify-bundle.mjs';

describe('bundle CLI contracts', () => {
  it('requires source identity and output while never accepting a passphrase argument', () => {
    expect(() => parseExportArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite'])).toThrow(/migration-id|bundle/i);
    expect(() => parseExportArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite', '--migration-id', 'rmig_cli_test', '--bundle', 'bundle', '--passphrase', 'hidden'])).toThrow(/documented|option/i);
  });

  it('models plaintext as an explicit flag pair and parses verify-bundle', () => {
    expect(parseExportArgs(['--source-kind', 'sqlite', '--source', 'db.sqlite', '--migration-id', 'rmig_cli_test', '--bundle', 'bundle', '--allow-plaintext-bundle', '--acknowledge-plaintext-risk'])).toMatchObject({ mode: 'plaintext', allowPlaintextBundle: true, acknowledgePlaintextRisk: true });
    expect(parseVerifyBundleArgs(['--bundle', 'bundle', '--passphrase-file', 'passphrase'])).toEqual({ path: 'bundle', passphraseFile: 'passphrase' });
    expect(() => parseVerifyBundleArgs(['--bundle', 'bundle', '--extra'])).toThrow();
  });
});
