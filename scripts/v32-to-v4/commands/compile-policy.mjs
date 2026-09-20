import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyBundle, readBundleMember } from '../lib/bundle.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { compilePolicy } from '../policy/compile.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';

function refusal(summary) { return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'compile-policy', summary, safe_details: {}, report_path: null }); }
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]; if (!['--bundle', '--decisions', '--out', '--passphrase-file'].includes(key)) throw refusal('compile-policy accepts only --bundle, --decisions, --out, and --passphrase-file.');
    const value = argv[++i]; if (!value || value.startsWith('--') || out[key]) throw refusal(`compile-policy requires one value for ${key}.`); out[key] = value;
  }
  if (!out['--bundle'] || !out['--decisions'] || !out['--out']) throw refusal('compile-policy requires --bundle, --decisions, and --out.');
  return { bundlePath: out['--bundle'], decisionsPath: out['--decisions'], outPath: out['--out'], passphraseFile: out['--passphrase-file'] };
}
function readBundle(path, passphraseFile) {
  const verified = verifyBundle({ path, passphraseFile });
  const tables = {};
  for (const member of verified.manifest.members) if (member.name.startsWith('data/')) {
    const data = readBundleMember({ path, manifest: verified.manifest, member, passphraseFile }).toString('utf8');
    tables[member.name.slice(5).replace(/\.ndjson(?:\.enc)?$/u, '')] = data.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
  const envelope = JSON.parse(readFileSync(join(path, 'envelope.json'), 'utf8'));
  return { tables, migration_id: verified.manifest.migration_id, bundle_manifest_sha256: envelope.manifest_sha256, manifest: verified.manifest };
}
export function parseCompilePolicyArgs(argv) { return parseFlags(argv); }
export function compilePolicyCommand({ bundlePath, decisionsPath, outPath, passphraseFile }) {
  const bundle = readBundle(bundlePath, passphraseFile);
  let decisions; try { decisions = JSON.parse(readFileSync(decisionsPath, 'utf8')); } catch { throw refusal('The decision manifest is missing or invalid JSON.'); }
  const plan = compilePolicy({ bundle, decisions });
  mkdirSync(dirname(outPath), { recursive: true }); const tmp = `${outPath}.tmp-${process.pid}`; writeFileSync(tmp, canonicalJson(plan), { mode: 0o600 }); renameSync(tmp, outPath);
  return plan;
}
export function humanCompilePolicyResult(result) { return `compile-policy: complete; plan_sha256=${result.plan_sha256}; losses=${result.losses.length}\n`; }
