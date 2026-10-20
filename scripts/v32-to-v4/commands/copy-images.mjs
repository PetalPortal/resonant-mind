import { readFileSync } from 'node:fs';
import { FilesystemObjectStore, copyImagePlan } from '../external/filesystem-store.mjs';
import { writeJsonNew } from './shared.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { validateImageReceipt } from '../external/images.mjs';
function refuse(summary) { return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'copy-images', summary, safe_details: {}, report_path: null }); }
function flags(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!['--plan', '--source', '--target', '--adapter', '--external-receipt', '--receipt-out', '--trusted-public-key'].includes(key)) throw refuse('copy-images accepts only documented options.'); const value = argv[++i]; if (!value || value.startsWith('--') || out[key] !== undefined) throw refuse(`copy-images requires one value for ${key}.`); out[key] = value; } if (!out['--plan'] || !out['--adapter'] || !out['--receipt-out']) throw refuse('copy-images requires --plan, --adapter, and --receipt-out.'); return out; }
function json(path, label) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw refuse(`${label} is missing or invalid JSON.`); } }
function write(path, value) { writeJsonNew('copy-images', path, value); }
export async function copyImagesCommand(args) {
  const plan = json(args.plan, 'Image plan');
  if (args.adapter === 'r2') {
    if (!args.externalReceipt || !args.trustedPublicKey) throw new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary: 'R2 handoff requires an external receipt and a trusted public-key file; unsigned JSON is never complete.', safe_details: { adapter: 'r2' }, report_path: null });
    const receipt = json(args.externalReceipt, 'External R2 receipt');
    if (receipt.external_handoff !== true) throw new MigrationRefusal({ code: 'RMIG-E-IMAGE-INCOMPLETE', phase: 'copy-images', summary: 'R2 receipts must declare an operator external handoff before signature verification.', safe_details: { adapter: 'r2' }, report_path: null });
    let publicKey; try { publicKey = readFileSync(args.trustedPublicKey, 'utf8'); } catch { throw refuse('The trusted external receipt public-key file is missing or unreadable.'); }
    validateImageReceipt({ plan, receipt, requireSignature: true, trustedPublicKey: publicKey }); write(args.receiptOut, receipt); return receipt;
  }
  if (args.adapter !== 'filesystem' || !args.source || !args.target) throw refuse('Filesystem copy-images requires --source and --target.');
  const result = await copyImagePlan({ plan, sourceStore: new FilesystemObjectStore(args.source), targetStore: new FilesystemObjectStore(args.target) });
  write(args.receiptOut, result); return result;
}
export function parseCopyImagesArgs(argv) { const values = flags(argv); return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), value])); }
export function humanCopyImagesResult(result) { return `copy-images: status=${result.status}; entries=${result.entries?.length ?? 0}; receipt_sha256=${result.receipt_sha256 ?? 'external'}\n`; }
