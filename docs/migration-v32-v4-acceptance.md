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
| `npm run test:migration:postgres` | PASS collection (recorded before the live runs below); 1 file passed/1 skipped, 2 tests passed/2 skipped. The live PostgreSQL E2E was skipped because `TEST_ADMIN_DATABASE_URL` was absent; this is not live PostgreSQL evidence. |
| `npm run verify` | PASS; typecheck, 42 files passed/2 skipped, 399 tests passed/5 skipped, release scan clean (258 files), audit found 0 vulnerabilities |
| `git diff --exit-code 9a08410b538f9dc56119ee34e8de044aef867e51 -- migrations/postgres` | PASS; released v4.0.1 migration SQL is unchanged. The exact release commit was used because this clone has no local `v4.0.1` tag. |
| `npx wrangler deploy --dry-run` | PASS; 1537.08 KiB upload / 263.14 KiB gzip; dry-run exited without deployment |
| `git diff --check` | PASS |
| secret scan / `npm run scan:release` | PASS; release scan clean (258 files) |

The synthetic SQLite/D1 E2E intentionally proves missing external phases refuse readiness before constructing complete synthetic receipts. It does not prove live PostgreSQL behavior; the next section does, within its stated limits.

## Live PostgreSQL evidence (2026-10-20, local)

Until this work the PostgreSQL path had never executed against a real database: the table above records the live E2E as skipped. It was run on 2026-10-20 on a throwaway local cluster, PostgreSQL 18.6 with pgvector 0.8.1, on branch `fable/migrator-finish`, through the PostgreSQL integration suites (`TEST_ADMIN_DATABASE_URL` set; each test creates and drops its own scratch databases). Running it found and fixed real defects, which is why it is recorded here. It was run twice: first through the library functions, then (after the CLI gained the missing steps) through the CLI alone.

Result of the migrator PostgreSQL suites on that cluster, final run: **10 files, 42 tests, all passed** (`postgres-source.integration` 4, `postgres-source-session.integration` 2, `target-fresh.integration` 11, `postgres-spec.integration` 14, `cli-postgres.integration` 2, `cli-flow.integration` 3, `e2e-postgres.integration` 1, `e2e-postgres-rich.integration` 1, `e2e-sqlite.integration` 1, and the v4 application suite `postgres-v4.integration` 3). The non-live suite, `npx vitest run`, passes with the live tests skipped; `npm run verify` is green.

What those runs prove, on PostgreSQL 18.6 only:

- **The fingerprint describes a real v3.2 database.** `scripts/v32-to-v4/spec/v3.2-postgres.json` is generated, not hand-written: `generate-postgres-spec.mjs` applies the byte-verified `postgres.sql` fixture to a scratch database, reads the catalog through the same adapter code the CLI uses, and writes the fingerprint. A test requires the committed file to equal that output, and a database-free test now compares it with a catalog derived from the SQL alone, in every field (including index method, operator class and options, and defaults exactly, not by prefix). A schema with an extra column, a changed default or type, an added check, a SET NULL or RESTRICT foreign key, a renamed index or primary key, a dropped unique constraint, a different vector dimension, or an extra table is refused (tested live). There is no version-dependent rewriting of catalog text.
- **The whole operator flow, through the CLI alone, as separate processes.** `cli-flow.integration` runs `inspect-source`, `export`, `verify-bundle`, `draft-decisions`, `apply-decisions`, `compile-policy`, `plan-relational`, `inspect-target`, `prepare-target`, `dry-run`, `import`, `validate` and `status` on (a) the rich PostgreSQL fixture, (b) a SQLite source and (c) a D1 SQL export, each to a fresh v4 target. The rich run ends at `data-imported-images-pending` (its one image has no external receipt); the SQLite and D1 runs end at `data-imported-not-search-ready` and, once re-embedding receipts for the CLI-planned jobs are supplied, at `ready-for-cutover`. The connection strings and the password appear in no output and no artifact of any run. A non-live SQLite run covers the source-side steps and their refusals (an unreviewed draft will not compile; an incomplete, wildcard, disallowed or stale review is refused by `apply-decisions`; an edited compiled policy is refused by `plan-relational`).
- **Validation reads the live systems and finds damage.** `validate` re-reads the source and the target itself. On a clean run it compared several hundred cells from the source and from the plan with the target, found nothing, and reported by kind what differed from the source and why (a remapped id, an enum alias, a normalized timestamp, a reviewed decision, a v4 default for a NULL). Against clones of the migrated target it found: a changed text, a timestamp rounded to the millisecond, a missing row, an extra row, a changed enum value, an id sequence left behind the data, a CHECK constraint added unvalidated that stored rows violate, and the importer's own receipt row removed; each by a check that names it. It also found a source row changed after the export, an edited plan, an edited receipt, a different reviewed decision file, and a target that is the source. A database-free test (`compare-live`) shows the comparison catches a transform that rounds to milliseconds even when the target faithfully holds the transform's output.
- **Session independence, and a stand-in for a pooler.** The source's `TimeZone`, `DateStyle`, `search_path` and `extra_float_digits` are set with `set_config(..., true)` inside the read-only snapshot transaction, not as startup options. With the database defaults changed to a search_path without `public`, another time zone, a non-ISO date style and `extra_float_digits = -3`, the catalog and every row's text are identical (and an unprotected client sees the difference). A proxy that answers a startup `options` parameter with "unsupported startup parameter: options", as PgBouncer does, refuses the old style of connection and passes the new one, with identical results.
- **The fresh-target check, live.** A fresh target (with or without `vector`, in `public` or its own schema) is accepted; a user table, a view, a sequence, a function, a type, a table in another schema, an empty non-public schema and a non-vector extension are each refused. Another session's temporary tables no longer make an empty database look used (found by this test), while a real table next to them is still refused.
- **Value fidelity with every v3.2 table populated.** `e2e-postgres-rich` reads the source and the target with the same SQL and requires equality for every migrated column: text byte for byte (including a 13 KB observation with quotes, newlines and unicode), integers, ids, self references, JSON-in-text, and all timestamps to the microsecond in UTC, plus routing to people/nodes, observation-version numbering, the reviewed tension choice, the dormant-to-orphan translation, the loss audit, and no legacy vector in v4. `validate` now does the equivalent for any migration, as a product feature.

Defects found and fixed by running it. First round: the fingerprint above; `jsonb` (`embeddings.metadata`) was parsed into an object that the bundle rejects, so any real source with an embeddings row failed to export; `prepareTarget` threw whenever a plan was supplied; the transform rounded timestamps to milliseconds; and `SET NULL` foreign keys were read as `NO ACTION`. Second round: no command produced the decision draft or the relational plan, and `validate` consumed snapshot files nothing could write; `import` printed its receipt but never saved it; the target phases could not connect to a PostgreSQL without TLS, and could not be given a SQLite or D1 source at all; a refusal from an asynchronous command ignored `--json`; an empty target was refused when another session held a temporary table; `observations.archived_at` and `last_accessed_at` skipped timestamp normalization; a naive space-separated timestamp lost its microseconds under a reviewed timezone; observation versions were numbered by comparing timestamp text and text ids (so `...05.123456Z` sorted before `...05.123Z`, and `10` before `9`); `extra_float_digits` was not pinned; a reviewed merge left a false "v4 filled in a NULL" entry.

Known behavior that is by design and now recorded in the product, not only in a test comment: a source `entities.created_at`, `updated_at`, `salience` or `primary_context` of NULL becomes the import time, `'active'` or `'default'` in v4, because v4's own routing trigger writes `COALESCE(...)`. Each case is a `null-replaced-by-v4-default` entry in the loss and audit report, and `validate` checks that the target holds exactly that default (for a timestamp, the import transaction's own time, read from the importer's receipt record) and that every recorded case is visible. `entities.intentionally_isolated` and `observations.charge_note` have no v4 column and are dropped with a loss-audit entry (the `charge_note` reason now says what is true: v3.2 creates the column, v4 has none). A PostgreSQL `timestamptz` is now exported as RFC 3339 text, so the row hash of every row with one changed: a decision draft or reviewed manifest made before this branch is refused as stale; export again and draft again. The migrator has not shipped, so this affects only development drafts.

What is still **not** proven:

- **PostgreSQL 16 and 17.** The CI service job uses PostgreSQL 16 and has not run this code, including the new suites; real v3.2 users run 16 or 17. Nothing in the catalog or validation queries is known to differ across 16, 17 and 18 (the `pg_constraint` filters exclude the not-null constraints PostgreSQL 18 adds), but that is unverified until CI reports.
- **A real pooler.** The pooler support rests on a proxy that rejects startup options and on a session with changed defaults, not on Neon or PgBouncer. A transaction is one server connection under transaction pooling, so the single read-only transaction should hold, but it has not been run through one. Supabase-style layouts with `vector` outside `public`, large tables, concurrent writes to the source during the snapshot, and restore rehearsal are also unproven.
- **Scale.** `validate` holds the bundle's rows, the source's and the target's in memory at once (as `loadVerifiedBundle` already holds the bundle). It has not been measured on a large database.
- **Images/R2 and re-embedding execution.** The CLI-only flow ends where these begin. The no-evidence states (`data-imported-images-pending`, `data-imported-not-search-ready`) and the re-embedding evidence path are exercised live (with receipts the test writes itself, standing in for a provider); copying real image files, a signed external R2 receipt and a real provider run were not exercised through the CLI, and `plan-images` still builds its inventory from a file or directory, not from the imported image rows. A plan with no images, or no jobs, needs no external evidence.
- **Independence of merge expectations.** `validate` derives the expected value of every cell from the source and the reviewed decisions, except for the field values a reviewed merge gives the surviving entity, which it takes from the policy's own merge result; that part is covered by a unit test, not by an independent derivation.
- **Cutover.** `status` with separately created cutover evidence is covered by the existing unit tests only; nothing here performs or proves a cutover.
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
7. Run `validate`: it re-reads the live source and target and compares them with the bundle, the reviewed decisions, the plan and the receipts, and validates any external evidence supplied. A finding refuses.
8. Perform deployment/cutover manually, read back the deployed version, and record separate operator evidence. The CLI can only report `ready-for-cutover` before that evidence.
9. Preserve failure artifacts for diagnosis; rollback means pointing the deployment back to untouched v3 configuration, never reverse-copying automatically.
