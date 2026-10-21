# Safe v3.2 to v4 Migrator Implementation Plan

> **Historical.** This is the original design plan. The option vocabulary below (`--policy-draft`, `--receipts <dir>`, `--apply`, bundle-based target options) was not what was built. The commands and options the CLI actually has are in `node scripts/v32-to-v4/cli.mjs --help` and in [USER_MIGRATION_GUIDE.md](../../USER_MIGRATION_GUIDE.md), which are authoritative.

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Load the test-driven-development skill before writing production code and request a code review at every stage boundary.

**Goal:** Ship a fail-closed, resumable, offline export/import product that reads only the two exact public Resonant Mind v3.2 schemas and imports reviewed data into a brand-new v4 PostgreSQL/pgvector database, while making every unsupported or external phase explicit.

**Architecture:** A Node 22 `.mjs` CLI is split into pure shared libraries, two source adapters, an encrypted/checksummed intermediate bundle, a policy compiler, and a fresh-v4 target importer. The source and target are never upgraded in place: adapters export a repeatable read-only snapshot, policy transforms it into deterministic staged rows, and the importer writes only to a separately verified fresh v4 target. Image-object transfer and re-embedding are separately receipted phases; a migration with referenced external objects or pending embeddings cannot report complete until their receipts validate.

**Tech Stack:** Node.js >=22 ESM, built-in `node:crypto`, `node:fs`, `node:sqlite` (`DatabaseSync`, currently emitted with Node's experimental warning), `pg` 8, Vitest 4, PostgreSQL 16, pgvector, GitHub Actions, NDJSON and canonical JSON.

---

## Non-negotiable safety contract

1. **Never mutate a source.** PostgreSQL export runs in `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`; SQLite opens with `{ readOnly: true }`. A D1 SQL export may be materialized only into a new temporary local SQLite database. No command invokes `wrangler`, opens a Cloudflare API, or writes into the source path.
2. **Never import into v3 or an occupied target.** Preparation accepts only a distinct PostgreSQL database with no non-system objects. It applies the immutable released v4 migrations, verifies their checksums, then creates a run-scoped staging schema. Do not edit `migrations/postgres/*.sql`.
3. **Never guess schema drift.** Fingerprints include tables, columns (type/null/default), PK/unique/FK/check constraints, indexes, and the exact v3.2 schema family. Missing migrations, extra user columns/tables, partial/private schemas, or a mismatched fingerprint produce a structured refusal before row export.
4. **Never guess data semantics.** Duplicate names, enum values, malformed/ambiguous timestamps, broken references, and invalid JSON are either covered by a reviewed decision manifest or refused. Defaults may be offered in a generated draft, but are not silently accepted.
5. **Never emit an accidental plaintext backup.** Encryption is the default. Plaintext requires `--allow-plaintext-bundle` plus `--acknowledge-plaintext-risk`; the choice is recorded in the manifest and report. Secret scanning runs before finalization in either mode.
6. **Never copy old embeddings.** The v3 embedding vectors and Vectorize state are inventory-only. The default output is a complete re-embedding job plan for all imported searchable text and image records. Completion is refused until a matching re-embedding receipt exists, unless a reviewed policy explicitly selects `defer` and the final state is reported as `data-imported-not-search-ready`, never `complete`.
7. **Never hide external work.** R2 export/copy and embedding-provider execution need credentials and are not performed implicitly. The product provides inventory/copy interfaces, local filesystem execution, job plans, and receipt validation. Missing object or embedding receipts block completion.
8. **Every artifact is bound.** Canonical manifests, decisions, bundle members, reports, image inventories, job plans, and receipts carry SHA-256 hashes and a common `migration_id`. Resume rejects changed bundles, decisions, target identity, migration code version, or receipts.
9. **No source/target secrets in artifacts or logs.** URLs are reduced to redacted endpoint/database identities. Errors and reports use refusal codes and safe metadata.
10. **Dry run is mandatory before apply.** `import --apply` requires a successful acceptance receipt for the same bundle, policy, target fingerprint, migrator version, and external-phase plan.

## Versioned artifact contract

The first release uses `format_version: 1` and a directory bundle (easy to inspect, stream, resume, and checksum):

```text
<name>.rmigrate/
  envelope.json                  # encryption/KDF metadata; no passphrase
  manifest.json[.enc]            # canonical manifest and member hashes
  source-report.json[.enc]
  policy-template.json[.enc]
  data/<table>.ndjson[.enc]      # deterministic PK order, one canonical row/line
  external/images.json[.enc]     # metadata/object inventory
  external/reembed-jobs.ndjson[.enc]
  checksums.sha256               # hashes of bytes as stored (ciphertext when encrypted)
```

Encrypted members use AES-256-GCM independently so resume can stream one member at a time. `envelope.json` records `scrypt` parameters, random salt, and each member's random nonce/auth tag; the key comes from `RM_MIGRATION_PASSPHRASE_FILE` (a path to a permission-restricted file), never an argv value or prompt echoed into logs. AAD binds `format_version`, `migration_id`, and member path. Plaintext bundles retain the same member names without `.enc` and record the two explicit acknowledgements. `checksums.sha256` is sorted by member path and itself bound by the manifest hash printed at export; `verify-bundle` checks stored-byte hashes, authenticated decryption, canonical manifest hash, member row counts, and per-NDJSON plaintext hashes.

Canonical JSON means UTF-8, LF, sorted object keys recursively, JSON numbers only when safe integers/finite, and one final newline. Source IDs that exceed safe integers are serialized as decimal strings. Null is distinct from missing.

## Support matrix and first-release boundary

| Source / phase | First implementation | Detection / behavior |
|---|---|---|
| Public **PostgreSQL v3.2.0** created from tag `v3.2.0:migrations/postgres.sql` | **Supported end-to-end for relational data** | Exact catalog fingerprint only; repeatable read-only transaction; pgvector column/index presence fingerprinted; old embeddings inventoried but not imported. |
| Public **D1/SQLite v3.2.0** with all tag migrations `0001_init.sql`, `0002_enhanced_memory.sql`, `0003_graph_health.sql` applied | **Supported end-to-end for relational data** from a local `.sqlite`/`.db` file or local D1 SQL export | `node:sqlite`; exact final catalog fingerprint only. SQL is loaded into a new temp DB and never altered in place. |
| Remote Cloudflare D1 database | **Documented export handoff; no implicit access** | Guide tells operator to run `npx wrangler d1 export <binding-or-name> --remote --output <local.sql>` themselves, inspect it, then pass the local file. CLI refuses D1 names/URLs with `RMIG-E-D1-REMOTE-UNSUPPORTED`. |
| Drifted, partial, private, pre-0003 D1, post-v3.2, or unknown schema | **Safe refusal** | Report catalog diff and `RMIG-E-SOURCE-FINGERPRINT`; never infer compatibility or continue. |
| v3.2 relational tables | **Supported** | Deterministic export, explicit field mapping, FK remap, sequence reset, staged validation. |
| Duplicate entity names across v3 contexts | **Supported only with explicit decisions** | Per collision choose merge with reviewed survivor/field rules, or deterministic rename; unresolved collision refuses. |
| Unknown enums / timestamp forms / malformed JSON text | **Supported only with explicit per-value/per-row policy** | Generate decision candidates; no coercion until reviewed policy is supplied. |
| Fresh v4 PostgreSQL + pgvector | **Supported** | Distinct empty DB only; released migrations applied unchanged; staging + transactional import. Existing/untracked/nonempty targets refuse. |
| Existing v4 target, in-place v3 PostgreSQL target, SQLite target, or D1 target | **Safe refusal** | `RMIG-E-TARGET-NOT-FRESH`, `RMIG-E-SAME-SOURCE-TARGET`, or `RMIG-E-TARGET-UNSUPPORTED`. |
| Image metadata rows | **Supported** | Metadata and object references migrate after ID/policy mapping. |
| Image objects in a local directory | **Supported end-to-end** through the copy interface | Hash, size, MIME sniff, source path traversal guard, destination key map, and copy receipt. |
| Existing R2 image objects | **Inventory/adapter contract and documented operator command; no implicit credentials** | Accept a reviewed inventory JSON and externally produced copy receipt. Missing objects/refused copy block completion. A later credentialed R2 adapter can implement the same interface. |
| Text/image re-embedding | **Job-plan generation + receipt validation; provider execution is external** | All imported searchable records are planned by default. No legacy vectors copied. Missing/partial receipt means `data-imported-not-search-ready`, not complete. |
| Crash/resume | **Supported at member, staging, import, image, and validation checkpoints** | Hash-bound append-only receipts; fault-injection integration tests at every checkpoint. |
| Cutover/rollback automation | **Documented and deliberately manual** | Tool verifies readiness and emits cutover checklist. It never deploys Workers, flips Hyperdrive, deletes v3 data, or destroys the new target. |

### Required table-level mapping specification

Before adapter/import code, encode a mapping row for every public v3.2 table: `entities`, `observations`, `observation_versions`, `relations`, `threads`, `context_entries`, `relational_state`, `identity`, `journals`, `consolidation_groups`, `images`, `subconscious`, `daemon_proposals`, `tensions`, `dormant_observations`, `co_surfacing`, and PostgreSQL-only `embeddings`. Each row must state source-family availability, target table(s), column mapping, dropped fields with rationale, generated fields, FK/ID strategy, validation query, and whether re-embedding is required. The compiler must fail its own test if a fingerprinted source table is absent from this mapping.

Key decisions to encode rather than bury in code:

- `entities` split to v4 `people`/`nodes` using released normalization (`peer_AI`/`AI peer` → `peer_ai`, `kin` → `person`), while retaining legacy IDs where collision-free.
- Duplicate `entities.name` values across `primary_context` cannot enter v4's globally unique legacy surface without a decision. A merge must list all old IDs and the chosen target ID; a rename must give the final unique name. All dependent IDs and name-based `relations` endpoints must be resolved through the same map.
- v3 observation fields absent from v4 (`access_count`, `last_accessed_at`, `valid_from`, `valid_until`, `superseded_by`, `supersedes`, `charge_note`) are not silently discarded: preserve them in an audit payload/report unless an explicit mapping target is added; enumerate data-bearing losses in the acceptance report.
- v3 `observation_versions.changed_at` maps to v4 `edited_at`; generate deterministic `version_num` in `(observation_id, changed_at, id)` order. Invalid/tied timestamps require the timestamp policy and stable ID tie-break, reported explicitly.
- `dormant_observations` maps to v4 `orphan_observations` only under the documented semantic translation; preserve attempts/timestamps and report the terminology change.
- v3 tension `sit_count`, `sit_notes`, and `status` need an explicit mapping to v4 visits/resolution shape; unresolved combinations refuse.
- v3 source timestamps are accepted only if strict RFC 3339 with an offset, or SQLite's exact UTC `YYYY-MM-DD HH:MM:SS` form. Naive/invalid/epoch-like values become decision items; chosen timezone assumptions are recorded per distinct input class and normalized to RFC 3339 UTC.
- Text JSON columns (`links`, `connections`, `tags`, `source_observation_ids`, `data`, `sit_notes`) must parse to their expected JSON shape. Invalid values are policy items, not automatically replaced with `[]`.
- Legacy embeddings are counted and source-linked in reports but never placed into the v4 embeddings table or external vector index. Re-embed jobs are generated from transformed target records.

## CLI surface

Implement one entrypoint, `scripts/v32-to-v4/cli.mjs`, exposed as `npm run migrate:v32 --`:

```text
inspect-source --source-kind postgres|sqlite|d1-export --source <local path or env:NAME> --report <path>
export         --source-kind ... --source ... --bundle <dir> [--policy-draft <path>]
               [--passphrase-file <path> | --allow-plaintext-bundle --acknowledge-plaintext-risk]
verify-bundle  --bundle <dir> [--passphrase-file <path>]
compile-policy --bundle <dir> --decisions <path> --out <path>
inspect-target --target env:NAME --report <path>
prepare-target --target env:NAME --bundle <dir> --decisions <path>
dry-run        --target env:NAME --bundle <dir> --decisions <path> --receipts <dir>
import         --target env:NAME --bundle <dir> --decisions <path> --receipts <dir> --apply
plan-images    --bundle <dir> --decisions <path> --out <path>
copy-images    --inventory <path> --adapter filesystem --source-root <dir> --target-root <dir> --receipt <path>
plan-reembed   --target env:NAME --migration-id <id> --out <path>
validate       --target env:NAME --bundle <dir> --decisions <path> --receipts <dir>
status         --receipts <dir>
```

Connection values are accepted only as `env:VARIABLE_NAME`; reject literal PostgreSQL URLs to prevent shell history leakage. The CLI must redact thrown `pg` errors and never serialize environment values.

## Refusal taxonomy

All refusals use JSON on stdout when `--json` is set, human text on stderr otherwise, exit code `2`, and `{ code, phase, summary, safe_details, remediation, report_path }`. Unexpected internal failures use exit code `1`; success is `0`.

Minimum stable codes: `RMIG-E-NODE-VERSION`, `RMIG-E-SOURCE-ARG`, `RMIG-E-SOURCE-FINGERPRINT`, `RMIG-E-SOURCE-DRIFT`, `RMIG-E-SOURCE-NOT-READONLY`, `RMIG-E-D1-REMOTE-UNSUPPORTED`, `RMIG-E-BUNDLE-PLAINTEXT-ACK`, `RMIG-E-BUNDLE-INTEGRITY`, `RMIG-E-BUNDLE-DECRYPT`, `RMIG-E-SECRET-DETECTED`, `RMIG-E-POLICY-UNRESOLVED`, `RMIG-E-POLICY-MISMATCH`, `RMIG-E-SAME-SOURCE-TARGET`, `RMIG-E-TARGET-NOT-FRESH`, `RMIG-E-TARGET-SCHEMA`, `RMIG-E-DRY-RUN-REQUIRED`, `RMIG-E-RECEIPT-MISMATCH`, `RMIG-E-IMAGE-INCOMPLETE`, `RMIG-E-REEMBED-INCOMPLETE`, and `RMIG-E-VALIDATION`.

---

## Stage 1 — Foundation: manifests, fingerprints, refusals, reports

### Task 1: Add the CLI test harness and Node 22 gate

**Objective:** Establish a directly testable `.mjs` CLI without expanding `tsconfig.json` scope.

**Files:**
- Create: `scripts/v32-to-v4/cli.mjs`
- Create: `scripts/v32-to-v4/lib/runtime.mjs`
- Create: `tests/migration/cli.test.mjs`
- Modify: `package.json`

**TDD steps:**
1. Write tests that spawn `node scripts/v32-to-v4/cli.mjs --help`, assert the command list above, and inject a fake Node major into `assertNodeVersion()` to assert `RMIG-E-NODE-VERSION` below 22.
2. Run `npx vitest run tests/migration/cli.test.mjs`; expect failure because the entrypoint does not exist.
3. Implement argument-free/help behavior, dependency-injected version checking, and the `migrate:v32` / `test:migration` package scripts. Do not add a CLI framework dependency.
4. Run `npm run test:migration -- tests/migration/cli.test.mjs`; expect all tests to pass. Run `npm run typecheck`; it must remain green and must not compile `scripts/`.

**Acceptance:** Help is deterministic, Node <22 fails before reading any source, and no production source file changed.

**Commit:**
```bash
git add package.json scripts/v32-to-v4/cli.mjs scripts/v32-to-v4/lib/runtime.mjs tests/migration/cli.test.mjs
git commit -m "feat(migrator): add guarded v3 migration CLI"
```

### Task 2: Build canonical JSON, hashing, and redaction primitives

**Objective:** Make every later manifest and receipt deterministic and safe to log.

**Files:**
- Create: `scripts/v32-to-v4/lib/canonical-json.mjs`
- Create: `scripts/v32-to-v4/lib/hash.mjs`
- Create: `scripts/v32-to-v4/lib/redact.mjs`
- Create: `tests/migration/primitives.test.mjs`

**TDD steps:**
1. Test recursive key sorting, LF/final-newline rules, unsafe/non-finite number refusal, decimal-string IDs, stable SHA-256, sorted checksum lines, and redaction of passwords, URL credentials, query tokens, env values, and multiline pg errors.
2. Run `npx vitest run tests/migration/primitives.test.mjs`; expect module-not-found failure.
3. Implement with built-in Node APIs only; redact first, then format.
4. Re-run the focused test and `npm test`; expect pass.

**Acceptance:** Two differently ordered equivalent objects hash identically; a seeded secret corpus does not appear in captured logs/reports.

**Commit:**
```bash
git add scripts/v32-to-v4/lib/canonical-json.mjs scripts/v32-to-v4/lib/hash.mjs scripts/v32-to-v4/lib/redact.mjs tests/migration/primitives.test.mjs
git commit -m "feat(migrator): add deterministic artifact primitives"
```

### Task 3: Define versioned manifests, structured refusals, and reports

**Objective:** Centralize artifact schemas and all fail-closed exits.

**Files:**
- Create: `scripts/v32-to-v4/lib/contracts.mjs`
- Create: `scripts/v32-to-v4/lib/refusal.mjs`
- Create: `scripts/v32-to-v4/lib/report.mjs`
- Create: `tests/migration/contracts.test.mjs`

**TDD steps:**
1. Add table-driven tests for all refusal codes, exit-code mapping, required safe fields, unknown manifest versions, missing/extra keys, secret redaction, and canonical report hashes.
2. Run the focused test and observe missing-module failures.
3. Implement explicit validators (no permissive pass-through), `MigrationRefusal`, and report writers using temp-file + atomic rename.
4. Run `npx vitest run tests/migration/contracts.test.mjs` and `npm test`.

**Acceptance:** Every expected refusal has one remediation, reports contain migrator version/phase/timestamp/migration ID but no connection string, and unsupported artifact versions refuse.

**Commit:** `feat(migrator): add manifest refusal and report contracts`.

### Task 4: Encode exact source fingerprints and table mapping coverage

**Objective:** Put the only supported source catalogs and complete table mapping in reviewable data.

**Files:**
- Create: `scripts/v32-to-v4/spec/v3.2-postgres.json`
- Create: `scripts/v32-to-v4/spec/v3.2-sqlite.json`
- Create: `scripts/v32-to-v4/spec/v3.2-to-v4-map.json`
- Create: `scripts/v32-to-v4/lib/fingerprint.mjs`
- Create: `tests/migration/fingerprint.test.mjs`

**TDD steps:**
1. Write tests that normalize shuffled catalog rows, distinguish type/default/nullability/constraint/index drift, reject extra user tables, and assert every table in each fingerprint has a mapping row.
2. Run the focused test; expect failure.
3. Transcribe catalogs directly from `git show v3.2.0:migrations/postgres.sql` and the three `git show v3.2.0:migrations/000*.sql` artifacts, including PostgreSQL `vector(768)` and SQLite post-0003 rewrites. Implement deterministic comparison and a safe catalog diff.
4. Run focused tests against minimal synthetic catalog rows. Task 19 later vendors and executes the exact tag artifacts to prove the transcribed specs against real engines.

**Acceptance:** Removing one column, adding one private table, or changing one default yields `RMIG-E-SOURCE-FINGERPRINT` with a bounded diff; no fuzzy version matching exists.

**Commit:** `feat(migrator): define exact public v3.2 fingerprints`.

## Stage 2 — Exact read-only source adapters

### Task 5: Specify the common adapter and deterministic row stream

**Objective:** Give PostgreSQL and SQLite one narrow, testable source interface.

**Files:**
- Create: `scripts/v32-to-v4/source/adapter.mjs`
- Create: `scripts/v32-to-v4/source/row-normalize.mjs`
- Create: `tests/migration/source-adapter.test.mjs`

**TDD steps:**
1. Test required methods (`identity`, `catalog`, `beginSnapshot`, `streamTable`, `endSnapshot`, `close`), PK ordering, bigint-to-string conversion, byte rejection, null preservation, and cleanup on iterator failure.
2. Run test; expect failure.
3. Implement interface assertions and engine-neutral normalization; no database-specific SQL here.
4. Run focused test and full migration tests.

**Acceptance:** An intentionally out-of-order fake adapter yields stable NDJSON order and always closes the snapshot.

**Commit:** `feat(migrator): add deterministic source adapter contract`.

### Task 6: Implement the exact PostgreSQL v3.2 read-only adapter

**Objective:** Inspect and export only the tagged public PostgreSQL schema without writing to it.

**Files:**
- Create: `scripts/v32-to-v4/source/postgres-v32.mjs`
- Create: `tests/migration/postgres-source.integration.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Against `TEST_V32_DATABASE_URL`, seed from `git show v3.2.0:migrations/postgres.sql` and assert catalog fingerprint, source identity (redacted host/port/database plus server/database identity hash), deterministic table reads, and embedding inventory. Task 19 replaces this setup input with the byte-identical checked-in fixture.
2. Add pg test spies/assertions proving the first snapshot statements are `BEGIN ... REPEATABLE READ READ ONLY` and `SHOW transaction_read_only` returns `on`; attempt a write inside the transaction and assert PostgreSQL rejects it.
3. Run `TEST_V32_DATABASE_URL=... npx vitest run tests/migration/postgres-source.integration.test.mjs`; expect failure.
4. Implement parameterized catalog queries and allowlisted `SELECT` statements only. Read URL solely from an `env:NAME` argument. Roll back the snapshot on every exit.
5. Re-run the integration test and inspect `pg_stat_activity`/fixture row counts before and after; both must show no source mutation.

**Acceptance:** Exact fixture passes; altered fixture refuses before any table export; source row/content and schema hashes are unchanged after success and forced failure.

**Commit:** `feat(migrator): add exact read-only postgres v3.2 adapter`.

### Task 7: Implement local SQLite and D1-export adapters with `node:sqlite`

**Objective:** Support exact post-0003 D1 data from local files while refusing remote access.

**Files:**
- Create: `scripts/v32-to-v4/source/sqlite-v32.mjs`
- Create: `scripts/v32-to-v4/source/d1-export.mjs`
- Create: `tests/migration/sqlite-source.test.mjs`
- Create: `tests/migration/d1-export.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Build a temp DB from the three `git show v3.2.0:migrations/000*.sql` artifacts, seed boundary data, close it, reopen through the adapter, and test exact fingerprint + deterministic reads. Task 19 replaces these setup inputs with byte-identical checked-in fixtures.
2. Test that `DatabaseSync` receives `readOnly: true`, the source file hash/mtime remains unchanged, URI/Cloudflare identifiers refuse, SQL exports materialize only beneath a fresh `mkdtemp` directory, and temp files are removed on success/failure.
3. Include D1 export syntax cases (`PRAGMA`, transactions, quoted text) and reject `.dump` commands or unsupported shell directives.
4. Run focused tests; expect failure.
5. Implement with `node:sqlite`, local regular-file checks, symlink resolution, source/destination path inequality, and no child-process/network calls.
6. Re-run focused tests under Node 22 and `npm test`.

**Acceptance:** `.sqlite`, `.db`, and local `.sql` exports work; a pre-0003 database and an extra private table refuse; no code imports or invokes Wrangler.

**Commit:** `feat(migrator): add exact local d1 sqlite v3.2 adapter`.

### Task 8: Wire inspect-source and source reports

**Objective:** Let operators learn whether a source is supported without exporting data.

**Files:**
- Create: `scripts/v32-to-v4/commands/inspect-source.mjs`
- Create: `tests/migration/inspect-source.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test success reports, bounded catalog diffs, per-table row counts, ambiguity counts, image/embedding inventories, JSON/human output, and refusal report persistence.
2. Run focused test; expect failure.
3. Implement command orchestration with adapter cleanup in `finally` and no row content in the report.
4. Re-run focused and full migration tests.

**Acceptance:** Inspection is demonstrably read-only and reports enough to estimate migration work without leaking memory content.

**Commit:** `feat(migrator): add source preflight reports`.

## Stage 3 — Secure checksummed bundles

### Task 9: Implement streaming member writers and checksums

**Objective:** Export deterministic NDJSON members without holding a lived Mind in memory.

**Files:**
- Create: `scripts/v32-to-v4/bundle/member-writer.mjs`
- Create: `scripts/v32-to-v4/bundle/checksums.mjs`
- Create: `tests/migration/bundle-members.test.mjs`

**TDD steps:**
1. Test deterministic table/member order, atomic temp names, interruption cleanup, row counts, plaintext and stored-byte SHA-256, and checksum tampering.
2. Run focused test; expect failure.
3. Implement streaming writes with restrictive file modes where supported and atomic finalization.
4. Run focused tests plus a 100k-row synthetic export to assert bounded heap growth (generous CI threshold, e.g. <128 MiB increase).

**Acceptance:** Interrupted members are never mistaken for complete; one changed byte is detected.

**Commit:** `feat(migrator): add streaming checksummed bundle members`.

### Task 10: Add encryption and explicit plaintext acknowledgement

**Objective:** Make encrypted bundles the default and plaintext a deliberate auditable exception.

**Files:**
- Create: `scripts/v32-to-v4/bundle/encryption.mjs`
- Create: `tests/migration/bundle-encryption.test.mjs`
- Modify: `scripts/v32-to-v4/lib/contracts.mjs`

**TDD steps:**
1. Test AES-256-GCM round trips, unique nonce per member, AAD path binding, wrong key/tag/salt refusal, passphrase-file permissions warning/refusal policy, no passphrase in argv/report, and dual plaintext flags.
2. Run focused test; expect failure.
3. Implement `scrypt` key derivation and streaming cipher transforms; zero temporary key buffers after use where practical.
4. Re-run focused tests. Search test artifacts/log captures for seeded passphrases and assert zero hits.

**Acceptance:** Copying ciphertext to a different member path fails authentication; plaintext without both flags returns `RMIG-E-BUNDLE-PLAINTEXT-ACK`.

**Commit:** `feat(migrator): encrypt migration bundles by default`.

### Task 11: Add content-aware secret scanning and export finalization

**Objective:** Refuse bundles that appear to contain credentials outside expected memory-text fields, and warn/review rather than corrupt lived text.

**Files:**
- Create: `scripts/v32-to-v4/bundle/secret-scan.mjs`
- Create: `scripts/v32-to-v4/commands/export.mjs`
- Create: `scripts/v32-to-v4/commands/verify-bundle.mjs`
- Create: `tests/migration/export-bundle.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test high-confidence patterns (Postgres URLs with credentials, API/private keys, bearer tokens, Cloudflare tokens), allowlisted opaque memory-content fields, redacted finding locations, false-positive acknowledgement records, and no raw match in reports.
2. Test export → verify, corrupt ciphertext, missing member, extra member, wrong row count, and atomic incomplete-directory cleanup.
3. Run focused test; expect failure.
4. Implement scanning before encryption/final rename. High-confidence findings in metadata/config fields refuse. Findings inside designated lived-content fields create redacted review items and require an explicit decision (`retain`, `redact`, or `exclude-row`) keyed by row hash; never auto-redact.
5. Re-run focused tests and `npm test`.

**Acceptance:** Export creates a verified bundle only after fingerprint success and secret review; failed export cannot leave a valid-looking bundle.

**Commit:** `feat(migrator): export verified secret-scanned bundles`.

## Stage 4 — Policy and deterministic transformation

### Task 12: Generate and validate the decision manifest

**Objective:** Turn every semantic ambiguity into an explicit, hash-bound operator decision.

**Files:**
- Create: `scripts/v32-to-v4/policy/generate.mjs`
- Create: `scripts/v32-to-v4/policy/validate.mjs`
- Create: `scripts/v32-to-v4/spec/decision-schema.json`
- Create: `tests/migration/policy.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Fixture duplicate names across contexts, invalid/unknown enum values, naive/invalid timestamps, malformed JSON text, broken FKs, tension-state conflicts, and secret-review items.
2. Assert a draft lists source row hashes and allowed choices but `reviewed: false`; an unresolved/stale/extra decision refuses; changed bundle hash invalidates the policy.
3. Run focused test; expect failure.
4. Implement generation and strict validation. Require `reviewed_by`, `reviewed_at`, `bundle_manifest_sha256`, and an explicit decision for every item. Do not infer identity from names.
5. Run focused and full migration tests.

**Acceptance:** Duplicate-name policy supports only documented `merge` and `rename`; enum/timestamp decisions are exhaustive; no wildcard “accept all unknowns” option exists.

**Commit:** `feat(migrator): require reviewed ambiguity decisions`.

### Task 13: Compile policies into stable ID and value maps

**Objective:** Produce one deterministic transform plan used by dry-run and import.

**Files:**
- Create: `scripts/v32-to-v4/policy/compile.mjs`
- Create: `scripts/v32-to-v4/transform/id-map.mjs`
- Create: `scripts/v32-to-v4/transform/value-map.mjs`
- Create: `tests/migration/policy-compile.test.mjs`

**TDD steps:**
1. Test merge/rename propagation across entity IDs, observations, images, consolidations, proposals, and name-based relations; test enum mappings, strict UTC normalization, observation version numbering, broken-link decisions, and collision detection.
2. Assert input-order independence and a stable compiled-plan hash.
3. Run focused test; expect failure.
4. Implement pure transforms with no database access; every dropped/nonrepresentable value must add a loss/audit entry.
5. Run focused tests and snapshot the transform report structure (not lived content).

**Acceptance:** Every source PK maps once or is explicitly excluded; every target unique key is conflict-free; all lossy effects are counted and cited by source row hash.

**Commit:** `feat(migrator): compile deterministic v3 to v4 policy maps`.

### Task 14: Transform all relational tables and create external job plans

**Objective:** Materialize target-shaped staging members plus image and re-embedding plans.

**Files:**
- Create: `scripts/v32-to-v4/transform/relational.mjs`
- Create: `scripts/v32-to-v4/external/images.mjs`
- Create: `scripts/v32-to-v4/external/reembed.mjs`
- Create: `tests/migration/transform.test.mjs`

**TDD steps:**
1. Add golden tests covering every mapping row and asserting no source table is skipped. Include min/max/null timestamps, Unicode, multiline text, ID gaps, duplicate contexts, archived rows, and all FK shapes.
2. Assert v3 embedding values never appear in transformed output, while one deterministic re-embed job exists for every searchable target row and image metadata record.
3. Run focused test; expect failure.
4. Implement streaming transforms. Image inventory records source logical path, expected hash/size when available, target key, and linked target IDs. Re-embed jobs record target locator, content hash, modality, model-policy placeholder, and migration ID.
5. Re-run focused tests.

**Acceptance:** Mapping coverage is 100%; row counts and losses reconcile; no vector payload survives; external plans are hash-bound to policy and bundle.

**Commit:** `feat(migrator): transform relational data and plan external work`.

## Stage 5 — Fresh-v4 preparation, staging, and import

### Task 15: Extract a reusable immutable v4 migration runner

**Objective:** Prepare a fresh target using current released SQL without duplicating or modifying migrations.

**Files:**
- Create: `scripts/postgres-migrations.mjs`
- Modify: `scripts/migrate-postgres.mjs`
- Create: `tests/migration/postgres-migrations.test.mjs`
- Modify: `tests/postgres-v4.integration.test.ts`

**TDD steps:**
1. Characterize current migration ordering, checksum ledger, TLS defaults, advisory lock, rollback, and untracked-schema refusal through tests.
2. Run relevant tests before refactor; they pass. Add the new import-based test and see it fail.
3. Move reusable logic into exported functions; keep `scripts/migrate-postgres.mjs` behavior/output compatible. Never edit `migrations/postgres/*.sql`.
4. Run `npm run test:postgres`, migration tests, and `npm run verify`.

**Acceptance:** Fresh-v4 contract remains green, every migration checksum is unchanged, and command behavior is equivalent.

**Commit:** `refactor(db): share immutable postgres migration runner`.

### Task 16: Verify target freshness and source/target separation

**Objective:** Refuse unsafe target identities before acquiring write intent.

**Files:**
- Create: `scripts/v32-to-v4/target/preflight.mjs`
- Create: `scripts/v32-to-v4/commands/inspect-target.mjs`
- Create: `tests/migration/target-preflight.integration.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test literal URL rejection, same PostgreSQL server/database identity, an existing v3 schema, an existing v4 schema, an arbitrary table, missing pgvector availability, and an empty target.
2. Run against disposable PostgreSQL databases; expect failure before implementation.
3. Implement read-only catalog inspection first. Compare source and target using redacted server address/port, `current_database()`, and a database identity query available to the configured role; if identity cannot be established strongly enough for a PostgreSQL source, refuse rather than trust URL strings.
4. Re-run integration tests and verify rejected targets have no new objects.

**Acceptance:** Only a distinct empty database passes; preflight itself creates nothing.

**Commit:** `feat(migrator): require distinct fresh v4 targets`.

### Task 17: Prepare v4 and a run-scoped staging schema

**Objective:** Apply immutable v4 migrations and create isolated, auditable staging tables.

**Files:**
- Create: `scripts/v32-to-v4/target/prepare.mjs`
- Create: `scripts/v32-to-v4/target/staging.mjs`
- Create: `tests/migration/target-prepare.integration.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test empty target → exact v4 ledger → `migration_stage_<safe_id>` schema, least-privilege grants, stage metadata, and rollback/cleanup on injected migration failure.
2. Assert re-running with the same hashes resumes, while a changed bundle/policy/migrator version refuses.
3. Run integration test; expect failure.
4. Implement using the shared migration runner and parameter/identifier allowlists. Record target migration checksums in the stage metadata.
5. Re-run integration tests and compare released migration file hashes before/after.

**Acceptance:** Target is fresh v4 plus one namespaced staging schema; source remains untouched; no production table has imported rows yet.

**Commit:** `feat(migrator): prepare isolated fresh v4 staging`.

### Task 18: Add mandatory dry run and transactional import

**Objective:** Stage, validate, and import transformed rows without partial production state.

**Files:**
- Create: `scripts/v32-to-v4/target/load-stage.mjs`
- Create: `scripts/v32-to-v4/target/import.mjs`
- Create: `scripts/v32-to-v4/commands/dry-run.mjs`
- Create: `scripts/v32-to-v4/commands/import.mjs`
- Create: `tests/migration/import.integration.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test staging row hashes/counts, FK checks, uniqueness checks, decision/loss report, target enum constraints, sequence reset, and `EXPLAIN`/validation without production inserts.
2. Assert apply refuses without a matching successful dry-run receipt and rejects a receipt after any bundle/policy/target change.
3. Test import in one transaction with deferred-safe order: independent tables, people/nodes/entities compatibility surfaces, dependents, self-references, then sequences. Force a mid-import failure and assert zero imported production rows.
4. Run integration test; expect failure.
5. Implement COPY-like batched parameterized inserts (never interpolate values), transaction-scoped advisory lock, and exact post-import sequence `setval` logic.
6. Re-run integration tests and `npm run test:postgres`.

**Acceptance:** Dry run predicts exact effects; apply is atomic; rerun detects completed import rather than duplicating rows; no command writes the source.

**Commit:** `feat(migrator): dry-run and atomically import into fresh v4`.

## Stage 6 — Images, re-embedding, receipts, validation, and resilience

### Task 19: Add actual tagged-schema fixtures and provenance verification

**Objective:** Test against the released v3.2 artifacts, not hand-written approximations.

**Files:**
- Create verbatim: `tests/fixtures/migration/v3.2/postgres.sql`
- Create verbatim: `tests/fixtures/migration/v3.2/d1/0001_init.sql`
- Create verbatim: `tests/fixtures/migration/v3.2/d1/0002_enhanced_memory.sql`
- Create verbatim: `tests/fixtures/migration/v3.2/d1/0003_graph_health.sql`
- Create: `tests/fixtures/migration/v3.2/PROVENANCE.json`
- Create: `scripts/verify-v32-fixtures.mjs`
- Create: `tests/migration/fixtures.test.mjs`
- Modify: `package.json`

**TDD steps:**
1. Write the verifier test first. It must assert tag/path and SHA-256 values: Postgres `78e0bc0c2794232841f19fcf8b0817baffa9ca8097b37f5b4dde9a2d6b37ca90`; D1 `0001` `e251a022c224d8248ddb641bc4691015de4c1ec1c76bb05f04d36ef67e5573f5`; `0002` `f06977835b1a699b9f8f8b085aefe5d7255b89a84c6f7565ce7b5b989a921cc9`; `0003` `bd6cc080cbc3d4851fb97397232a13567934ef80670da18877af7da5164cf6f0`.
2. Run test; expect missing fixtures.
3. Populate with `git show v3.2.0:<path>` byte-for-byte. Add `verify:v32-fixtures` package script. The verifier uses provenance hashes when `.git` is absent and additionally compares `git show` when the tag is available.
4. Run `npm run verify:v32-fixtures` and both adapter suites.

**Acceptance:** Fixtures execute successfully in their real engines and match tag bytes; generated fingerprints equal checked-in specs.

**Commit:** `test(migrator): add exact v3.2 tagged schema fixtures`.

### Task 20: Implement image inventory/copy interface and completion gate

**Objective:** Make external image bytes accountable without pretending Cloudflare access.

**Files:**
- Create: `scripts/v32-to-v4/external/object-store.mjs`
- Create: `scripts/v32-to-v4/external/filesystem-store.mjs`
- Create: `scripts/v32-to-v4/commands/plan-images.mjs`
- Create: `scripts/v32-to-v4/commands/copy-images.mjs`
- Create: `tests/migration/images.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test interface methods (`inventory`, `openRead`, `put`, `verify`), filesystem copy, byte hash/size/MIME verification, missing objects, duplicates, traversal/symlink escapes, partial copy/resume, and receipt hashes.
2. Add an R2 contract test using a fake adapter, but no real Cloudflare SDK/credentials. Test that `--adapter r2` refuses with a guide link in release one unless an external signed inventory/copy receipt is supplied.
3. Run focused test; expect failure.
4. Implement filesystem adapter and generic receipt verifier. Preserve metadata but generate safe target keys; never trust a database path as a filesystem path.
5. Re-run focused tests.

**Acceptance:** Local bytes copy end-to-end; R2 work is visible and receipted; any referenced missing/changed object yields `RMIG-E-IMAGE-INCOMPLETE` and blocks `complete`.

**Commit:** `feat(migrator): inventory and receipt image migration`.

### Task 21: Generate default full re-embedding jobs and validate external receipts

**Objective:** Ensure semantic search is knowingly rebuilt rather than silently stale.

**Files:**
- Create: `scripts/v32-to-v4/commands/plan-reembed.mjs`
- Create: `scripts/v32-to-v4/external/receipt.mjs`
- Create: `tests/migration/reembed.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test deterministic job IDs/content hashes for observations, archive/search text, and images; zero legacy vectors; model/dimension recorded in completion receipts; partial/error/duplicate receipts rejected.
2. Test target-content hash recheck so a changed target row invalidates a completed job.
3. Run focused test; expect failure.
4. Implement job generation and provider-neutral receipt validation only. Do not call Gemini, Vectorize, or a network.
5. Re-run tests.

**Acceptance:** Default plan covers every searchable imported record; absent receipt yields `RMIG-E-REEMBED-INCOMPLETE`; explicit reviewed defer state is clearly non-complete.

**Commit:** `feat(migrator): plan and receipt full re-embedding`.

### Task 22: Add append-only resume receipts and fault injection

**Objective:** Resume safely after crashes without trusting mutable local state.

**Files:**
- Create: `scripts/v32-to-v4/lib/receipts.mjs`
- Create: `scripts/v32-to-v4/lib/checkpoints.mjs`
- Create: `tests/migration/resume.integration.test.mjs`
- Modify: all stage command modules to emit checkpoints

**TDD steps:**
1. Define checkpoints: `source-inspected`, `bundle-member:<path>`, `bundle-finalized`, `policy-compiled`, `target-prepared`, `stage-member:<table>`, `dry-run-accepted`, `import-committed`, `images-complete`, `reembed-complete`, `validation-complete`.
2. Test hash chaining, atomic write, truncated/tampered receipt refusal, target identity mismatch, and idempotent resume.
3. Under `NODE_ENV=test` only, inject `RM_MIGRATOR_FAULT_AFTER=<checkpoint>` and crash after each checkpoint. Re-run and assert either safe resume or exact refusal, no duplicate rows, and no false completion.
4. Run test; expect failure before implementation.
5. Implement immutable numbered receipt files; never overwrite a successful checkpoint. Production refuses the fault variable.
6. Run the full fault matrix against both SQLite and PostgreSQL sources.

**Acceptance:** Every planned fault has a proven recovery path; a changed artifact never resumes; committed imports are recognized exactly once.

**Commit:** `feat(migrator): add hash-bound resume checkpoints`.

### Task 23: Implement cross-layer validation and final status

**Objective:** Prove migrated data, external phases, and target behavior before declaring readiness.

**Files:**
- Create: `scripts/v32-to-v4/validate/reconcile.mjs`
- Create: `scripts/v32-to-v4/validate/invariants.mjs`
- Create: `scripts/v32-to-v4/commands/validate.mjs`
- Create: `scripts/v32-to-v4/commands/status.mjs`
- Create: `tests/migration/validation.integration.test.mjs`
- Modify: `scripts/v32-to-v4/cli.mjs`

**TDD steps:**
1. Test per-table source/export/stage/target counts adjusted by explicit merge/exclusion decisions; row-content hashes; FK/uniqueness/check constraints; sequence next values; people/nodes routing; observation-version ordering; image references; and external receipt coverage.
2. Mutate one target row/object/job receipt and assert the exact validation refusal.
3. Test statuses: `refused`, `exported`, `review-required`, `dry-run-accepted`, `data-imported`, `data-imported-images-pending`, `data-imported-not-search-ready`, `ready-for-cutover`, and `complete-after-operator-cutover-ack`.
4. Run focused test; expect failure.
5. Implement bounded reports with counts/hashes and sampled row-hash references, never raw lived content.
6. Run focused, PostgreSQL, and full test suites.

**Acceptance:** `ready-for-cutover` requires relational validation plus all applicable image and re-embedding receipts. The CLI cannot self-assert operator cutover.

**Commit:** `feat(migrator): validate migration and gate completion`.

## Stage 7 — Real CI, end-to-end proof, and operator documentation

### Task 24: Add real PostgreSQL/pgvector CI migration coverage

**Objective:** Exercise both source families through fresh-v4 import on actual PostgreSQL 16 + pgvector.

**Files:**
- Create: `tests/migration/e2e-postgres.integration.test.mjs`
- Create: `tests/migration/e2e-sqlite.integration.test.mjs`
- Modify: `.github/workflows/verify.yml`
- Modify: `package.json`

**TDD steps:**
1. Add `test:migration:postgres` script and CI tests that create separate source and target databases in the existing `pgvector/pgvector:pg16` service, apply exact tagged source schema, seed a public synthetic dataset, export encrypted bundle, compile reviewed fixture policy, dry-run, import, validate, and fault-resume.
2. Add SQLite/D1 local export E2E to the normal Node 22 verify job.
3. Initially run the new commands locally/CI and observe missing-script/test failure.
4. Wire service setup with non-secret local CI credentials, readiness checks, database creation, and artifact-free cleanup. Do not upload migration bundles as CI artifacts.
5. Run `npm run verify:v32-fixtures`, `npm run test:migration`, and `TEST_ADMIN_DATABASE_URL=... npm run test:migration:postgres`.

**Acceptance:** CI executes exact Postgres v3.2 → encrypted bundle → fresh v4 pgvector and exact D1 schemas → encrypted bundle → fresh v4 pgvector; no mocked database qualifies for E2E.

**Commit:** `ci: test v3.2 migration on postgres and pgvector`.

### Task 25: Write the user migration guide

**Objective:** Give a cautious operator a complete backup-to-rollback procedure.

**Files:**
- Create: `USER_MIGRATION_GUIDE.md`
- Modify: `README.md`
- Modify: `docs/migration-from-mind-cloud.md`
- Create: `tests/migration/docs.test.mjs`

**TDD steps:**
1. Write a docs test that requires headings/commands/refusal codes and rejects language claiming in-place, automatic R2, or automatic re-embedding support.
2. Run it; expect failure.
3. Write the guide with these required sections:
   - support matrix and explicit first-release limitations;
   - what changes in data (people/nodes split, global-name decisions, renamed/removed fields, dormant→orphan semantics, version numbering, old embeddings discarded);
   - risks (sensitive backup, ambiguity, downtime/writes after snapshot, external object gaps, embedding cost, target divergence);
   - prerequisites and sizing/free-space checklist;
   - source quiescence recommendation and backup verification for PostgreSQL (`pg_dump` plus restore test) and D1;
   - exact manual remote D1 export example: `npx wrangler d1 export <DATABASE_NAME_OR_BINDING> --remote --output ./backups/resonant-mind-v3.2.sql` and a warning that the migrator never runs it;
   - R2 inventory/copy handoff and independent object backup;
   - encrypted export and explicitly unencrypted alternative;
   - source inspection, policy review with duplicate/enum/timestamp examples, bundle verification, target preflight, dry run, apply, image copy, default full re-embedding, validation, and readiness commands;
   - expected data effects and report interpretation;
   - troubleshooting keyed by every refusal code, including exact refusal message templates;
   - cutover: stop v3 writes, take final export, rerun, validate, update Hyperdrive/R2 configuration manually, deploy, smoke test, and record acknowledgement;
   - rollback: point deployment back to untouched v3 source/R2 config, stop writes to v4, preserve failed artifacts for diagnosis, and never reverse-copy automatically;
   - retention/destruction of sensitive bundles and passphrase files.
4. Update existing docs to link to the guide and remove “not yet released” only when the product is complete.
5. Run docs test and a fresh-shell command walkthrough using `--help` and synthetic fixtures.

**Acceptance:** A user can execute the documented local/D1/Postgres paths without unstated knowledge; unsupported paths and external phases are impossible to mistake as automated.

**Commit:** `docs: add v3.2 to v4 user migration guide`.

### Task 26: Write the agent runbook and exact refusal playbook

**Objective:** Prevent an assisting agent from improvising around safeguards.

**Files:**
- Create: `AGENT_MIGRATION_RUNBOOK.md`
- Modify: `tests/migration/docs.test.mjs`

**TDD steps:**
1. Extend docs tests to require: authorization boundaries, no secret solicitation, backup evidence, source/target identity checks, dry-run gate, decision review, external receipt checks, cutover/rollback, incident stop conditions, and all refusal codes.
2. Run test; expect failure.
3. Write the runbook as a state machine with operator checkpoints. Include exact agent language:
   - fingerprint: `Refused (RMIG-E-SOURCE-FINGERPRINT): this source is not the exact public v3.2 schema. No data was exported and no source changes were made.`
   - nonfresh target: `Refused (RMIG-E-TARGET-NOT-FRESH): the target contains existing objects. Create a brand-new v4 target; this tool will not merge or upgrade in place.`
   - unresolved policy: `Refused (RMIG-E-POLICY-UNRESOLVED): migration choices remain for duplicate names, enum values, timestamps, JSON, references, or sensitive-content findings. Review the decision manifest; I will not guess.`
   - plaintext: `Refused (RMIG-E-BUNDLE-PLAINTEXT-ACK): backups contain sensitive memory data. Use encryption, or explicitly acknowledge the plaintext risk with both required flags.`
   - D1 remote: `Refused (RMIG-E-D1-REMOTE-UNSUPPORTED): remote D1 export is an operator-controlled prerequisite. The migrator did not run Wrangler or access Cloudflare.`
   - images: `Incomplete (RMIG-E-IMAGE-INCOMPLETE): relational data imported, but referenced image objects are missing or unverified. Cutover is not ready.`
   - embeddings: `Incomplete (RMIG-E-REEMBED-INCOMPLETE): legacy vectors were intentionally not copied and the full re-embedding receipt is incomplete. Semantic search is not ready.`
   - receipt mismatch: `Refused (RMIG-E-RECEIPT-MISMATCH): a bundle, policy, target, or external artifact changed after approval. Repeat dry run and validation; do not reuse the old receipt.`
4. Document never to request passwords/API keys in chat, never to weaken fingerprints, never to mark deferred external phases complete, and when to escalate to a maintainer.
5. Run docs test and link-check all paths/commands.

**Acceptance:** The agent path is stricter than the user guide, with explicit stop/ask/continue gates and no bypass language.

**Commit:** `docs: add v3.2 migration agent runbook`.

### Task 27: Final acceptance, security review, and release evidence

**Objective:** Verify the product as a whole and record only reproducible evidence.

**Files:**
- Create: `docs/migration-v32-v4-acceptance.md`
- Modify only if failures require fixes: files introduced above

**Steps:**
1. Run:
   ```bash
   npm ci
   npm run verify:v32-fixtures
   npm run typecheck
   npm test
   npm run test:migration
   TEST_ADMIN_DATABASE_URL=postgres://... npm run test:migration:postgres
   npm run scan:release
   npm audit --audit-level=moderate
   npx wrangler deploy --dry-run --outdir "$RUNNER_TEMP/resonant-mind-worker"
   ```
2. Run two clean E2E rehearsals (tagged PostgreSQL source and tagged D1/SQLite source), then the full fault matrix.
3. Verify `git diff v4.0.1 -- migrations/postgres` is empty, fixture hashes match, source before/after hashes match, bundle/log scans contain no seeded credentials, and only a fresh target changed.
4. Have security review focus on source read-only proof, SQL identifier/value handling, path traversal, encryption/AAD/KDF, secret leakage, receipt tampering, and same-target detection.
5. Record exact command outcomes, support boundaries, known limitations, and links to CI—not real URLs, secrets, or lived data.

**Acceptance:** Both supported source families reach `ready-for-cutover` with local image fixtures and synthetic external embedding receipts; missing R2/embedding phases reliably refuse completion; all checks are green.

**Commit:** `test(migrator): record v3.2 to v4 acceptance evidence`.

---

## Stage boundaries and deliverables

| Stage | Deliverable | Exit check |
|---|---|---|
| 1 | Shared manifest/fingerprint/refusal/report library | Drift cases fail closed with safe reports. |
| 2 | Exact read-only PostgreSQL and D1/SQLite adapters | Tagged schemas pass; mutated schemas refuse; source hashes unchanged. |
| 3 | Encrypted-or-explicit-plaintext checksummed bundle with secret review | Tamper/wrong-key/secret tests pass; no incomplete bundle appears valid. |
| 4 | Reviewed decision manifest and deterministic transform | All duplicate/enum/timestamp/JSON/FK issues resolved explicitly; mapping coverage 100%. |
| 5 | Fresh-v4 preparation, staging, dry run, atomic import | Nonfresh/same targets refuse; failure leaves no partial production import. |
| 6 | Image/R2 interface, default re-embedding plan, receipts, validation/resume | External gaps block completion; every injected crash resumes safely or refuses. |
| 7 | Tagged fixtures, real Postgres/pgvector CI, user guide, agent runbook | Both supported E2E paths pass; docs commands and refusal language are tested. |

## Definition of done

- [ ] Exact public PostgreSQL v3.2 and exact post-0003 D1/SQLite v3.2 are the only accepted sources.
- [ ] PostgreSQL reads are transaction-enforced read-only; SQLite sources are opened read-only; source before/after evidence matches.
- [ ] Remote `wrangler d1 export` is documented as an operator action and never spawned.
- [ ] Bundles are encrypted by default, checksummed, canonical, secret-scanned/reviewed, and tamper-evident.
- [ ] Every semantic ambiguity and lossy transform is represented in a reviewed decision/report.
- [ ] Target is distinct, empty, and prepared from unchanged released v4 migrations.
- [ ] Dry run is mandatory and apply is transactional/resumable.
- [ ] Images and re-embedding are planned and receipted; incomplete external phases prevent completion.
- [ ] Actual tag artifacts run in SQLite and real PostgreSQL/pgvector CI.
- [ ] Fault injection proves no false completion or duplicate import at every checkpoint.
- [ ] `USER_MIGRATION_GUIDE.md` and `AGENT_MIGRATION_RUNBOOK.md` cover data effects, risk, backup, dry run, troubleshooting, cutover, rollback, and exact refusal messages.
- [ ] No code path upgrades v3 in place, edits released v4 migrations, reaches Cloudflare implicitly, copies legacy embeddings, or claims unsupported schemas are safe.
