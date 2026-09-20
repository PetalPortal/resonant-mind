import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildImageInventory } from '../external/images.mjs';
import { buildFilesystemInventory } from '../external/filesystem-store.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
function refuse(summary) { return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'plan-images', summary, safe_details: {}, report_path: null }); }
function parse(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!['--input', '--source', '--out', '--migration-id', '--bundle-manifest-sha256', '--compiled-policy-sha256'].includes(key)) throw refuse('plan-images accepts only documented options.'); const value = argv[++i]; if (!value || value.startsWith('--') || out[key] !== undefined) throw refuse(`plan-images requires one value for ${key}.`); out[key] = value; } if (!out['--input'] && !out['--source']) throw refuse('plan-images requires --input or --source.'); if (!out['--out']) throw refuse('plan-images requires --out.'); return out; }
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw refuse('Image inventory input is missing or invalid JSON.'); } }
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp-${process.pid}`; writeFileSync(tmp, canonicalJson(value), { mode: 0o600 }); renameSync(tmp, path); }
export async function planImagesCommand(args) { const input = args.input ? json(args.input) : { images: await buildFilesystemInventory(args.source) }; const plan = buildImageInventory({ ...input, migrationId: args.migrationId, bundleManifestSha256: args.bundleManifestSha256, compiledPolicySha256: args.compiledPolicySha256 }); write(args.out, plan); return plan; }
export function parsePlanImagesArgs(argv) { const values = parse(argv); return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), value])); }
export function humanPlanImagesResult(result) { return `plan-images: entries=${result.entries.length}; plan_sha256=${result.plan_sha256}\n`; }
