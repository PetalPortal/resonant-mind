# v3.2 → v4 migration acceptance evidence

This is a local operator-assisted acceptance record for the release-candidate implementation. It is **not** a support or release declaration. The CLI reads only the exact public v3.2 PostgreSQL schema and the exact post-0003 D1/SQLite schema, exports read-only snapshots, writes only to a distinct fresh v4 target, and never self-attests cutover.

## Scope and safety boundary

- Source is read-only: PostgreSQL uses `REPEATABLE READ READ ONLY`; SQLite opens with `readOnly: true` and source before/after hashes are compared.
- The checked-in SQL fixtures are byte-identical to tag `v3.2.0`; fixture verification is required before migration tests.
- Bundles are encrypted by default. Plaintext requires both explicit acknowledgement flags.
- The target must be a distinct, empty PostgreSQL database. Released `migrations/postgres/*.sql` are not modified.
- Remote D1 export, R2/provider execution, re-embedding execution, deployment, cutover, and rollback are operator-controlled or external phases. The CLI does not invoke Wrangler, Cloudflare, embedding providers, deployment, or destructive rollback.
- An interrupted pre-commit run is not a general crash-resume promise. Start again against a fresh target; checkpoint files are integrity diagnostics only and semantic skips/truncation refuse.

## Exact fixture provenance

`npm run verify:v32-fixtures` verified all four files against both `PROVENANCE.json` and the local Git tag:

| Fixture | Bytes | SHA-256 | Tag match |
|---|---:|---|---|
| `postgres.sql` | 9488 | `78e0bc0c2794232841f19fcf8b0817baffa9ca8097b37f5b4dde9a2d6b37ca90` | true |
| `d1/0001_init.sql` | 6174 | `e251a022c224d8248ddb641bc4691015de4c1ec1c76bb05f04d36ef67e5573f5` | true |
| `d1/0002_enhanced_memory.sql` | 1794 | `f06977835b1a699b9f8f8b085aefe5d7255b89a84c6f7565ce7b5b989a921cc9` | true |
| `d1/0003_graph_health.sql` | 5797 | `bd6cc080cbc3d4851fb97397232a13567934ef80670da18877af7da5164cf6f0` | true |

## Local evidence

The following gates were run in the canonical checkout `C:\Users\marii\Projects\resonant-mind` at `1b0ea8a50e258d0d4385b60cd2abac82b6ba72e6`, using the committed lockfile and Node 22:

| Gate | Local result |
|---|---|
| `npm ci` | PASS; 135 packages installed, audit reported 0 vulnerabilities |
| `npm run verify:v32-fixtures` | PASS; four provenance/tag matches above |
| final focused regression suite | PASS; 4 files, 43 tests |
| SQLite/D1 E2E (collected by the full and migration suites) | PASS; encrypted bundle, source hash stability, reviewed policy, transform, dry-run/import receipt helpers, missing external refusal, validation status, and cleanup exercised |
| `npm run test:migration` | PASS; 25 files passed/1 skipped, 272 tests passed/2 skipped |
| `npm run test:migration:postgres` | PASS collection; 1 file passed/1 skipped, 2 tests passed/2 skipped. The live PostgreSQL E2E was skipped because `TEST_ADMIN_DATABASE_URL` was absent; this is not live PostgreSQL evidence. |
| `npm run verify` | PASS; typecheck, 42 files passed/2 skipped, 399 tests passed/5 skipped, release scan clean (258 files), audit found 0 vulnerabilities |
| `git diff --exit-code 9a08410b538f9dc56119ee34e8de044aef867e51 -- migrations/postgres` | PASS; released v4.0.1 migration SQL is unchanged. The exact release commit was used because this clone has no local `v4.0.1` tag. |
| `npx wrangler deploy --dry-run` | PASS; 1537.08 KiB upload / 263.14 KiB gzip; dry-run exited without deployment |
| `git diff --check` | PASS |
| secret scan / `npm run scan:release` | PASS; release scan clean (258 files) |

The synthetic SQLite/D1 E2E intentionally proves missing external phases refuse readiness before constructing complete synthetic receipts. It does not prove live PostgreSQL behavior; the next section does, within its stated limits.

## Live PostgreSQL evidence (2026-10-20, local)

Until this run the PostgreSQL path had never executed against a real database: the table above records the live E2E as skipped. It was run on 2026-10-20 on a throwaway local cluster, PostgreSQL 18.6 with pgvector 0.8.1, on branch `fable/migrator-finish`, through the PostgreSQL integration suites (`TEST_ADMIN_DATABASE_URL` set; each test creates and drops its own scratch databases). Running it found and fixed real defects, which is why it is recorded here.

Result of the migrator PostgreSQL suites on that cluster: 5 files, 22 tests, all passed (`postgres-source.integration` 4, `postgres-spec.integration` 14, `cli-postgres.integration` 2, `e2e-postgres.integration` 1, `e2e-postgres-rich.integration` 1).

What those runs prove, on PostgreSQL 18.6 only:

- **The fingerprint describes a real v3.2 database.** `scripts/v32-to-v4/spec/v3.2-postgres.json` is now generated, not hand-written: `generate-postgres-spec.mjs` applies the byte-verified `postgres.sql` fixture to a scratch database, reads the catalog through the same adapter code the CLI uses, and writes the fingerprint. A test requires the committed file to equal that output, and a database-free test checks it against the SQL (every table, column, type, nullability, default, key, reference and index). The hand-written file had never been compared with a live catalog and was wrong in these ways: it omitted `observations.resolved_at` and `observations.access_count`; it had no serial defaults, no PostgreSQL casts in defaults, and synthetic unique-constraint names (`entities_unique_1`) instead of PostgreSQL's (`entities_name_primary_context_key`); it left out the indexes behind primary keys and unique constraints; and it recorded the ivfflat option as `lists = 100` where PostgreSQL stores `lists = '100'`.
- **No tolerance was added to the comparison.** There is no version-dependent rewriting of catalog text. The only session-dependent representation (schema-qualified names when `public` is not on the `search_path`) is removed by pinning `search_path=public` for the source session, as `TimeZone` and `DateStyle` already were. A schema with an extra column, a changed default or type, an added check, a SET NULL or RESTRICT foreign key, a renamed index or primary key, a dropped unique constraint, a different vector dimension, or an extra table is refused (tested live).
- **Operator commands against a real source.** `inspect-source`, `export` and `verify-bundle` run as separate processes against a live v3.2 database, produce a succeeded report and an encrypted verified bundle whose fingerprint equals the report's, and the connection string appears in no output or artifact. An altered schema gives `RMIG-E-SOURCE-FINGERPRINT`, a refused report and no bundle.
- **Library pipeline end to end.** Bundle, reviewed policy, transform, fresh-target preparation (released v4 migrations), dry run and import ran against real databases. The source database hash is identical before and after export.
- **Value fidelity, with every v3.2 table populated.** `e2e-postgres-rich` reads the source and the target with the same SQL and requires equality for every migrated column: text byte for byte (including a 13 KB observation with quotes, newlines and unicode), integers, ids, self references, JSON-in-text, and all timestamps to the microsecond in UTC, plus routing to people/nodes, observation-version numbering, the reviewed tension choice, the dormant-to-orphan translation, the loss audit, and no legacy vector in v4.

Defects found and fixed by running it: the fingerprint above; `jsonb` (`embeddings.metadata`) was parsed into an object that the bundle rejects, so any real source with an embeddings row failed to export (now read as PostgreSQL's text); `prepareTarget` threw whenever a plan was supplied (it passed the migration-set hash and migrator version under the wrong option names); the transform rounded timestamps to milliseconds (now microseconds are kept, finer is refused); and `SET NULL` foreign keys were read as `NO ACTION`.

Known behavior that is by design and visible in the live run: a source `entities.updated_at` of NULL becomes the import time in v4, because v4's own routing trigger writes `COALESCE(NEW.updated_at, NOW())` (as v4's upgrade of an existing database does); `entities.intentionally_isolated` and `observations.charge_note` have no v4 column and are dropped with a loss-audit entry. The audit's wording for `charge_note` ("never create observations.charge_note") is inaccurate for PostgreSQL, whose v3.2 schema does create it; the data is still dropped and audited.

What is still **not** proven:

- PostgreSQL 16 and 17. The CI service job uses PostgreSQL 16 and has not run this code; real v3.2 users run 16 or 17. Nothing in the catalog queries is known to differ across 16, 17 and 18, but that is unverified until CI reports.
- The CLI for the target phases. `prepare-target`, `dry-run` and `import` were exercised through the library functions, not the CLI (the CLI target commands connect with TLS certificate verification unless PG_SSL_NO_VERIFY=1 is set; this run did not use them). No CLI command produces the decision draft or the relational staging plan that the guide's steps 4 to 6 consume: `generateDecisionManifest` and `transformRelational` are called only by tests. An operator following the guide cannot complete step 4 to step 5 with the CLI alone.
- The `validate` stage against a real target. The E2E feeds `reconcileMigration` the planned rows for every boundary; `validate` consumes snapshot files that no CLI command reads from a live database. The live comparison above is done by SQL in the test, not by the product.
- Connections through a connection pooler (for example Neon's pooled endpoint), which may reject the `options` startup parameter the source session relies on, a Supabase-style layout with `vector` outside `public` (the type would print schema-qualified and be refused), large tables, concurrent writes to the source during the snapshot, restore rehearsal, images/R2, and re-embedding execution.
- Everything under "Remote-only gates" below.

## Remote-only gates — pending until push

The following are **PENDING UNTIL PUSH**, not passed locally:

- GitHub Actions `migration-postgres-e2e` service job against PostgreSQL 16 + pgvector, including source fixture application, encrypted export, fresh target preparation, real dry-run/import, and validation.
- GitHub Actions `postgres-contracts` job and any remote check rollup.
- A real PostgreSQL source before/after proof and target cleanup from the CI-created disposable databases.
- Restore rehearsal for PostgreSQL backup and D1 export backup.
- Remote CI secret scan, audit, typecheck, full test, and Wrangler dry-run results.
- Any reviewer/security sign-off, release decision, deployment, operator cutover, rollback rehearsal, or support claim.

No bundle artifact is uploaded by CI. CI uses only disposable, non-secret local service credentials and drops its temporary databases in the test cleanup path.

## Operator handoff checklist

1. Verify the exact fixture hashes and source fingerprint.
2. Take and independently verify source backups; quiesce writes for the snapshot window.
3. Export an encrypted bundle and verify it before policy review.
4. Review every generated decision; the CLI will not guess duplicate names, enums, timestamps, JSON, or references.
5. Prepare a brand-new target, run dry-run, inspect the bound receipt, then apply transactionally.
6. Complete local image copies or provide a signed offline R2 handoff; execute re-embedding externally and provide model/dimension/locator-bound receipts.
7. Validate source/export/stage/target evidence and external receipts.
8. Perform deployment/cutover manually, read back the deployed version, and record separate operator evidence. The CLI can only report `ready-for-cutover` before that evidence.
9. Preserve failure artifacts for diagnosis; rollback means pointing the deployment back to untouched v3 configuration, never reverse-copying automatically.
