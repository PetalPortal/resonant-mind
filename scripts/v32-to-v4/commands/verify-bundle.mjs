import { verifyBundle } from '../lib/bundle.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

export function parseVerifyBundleArgs(argv) {
  if (argv.length !== 2 && argv.length !== 4 || argv[0] !== '--bundle' || typeof argv[1] !== 'string' || argv[1].startsWith('--') || (argv.length === 4 && (argv[2] !== '--passphrase-file' || typeof argv[3] !== 'string' || argv[3].startsWith('--')))) {
    throw new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'verify-bundle', summary: 'verify-bundle requires --bundle PATH and optionally --passphrase-file PATH.', safe_details: {}, report_path: null });
  }
  return { path: argv[1], ...(argv.length === 4 ? { passphraseFile: argv[3] } : {}) };
}

export function verifyBundleCommand(args) {
  return verifyBundle(args);
}

export function humanVerifyResult(result) {
  return `verify-bundle: valid; path=${result.path}; members=${result.manifest.members.length}\n`;
}
