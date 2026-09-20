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

The synthetic SQLite/D1 E2E intentionally proves missing external phases refuse readiness before constructing complete synthetic receipts. It does not prove live PostgreSQL behavior.

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
