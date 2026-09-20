import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReembedPlan } from '../external/reembed.mjs';
import { canonicalJson } from '../lib/canonical-json.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
function refuse(summary) { return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'plan-reembed', summary, safe_details: {}, report_path: null }); }
function parse(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!['--input', '--images', '--out', '--migration-id', '--bundle-manifest-sha256', '--compiled-policy-sha256'].includes(key)) throw refuse('plan-reembed accepts only documented options.'); const value = argv[++i]; if (!value || value.startsWith('--') || out[key] !== undefined) throw refuse(`plan-reembed requires one value for ${key}.`); out[key] = value; } if (!out['--input'] || !out['--out'] || !out['--migration-id']) throw refuse('plan-reembed requires --input, --out, and --migration-id.'); return out; }
function json(path, label) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw refuse(`${label} is missing or invalid JSON.`); } }
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.tmp-${process.pid}`; writeFileSync(temp, canonicalJson(value), { mode: 0o600 }); renameSync(temp, path); }
export function planReembedCommand(args) { const input = json(args.input, 'Relational staging input'); const images = args.images ? json(args.images, 'Image plan') : input.image_inventory ?? []; const plan = buildReembedPlan({ ...input, images, migrationId: args.migrationId, bundleManifestSha256: args.bundleManifestSha256, compiledPolicySha256: args.compiledPolicySha256 }); write(args.out, plan); return plan; }
export function parsePlanReembedArgs(argv) { const values = parse(argv); return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), value])); }
export function humanPlanReembedResult(result) { return `plan-reembed: jobs=${result.jobs.length}; plan_sha256=${result.plan_sha256}\n`; }
