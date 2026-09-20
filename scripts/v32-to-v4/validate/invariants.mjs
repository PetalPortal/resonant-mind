import { canonicalJson } from '../lib/canonical-json.mjs';
import { canonicalSha256 } from '../lib/hash.mjs';
import { MigrationRefusal } from '../lib/refusal.mjs';
import { tableCounts } from './reconcile.mjs';

function violation(check, details = {}) { return { check, ...details }; }
function refuse(summary, details = {}) { return new MigrationRefusal({ code: 'RMIG-E-VALIDATION', phase: 'validate', summary, safe_details: details, report_path: null }); }
function catalogTables(catalog) { if (Array.isArray(catalog?.tables)) return catalog.tables; if (catalog?.tables && typeof catalog.tables === 'object') return Object.entries(catalog.tables).map(([name, value]) => ({ name, ...value })); return []; }
function rowsFor(target, table) { return target?.[table] ?? []; }
function keyFor(row, columns) { return columns.map((column) => JSON.stringify(row[column])).join('|'); }
export function deriveInvariantSpecs({ catalog, currentMigrations, migrationSetSha256 } = {}) {
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(currentMigrations) || typeof migrationSetSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(migrationSetSha256)) throw refuse('Invariant validation requires the actual target catalog and current migration ledger.');
  const tables = catalogTables(catalog); if (tables.length === 0 || catalog.inventory_complete === false) throw refuse('Target catalog inventory is missing or incomplete.');
  const relationships = []; const unique = []; const checks = []; const sequences = [];
  for (const table of tables) {
    if (typeof table.name !== 'string' || !Array.isArray(table.columns)) throw refuse('Target catalog is missing table column specifications.');
    const primary = Array.isArray(table.primary_key) ? table.primary_key : [];
    if (primary.length) unique.push({ table: table.name, fields: primary, source: 'primary-key' });
    for (const item of table.unique_constraints ?? []) { if (!Array.isArray(item.columns) || item.columns.length === 0) throw refuse('Target catalog contains an incomplete unique constraint.'); unique.push({ table: table.name, fields: item.columns, source: item.name ?? 'unique' }); }
    for (const item of table.foreign_keys ?? []) { if (!Array.isArray(item.columns) || item.columns.length !== 1 || !item.references?.table || !Array.isArray(item.references.columns) || item.references.columns.length !== 1) throw refuse('Target catalog contains an unsupported or incomplete foreign key specification.'); relationships.push({ child_table: table.name, child_key: item.columns[0], parent_table: item.references.table, parent_key: item.references.columns[0] }); }
    for (const check of table.checks ?? []) { if (!Array.isArray(check.fields) || !Array.isArray(check.allowed)) throw refuse('Target catalog CHECK constraints must include executable fields and allowed values.'); checks.push({ table: table.name, fields: check.fields, allowed: check.allowed }); }
    for (const sequence of table.sequences ?? []) { if (typeof sequence.column !== 'string' || !Number.isSafeInteger(Number(sequence.next_value))) throw refuse('Target catalog sequence specifications are incomplete.'); sequences.push({ table: table.name, column: sequence.column, next_value: Number(sequence.next_value) }); }
  }
  if (canonicalSha256(currentMigrations) !== migrationSetSha256 && catalog.migration_set_sha256 !== migrationSetSha256) throw refuse('Current target migration ledger is not bound to the expected migration set.');
  return { relationships, unique, checks, sequences, migration_set_sha256: migrationSetSha256, current_migrations: currentMigrations };
}
export function checkForeignKeys(target, relationships = []) { const findings = []; for (const relation of relationships) { const parent = new Set(rowsFor(target, relation.parent_table).map((row) => JSON.stringify(row[relation.parent_key]))); for (const [index, row] of rowsFor(target, relation.child_table).entries()) if (row[relation.child_key] !== null && row[relation.child_key] !== undefined && !parent.has(JSON.stringify(row[relation.child_key]))) findings.push(violation('foreign-key', { table: relation.child_table, row_index: index })); } return findings; }
export function checkUniqueness(target, unique = []) { const findings = []; for (const spec of unique) { const seen = new Set(); for (const [index, row] of rowsFor(target, spec.table).entries()) { const key = keyFor(row, spec.fields); if (seen.has(key)) findings.push(violation('unique-constraint', { table: spec.table, row_index: index })); seen.add(key); } } return findings; }
export function checkChecks(target, checks = []) { const findings = []; for (const spec of checks) for (const [index, row] of rowsFor(target, spec.table).entries()) if (spec.fields.some((field) => row[field] !== null && row[field] !== undefined && !spec.allowed.includes(row[field]))) findings.push(violation('check-constraint', { table: spec.table, row_index: index })); return findings; }
export function checkSequences(target, sequences = []) { const findings = []; for (const spec of sequences) { const values = rowsFor(target, spec.table).map((row) => Number(row[spec.column])).filter(Number.isSafeInteger); const max = values.length ? Math.max(...values) : 0; if (Number(spec.next_value) <= max) findings.push(violation('sequence-next-value', { table: spec.table })); } return findings; }
export function checkRouting(target) { const findings = []; for (const [table, field] of [['people', 'person_id'], ['nodes', 'node_id']]) for (const [index, row] of rowsFor(target, table).entries()) if (row.id === undefined && row[field] === undefined) findings.push(violation('routing', { table, row_index: index })); for (const row of rowsFor(target, 'observations')) if (row.person_id !== undefined && row.node_id !== undefined) findings.push(violation('routing', { table: 'observations', reason: 'both-target-routes' })); return findings; }
export function checkVersionOrdering(target) {
  const findings = [];
  const grouped = new Map();
  for (const [index, row] of rowsFor(target, 'observation_versions').entries()) {
    const version = Number(row.version_num);
    if (!Number.isSafeInteger(version) || version < 1) {
      findings.push(violation('observation-version-order', { table: 'observation_versions', row_index: index }));
      continue;
    }
    const key = String(row.observation_id);
    const bucket = grouped.get(key) ?? [];
    bucket.push({ version, index });
    grouped.set(key, bucket);
  }
  for (const [observationId, rows] of grouped) {
    rows.sort((left, right) => left.version - right.version || left.index - right.index);
    rows.forEach(({ version, index }, offset) => {
      const expected = offset + 1;
      if (version !== expected) findings.push(violation('observation-version-gap', { table: 'observation_versions', observation_id: observationId, row_index: index, expected, actual: version }));
    });
  }
  return findings;
}
export function checkImageReferences(target, imagePlan = {}) { const valid = new Set((imagePlan.entries ?? []).map((entry) => String(entry.linked_target_ids?.image_id ?? entry.target_id ?? entry.target_key))); return rowsFor(target, 'images').flatMap((row, index) => valid.size > 0 && !valid.has(String(row.id ?? row.image_id ?? row.target_key)) ? [violation('image-reference', { table: 'images', row_index: index })] : []); }
export function validateInvariants({ target = {}, catalog, targetCatalog = catalog, currentMigrations, migrationSetSha256, relationships, unique, checks, sequences, imagePlan = {}, externalReceipts, reembedPlan, reembedReceipts } = {}) {
  const specs = deriveInvariantSpecs({ catalog: targetCatalog, currentMigrations, migrationSetSha256 });
  const useProvided = (value, derived) => Array.isArray(value) && value.length > 0 ? value : derived;
  const findings = [...checkForeignKeys(target, useProvided(relationships, specs.relationships)), ...checkUniqueness(target, useProvided(unique, specs.unique)), ...checkChecks(target, useProvided(checks, specs.checks)), ...checkSequences(target, useProvided(sequences, specs.sequences)), ...checkRouting(target), ...checkVersionOrdering(target), ...checkImageReferences(target, imagePlan)];
  const jobs = reembedPlan?.jobs ?? []; if (jobs.length > 0 && !(reembedReceipts?.status === 'complete' || (Array.isArray(reembedReceipts) && reembedReceipts.length === jobs.length))) findings.push(violation('external-reembed-receipt'));
  const images = imagePlan.entries ?? []; if (images.length > 0 && externalReceipts?.status !== 'complete') findings.push(violation('external-image-receipt'));
  return { valid: findings.length === 0, violations: findings, counts: tableCounts(target), catalog_sha256: canonicalSha256(targetCatalog), migration_set_sha256: specs.migration_set_sha256, invariant_sha256: canonicalSha256(findings) };
}
export function assertInvariants(input) { const result = validateInvariants(input); if (!result.valid) throw refuse('Cross-layer migration invariants are not satisfied.', { violations: result.violations.map(({ check }) => check) }); return result; }
