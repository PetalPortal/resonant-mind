import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sourceSpecFor } from '../../scripts/v32-to-v4/lib/fingerprint.mjs';
import { generateDecisionManifest, decisionManifestHash } from '../../scripts/v32-to-v4/policy/generate.mjs';
import { compilePolicy } from '../../scripts/v32-to-v4/policy/compile.mjs';
import { transformRelational } from '../../scripts/v32-to-v4/transform/relational.mjs';
import { assertTargetRow, TARGET_SCHEMAS } from '../../scripts/v32-to-v4/transform/target-schema.mjs';

const MAP = JSON.parse(readFileSync(new URL('../../scripts/v32-to-v4/spec/v3.2-to-v4-map.json', import.meta.url), 'utf8'));
const ISO = '2026-01-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);
function sourceFixture() {
  return {
    migration_id: 'rmig_transform_golden', source_kind: 'sqlite', bundle_manifest_sha256: HASH,
    tables: {
      co_surfacing: [{ id: 16, obs_a_id: 30, obs_b_id: 30, co_count: 1, last_co_surfaced: ISO, relation_proposed: 0, relation_created: 0 }],
      consolidation_groups: [{ id: 10, summary: 'summary\nΔ', entity_id: 9, source_observation_ids: '[30]', consolidated_observation_id: 30, created_at: ISO }],
      context_entries: [{ id: 'ctx-1', scope: 'default', content: 'one\ntwo', links: '["Δ"]', updated_at: ISO }],
      daemon_proposals: [{ id: 12, proposal_type: 'x', from_obs_id: 30, to_obs_id: 30, from_entity_id: 9, to_entity_id: 9, reason: 'reason', confidence: 0.5, status: 'pending', proposed_at: ISO, resolved_at: null }],
      dormant_observations: [{ id: 13, observation_id: 30, first_marked: ISO, rescue_attempts: 0, last_rescue_attempt: null }],
      entities: [{ id: 9, name: 'Alice Δ', entity_type: 'person_ai', primary_context: 'default', salience: 'active', created_at: ISO, updated_at: ISO, intentionally_isolated: 0 }],
      identity: [{ id: 14, section: 'texture', content: 'line one\nline two', weight: 0.7, connections: '["Δ"]', timestamp: ISO }],
      images: [{ id: 15, path: 'objects/Δ.png', description: 'image\ncaption', context: 'default', emotion: null, weight: 'medium', entity_id: 9, observation_id: 30, created_at: ISO, access_count: 0, last_accessed_at: null, novelty_score: 1, last_surfaced_at: null, surface_count: 0, archived_at: null }],
      journals: [{ id: 17, entry_date: '2026-01-01', content: 'journal', tags: '["Δ"]', emotion: null, created_at: ISO, journal_type: 'entry' }],
      observation_versions: [{ id: 18, observation_id: 30, content: 'version', weight: 'medium', emotion: null, changed_at: ISO }],
      observations: [{ id: 30, entity_id: 9, content: 'observation\nmultiline', salience: 'active', emotion: null, weight: 'medium', certainty: 'believed', source: 'conversation', source_date: '2026-01-01', context: 'default', charge: 'fresh', charge_note: 'source-only', sit_count: 0, novelty_score: 1, last_surfaced_at: null, surface_count: 0, archived_at: null, added_at: ISO, access_count: 0, last_accessed_at: null, valid_from: null, valid_until: null, superseded_by: null, supersedes: null, resolved_at: null, resolution_note: null, linked_observation_id: null }],
      relations: [{ id: 19, from_entity: 'Alice Δ', to_entity: 'Alice Δ', relation_type: 'knows', from_context: 'default', to_context: 'default', store_in: 'default', created_at: ISO }],
      relational_state: [{ id: 20, person: 'Alice Δ', feeling: 'care', intensity: 'strong', timestamp: ISO }],
      subconscious: [{ id: 21, state_type: 'state', data: '{"nested":true}', updated_at: ISO }],
      tensions: [{ id: 'tension-1', pole_a: 'stay', pole_b: 'go', context: 'default', sit_count: 1, sit_notes: '[]', status: 'active', created_at: ISO, resolved_at: null, resolution: null }],
      threads: [{ id: 'thread-1', thread_type: 'task', content: 'thread\nbody', context: 'default', priority: 'medium', status: 'active', source: 'self', created_at: ISO, updated_at: ISO, resolved_at: null, resolution: null }],
    },
  };
}
function reviewed(bundle, choose = () => undefined) {
  const manifest = generateDecisionManifest(bundle, { now: ISO });
  for (const item of manifest.items) {
    const custom = choose(item);
    if (custom !== undefined) item.choice = custom;
    else if (item.type === 'dormancy-translation') item.choice = 'translate-to-orphan';
    else if (item.type === 'tension-state') item.choice = { action: 'preserve-visits-and-open', last_visited: ISO };
    else if (item.type === 'broken-foreign-key' || item.type === 'broken-name-reference' || item.type === 'ambiguous-name-reference') item.choice = 'exclude-row';
    else if (item.type === 'entity-kind') item.choice = { action: 'map-to-node', kind: 'concept' };
    else item.choice = 'exclude-row';
  }
  manifest.reviewed = true; manifest.reviewed_by = 'golden-reviewer'; manifest.reviewed_at = ISO; manifest.manifest_sha256 = decisionManifestHash(manifest); return manifest;
}
function allValues(value, callback) { callback(value); if (Array.isArray(value)) for (const item of value) allValues(item, callback); else if (value && typeof value === 'object') for (const item of Object.values(value)) allValues(item, callback); }

 describe('v4 target-schema golden transformations', () => {
  it('covers every exact v3.2 source table/column and only maps to catalogued v4 columns', () => {
    for (const family of ['postgres', 'sqlite']) {
      const source = sourceSpecFor(family);
      for (const table of source.tables) {
        const mapping = MAP.find((item) => item.source_table === table.name && item.source_families.includes(family));
        expect(mapping, `${family}.${table.name}`).toBeTruthy();
        const covered = new Set([...Object.keys(mapping.column_map), ...(mapping.dropped_fields ?? []).map((item) => item.field)]);
        expect(table.columns.map((column) => column.name).filter((column) => !covered.has(column)), `${family}.${table.name} uncovered`).toEqual([]);
        for (const dropped of mapping.dropped_fields ?? []) expect(dropped.rationale.length).toBeGreaterThan(0);
        for (const target of Object.values(mapping.column_map ?? {})) {
          if (table.name === 'embeddings') continue;
          const targets = mapping.target_tables.flatMap((name) => Object.keys(TARGET_SCHEMAS[name]?.columns ?? {}));
          expect(targets, `${family}.${table.name}.${target}`).toContain(target);
        }
      }
    }
  });

  it('matches the exhaustive final v4 column catalog and checks', () => {
    const catalog = {
      people: ['id','name','kind','salience','primary_context','created_at','updated_at'], nodes: ['id','name','kind','salience','primary_context','created_at','updated_at'],
      observations: ['id','entity_id','person_id','node_id','content','salience','emotion','added_at','weight','updated_at','charge','charge_note','sit_count','last_sat_at','resolution_note','resolved_at','linked_observation_id','last_surfaced_at','surface_count','novelty_score','certainty','source','archived_at','source_date','context','access_count','last_accessed_at','valid_from','valid_until','superseded_by','supersedes'],
      observation_versions: ['id','observation_id','version_num','content','weight','emotion','edited_at'], relations: ['id','from_entity','to_entity','relation_type','from_context','to_context','store_in','created_at'],
      threads: ['id','thread_type','content','context','priority','status','source','notes','created_at','updated_at','resolved_at','resolution'], context_entries: ['id','scope','content','links','updated_at'], relational_state: ['id','person','feeling','intensity','timestamp'],
      identity: ['id','section','content','kind','weight','connections','timestamp','archived_at'], journals: ['id','entry_date','content','tags','emotion','journal_type','created_at'],
      consolidation_groups: ['id','summary','entity_id','person_id','node_id','source_observation_ids','consolidated_observation_id','created_at'], images: ['id','path','description','context','emotion','weight','entity_id','person_id','node_id','observation_id','charge','created_at','last_viewed_at','view_count','novelty_score','last_surfaced_at','surface_count','archived_at'],
      subconscious: ['id','state_type','data','updated_at'], daemon_proposals: ['id','proposal_type','from_obs_id','to_obs_id','from_entity_id','to_entity_id','reason','confidence','status','proposed_at','resolved_at','co_count_at_resolution'], tensions: ['id','pole_a','pole_b','context','visits','created_at','last_visited','resolved_at','resolution'],
      orphan_observations: ['id','observation_id','first_marked','rescue_attempts','last_rescue_attempt'], co_surfacing: ['id','obs_a_id','obs_b_id','co_count','first_co_surfaced','last_co_surfaced','relation_proposed','relation_created'],
    };
    for (const [table, columns] of Object.entries(catalog)) expect(Object.keys(TARGET_SCHEMAS[table].columns).sort()).toEqual([...columns].sort());
    expect([...TARGET_SCHEMAS.people.kind].sort()).toEqual(['peer_ai','person','self']);
    expect([...TARGET_SCHEMAS.nodes.kind].sort()).toEqual(['artifact','community','concept','emotional_pattern','infrastructure','journal','moment','object','place','practice','project','relationship','research','self','session_log']);
    expect([...TARGET_SCHEMAS.observations.checks.context].sort()).toEqual(['creative-space','default','emotional-processing','episodic','interests-curiosities','relational-models','research','values-ethics']);
  });

  it('matches the final v4 catalog types and maps every persisted source field', () => {
    expect(TARGET_SCHEMAS.observations.columns).toMatchObject({ charge_note: 'text', access_count: 'integer', last_accessed_at: 'timestamptz', source_date: 'date', novelty_score: 'double' });
    expect(TARGET_SCHEMAS.identity.columns.weight).toBe('double');
    expect(TARGET_SCHEMAS.images.columns.novelty_score).toBe('double');
    expect(TARGET_SCHEMAS.co_surfacing.columns.first_co_surfaced).toBe('timestamptz');
    const observationMap = MAP.find((item) => item.source_table === 'observations').column_map;
    expect(observationMap).toMatchObject({ charge_note: 'charge_note', access_count: 'access_count', last_accessed_at: 'last_accessed_at' });
  });

  it('emits an exact v4-shaped golden plan for every SQLite mapping', () => {
    const bundle = sourceFixture();
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    const expectedTables = sourceSpecFor('sqlite').tables.map(({ name }) => name).sort();
    expect(Object.keys(plan.coverage).sort()).toEqual(expectedTables);
    expect(plan.mapping_tables.sort()).toEqual(expectedTables);
    for (const table of Object.keys(transformed.members)) for (const row of transformed.members[table]) assertTargetRow(table, row);
    expect(transformed.members.people).toEqual([{ id: 9, name: 'Alice Δ', kind: 'peer_ai', primary_context: 'default', salience: 'active', created_at: ISO, updated_at: ISO }]);
    expect(transformed.members.observations[0]).toMatchObject({ id: 30, entity_id: 9, person_id: 9, content: 'observation\nmultiline', weight: 'medium' });
    expect(transformed.members.relations[0]).toMatchObject({ from_entity: 'Alice Δ', to_entity: 'Alice Δ' });
    expect(transformed.members.context_entries[0].links).toBe('["Δ"]');
    expect(transformed.members.identity[0].connections).toBe('["Δ"]');
    expect(transformed.members.journals[0].tags).toBe('["Δ"]');
    expect(transformed.members.subconscious[0].data).toBe('{"nested":true}');
    expect(transformed.members.consolidation_groups[0].source_observation_ids).toEqual([30]);
    expect(transformed.members.images[0].view_count).toBe(0);
    expect(transformed.members.images[0]).not.toHaveProperty('last_viewed_at');
    expect(transformed.members.tensions[0]).toMatchObject({ visits: 1, last_visited: ISO });
    expect(transformed.members.tensions[0]).not.toHaveProperty('status');
    expect(transformed.members.tensions[0]).not.toHaveProperty('sit_notes');
    expect(transformed.legacy_vector_inventory).toEqual({ rows: 0, vector_payloads: 0, vector_components: 0 });
    allValues(transformed, (value) => { if (value && typeof value === 'object' && !Array.isArray(value)) expect(Object.keys(value)).not.toContain('legacy_id'); });
  });

  it('validates reviewed relation endpoints against the final entity map', () => {
    const bundle = sourceFixture();
    bundle.tables.relations[0].from_entity = 'missing';
    const draft = reviewed(bundle, (item) => item.type === 'broken-name-reference' || item.type === 'ambiguous-name-reference' ? { action: 'link-by-reviewed-id', target_id: 999 } : undefined);
    expect(() => compilePolicy({ bundle, decisions: draft })).toThrow(/target_id|entity/i);
  });

  it('maps tensions without source-only status fields when no semantic review is needed', () => {
    const bundle = sourceFixture();
    delete bundle.tables.tensions[0].status;
    delete bundle.tables.tensions[0].sit_notes;
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    expect(transformed.members.tensions[0]).toMatchObject({ id: 'tension-1', visits: 1, last_visited: ISO });
  });

  it('counts and strips vector payloads outside the embeddings table', () => {
    const bundle = sourceFixture();
    bundle.tables.context_entries[0].metadata = { vector: [1, 2, 3] };
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    expect(transformed.legacy_vector_inventory).toEqual({ rows: expect.any(Number), vector_payloads: 1, vector_components: 3 });
    expect(JSON.stringify(transformed)).not.toContain('"vector"');
  });

  it('applies exclusions before refusal, removes dependent outputs, and renumbers versions contiguously', () => {
    const bundle = sourceFixture();
    bundle.tables.observation_versions.push({ id: 22, observation_id: 999, content: 'excluded', weight: 'medium', emotion: null, changed_at: ISO });
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle, (item) => item.type === 'broken-foreign-key' && item.source_table === 'observation_versions' ? 'exclude-row' : undefined) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    expect(plan.coverage.observation_versions.excluded_rows).toBe(1);
    expect(transformed.members.observation_versions).toEqual([expect.objectContaining({ id: 18, version_num: 1 })]);
    expect(plan.losses.find((loss) => loss.kind === 'excluded-row' && loss.source_table === 'observation_versions')).toMatchObject({ source_row_sha256: expect.any(String) });
    expect(transformed.reembed_jobs.jobs.some((job) => job.target_locator.id === 22)).toBe(false);
  });

  it('refuses no unresolved broken or ambiguous relation decision and emits no excluded relation', () => {
    const bundle = sourceFixture();
    bundle.tables.relations[0].from_entity = 'missing';
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    expect(plan.losses.some((loss) => loss.kind === 'excluded-row' && loss.source_table === 'relations')).toBe(true);
    expect(transformed.members.relations).toBeUndefined();
  });

  it('excludes an explicitly rejected entity before dependent FK and external planning', () => {
    const bundle = sourceFixture();
    bundle.tables.entities[0].entity_type = 'unknown-kind';
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle, (item) => item.type === 'entity-kind' ? 'exclude-row' : undefined) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    expect(transformed.members.people).toBeUndefined();
    expect(transformed.members.observations).toBeUndefined();
    expect(transformed.image_inventory.entries).toEqual([]);
    expect(transformed.reembed_jobs.jobs.some((job) => job.target_locator.id === 30 || job.target_locator.id === 15)).toBe(false);
    expect(plan.losses.filter((loss) => loss.kind === 'excluded-row').map((loss) => loss.source_table)).toEqual(expect.arrayContaining(['entities', 'observations', 'images', 'consolidation_groups']));
  });

  it('applies reviewed merge field rules and propagates the survivor final kind/name', () => {
    const bundle = sourceFixture();
    bundle.tables.entities = [
      { ...bundle.tables.entities[0], id: 1, name: 'Merge', entity_type: 'person_ai' },
      { ...bundle.tables.entities[0], id: 2, name: 'Merge', entity_type: 'concept', salience: 'high' },
    ];
    for (const table of ['observations', 'images', 'consolidation_groups', 'daemon_proposals']) for (const row of bundle.tables[table]) { if (row.entity_id === 9) row.entity_id = 1; if (row.from_entity_id === 9) row.from_entity_id = 1; if (row.to_entity_id === 9) row.to_entity_id = 1; }
    bundle.tables.images.push({ ...bundle.tables.images[0], id: 23, entity_id: 2 });
    bundle.tables.relations[0].from_entity = 'Merge';
    bundle.tables.relations[0].to_entity = 'Merge';
    const plan = compilePolicy({ bundle, decisions: reviewed(bundle, (item) => {
      if (item.type === 'duplicate-entity-name') return { action: 'merge', survivor_id: 1, merged_ids: [1, 2], field_rules: { name: { source_id: 1 }, entity_type: { source_id: 2 }, primary_context: { source_id: 1 }, salience: { source_id: 2 }, created_at: { source_id: 1 }, updated_at: { source_id: 1 } } };
      if (item.type === 'ambiguous-name-reference') return { action: 'link-by-reviewed-id', target_id: 1 };
      return undefined;
    }) });
    const transformed = transformRelational({ bundle, compiledPolicy: plan });
    expect(transformed.members.nodes).toEqual([expect.objectContaining({ id: 1, name: 'Merge', kind: 'concept', salience: 'high' })]);
    expect(transformed.members.people).toBeUndefined();
    expect(transformed.members.relations[0]).toMatchObject({ from_entity: 'Merge', to_entity: 'Merge' });
    expect(transformed.image_inventory.entries.find((entry) => entry.source_id === 23).linked_target_ids.entity_id).toBe(1);
    expect(plan.merge_audit).toEqual(expect.arrayContaining([expect.objectContaining({ survivor_id: 1, source_row_sha256: expect.any(String) })]));
  });
});
