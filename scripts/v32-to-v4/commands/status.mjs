import { readFileSync } from 'node:fs';
import { determineMigrationStatus } from '../validate/reconcile.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
function refuse(summary) { return new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'status', summary, safe_details: {}, report_path: null }); }
export function parseStatusArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!['--report', '--cutover-evidence', '--operator-cutover-ack'].includes(key)) throw refuse('status accepts only --report and separately-created --cutover-evidence.'); if (key === '--operator-cutover-ack') { out.ack = true; continue; } const value = argv[++i]; if (!value || value.startsWith('--') || out[key === '--report' ? 'reportPath' : 'evidencePath'] !== undefined) throw refuse(`status requires one value for ${key}.`); if (key === '--report') out.reportPath = value; else out.evidencePath = value; } if (!out.reportPath) throw refuse('status requires --report.'); return out; }
export function statusCommand({ report, reportPath, evidence, evidencePath, operatorCutoverAcknowledged = false } = {}) {
  let value = report; if (!value && reportPath) { try { value = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { throw refuse('Status report is missing or invalid JSON.'); } } if (!value) throw refuse('status requires a validation report.');
  let cutover = evidence; if (!cutover && evidencePath) { try { cutover = JSON.parse(readFileSync(evidencePath, 'utf8')); } catch { throw refuse('Cutover evidence is missing or invalid JSON.'); } }
  const status = determineMigrationStatus(value, { operatorCutoverEvidence: cutover }); return { status, report_sha256: value.report_sha256 ?? null, counts: value.counts ?? {}, images_complete: value.images_complete ?? false, reembed_complete: value.reembed_complete ?? false, operator_cutover_acknowledged: operatorCutoverAcknowledged === true, cutover_evidence_supplied: cutover !== undefined };
}
export function humanStatusResult(result) { return `status: ${result.status}; report_sha256=${result.report_sha256 ?? 'none'}\n`; }
