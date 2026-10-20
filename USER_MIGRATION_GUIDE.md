# v3.2 to v4 operator-assisted migration guide

This is the operator-facing guide for the pre-push release candidate. It documents a deliberate, operator-assisted data move; it is not a release announcement, a support commitment, or permission to upgrade a live system without rehearsal. Read this with [the strict agent runbook](AGENT_MIGRATION_RUNBOOK.md).

## Scope and hard boundary

The migrator reads a source snapshot and writes only to a separately verified, fresh v4 PostgreSQL target. It does not upgrade a v3 database in place, delete v3 data, deploy Workers, switch Hyperdrive, copy R2 objects automatically, call an embedding provider automatically, or cut over automatically.

## Support matrix

The exact supported relational source families are:

| Source | Boundary | Required condition |
|---|---|---|
| Public PostgreSQL v3.2.0 | Supported for the relational export/import path | Exact public v3.2 catalog fingerprint, including the expected PostgreSQL/pgvector shape. |
| Public final D1/SQLite v3.2.0 | Supported for the relational export/import path | Exact final SQLite catalog from `0001_init.sql`, `0002_enhanced_memory.sql`, and `0003_graph_health.sql`; use a local SQLite file or a local SQL export. |
| Remote Cloudflare D1 | Manual export handoff only | The operator runs the remote export and supplies the resulting local SQL file. The CLI never opens the Cloudflare API. |
| Fresh v4 PostgreSQL + pgvector | Only target supported by the importer | Distinct database with no non-system objects; released v4 migrations are applied by the target-preparation phase. |

Drifted, partial, private, pre-`0003`, post-v3.2, unknown, or mixed schemas are refused. Existing v4 targets, SQLite targets, D1 targets, and the source itself are not import targets. This table is a first-release implementation boundary, not a product support promise.

### Source and target safety

1. Treat the v3 source as read-only. PostgreSQL inspection/export uses a repeatable-read read-only snapshot; SQLite opens read-only. Never run migration DDL against the source.
2. Use a new local D1 export file. The export is materialized into a temporary SQLite database; the source SQL file is not rewritten.
3. Use a fresh target identity every time. The target must be distinct from the source and empty of non-system objects. Do not “make room” by deleting rows.
4. Keep connection values out of command arguments. Use `env:VARIABLE_NAME` references such as `env:RMIG_SOURCE` and `env:RMIG_TARGET`; never paste a URL, password, token, key, or passphrase into chat, a ticket, a log, or an argv example.

## What changes in the data

The bundle is deterministic and every transformed row is bound to a `migration_id`, source/bundle hash, policy hash, and audit report. No transformation is silently guessed.

- **Entities, names, and kind:** v3 `entities` routes to v4 `people` or `nodes`. Known kinds are normalized to the v4 checks (for example `kin` to `peer_ai`, and `AI peer`/`peer_ai` to `peer_ai`). A collision-free source ID is retained when valid. A final kind must be reviewed when it is not unambiguous.
- **Duplicate names:** v4 has a globally unique name surface where v3 may have repeated names by `primary_context`. Each collision requires a reviewed `merge` or `rename` decision. A merge names every source ID, one survivor, and deterministic field rules for `name`, kind, context, salience, and timestamps. A rename supplies the final unique name for every affected source ID. Dependent IDs and name-based relation endpoints use the same final map. Unresolved collisions refuse.
- **Observation versions:** `observation_versions.changed_at` becomes `edited_at`; `version_num` is generated in `(observation_id, changed_at, id)` order. Invalid or tied timestamps need an explicit stable-ID tie-break and policy entry.
- **Timestamps and dates:** Accept a strict RFC 3339 timestamp with an offset, or SQLite's exact UTC `YYYY-MM-DD HH:MM:SS` form. Other values, naive timestamps, and epoch-like values are policy items. A reviewed timezone is required before normalization to RFC 3339 UTC. Dates require a valid ISO date or a reviewed date mapping. Every point-in-time column of v3.2 is covered (a test checks the list against both exact source schemas). PostgreSQL's microseconds are kept to the last digit; a fraction finer than a microsecond is refused, never rounded. A PostgreSQL `timestamptz` is exported as RFC 3339 text in UTC, so the row hashes in any decision draft made by an earlier build of this migrator no longer match: such a draft is refused as stale, and you draft the decisions again from a new bundle.
- **Enums and contexts:** Known enum aliases are normalized. Unknown enum values, entity kinds, and contexts need a reviewed mapping to a value allowed by v4 checks; the default is refusal, not coercion.
- **JSON:** `links`, `connections`, `tags`, `source_observation_ids`, `data`, and `sit_notes` are parsed and checked for their expected array/object shape. Invalid JSON is a policy item. It may be mapped only with a reviewed, shape-preserving choice; it is never silently replaced with `[]`.
- **Foreign keys:** Integer and name references are remapped through the final ID/name map. A broken or excluded reference is refused unless a reviewed policy explicitly excludes or nulls a nullable link. Stale source IDs never survive just because an insert would accept them.
- **Dormancy:** `dormant_observations` becomes v4 `orphan_observations` under the documented semantic translation. Attempts and timestamps are preserved and the terminology change is reported.
- **Tensions:** `tensions.sit_count` becomes visits. `status` and `sit_notes` have no direct v4 columns, so every affected row needs a reviewed action such as preserving visits and opening, or preserving visits and resolving with explicit resolution fields. The source row remains represented in the audit/loss report.
- **NULLs that v4 fills in:** v3.2 lets `entities.created_at`, `entities.updated_at`, `entities.salience` and `entities.primary_context` be NULL. v4's own entity routing trigger replaces a NULL `created_at` or `updated_at` with the *import time*, a NULL `salience` with `'active'` and a NULL `primary_context` with `'default'`, in `people`/`nodes`. The migrator does not choose this; it records every case as a `null-replaced-by-v4-default` entry in the loss and audit report (one per row and field), carries it into the dry-run and validation reports, and `validate` checks that the target holds exactly that default (for the timestamps, exactly the import transaction's time, read from the importer's own receipt record) and that every recorded case is visible in the target.
- **Fields without a released target:** Values such as v3 observation access/validity/supersession fields and other dropped fields are listed in the audit report with a reason. They are not silently erased from the accounting of loss.
- **Images:** Image metadata rows and references are transformed after ID decisions. Local image files can be copied through the filesystem adapter. Existing R2 objects require an independent operator/provider transfer and a verified external receipt; metadata migration does not prove object availability.
- **Vectors:** Old v3 embedding vectors and external Vectorize state are inventoried and discarded from the target payload. They are never copied into v4 `embeddings` or a vector index. The tool produces a re-embedding job plan for transformed searchable text and image records. Provider execution and receipt production remain external. Until receipts validate, the state is `data-imported-not-search-ready`, not complete.

## Backup and restore rehearsal

Do not begin source inspection until both the backup and restoration rehearsal are evidenced. A backup file existing on disk is not enough: record its size, checksum, source identity, creation time, restricted permissions, and a successful restore/read-only verification without placing secrets in the evidence.

### PostgreSQL v3 backup and restore rehearsal

Use the operator's secret-managed source reference; the placeholders below are not credentials:

```bash
pg_dump --format=custom --file <v3-backup.dump> "$PG_SOURCE"
sha256sum <v3-backup.dump>
createdb "$PG_RESTORE_NAME"
pg_restore --exit-on-error --dbname "$PG_RESTORE" <v3-backup.dump
```

Run `inspect-source` against the restored database using `env:RMIG_RESTORE`, compare the catalog fingerprint and table counts with the original inspection report, and record the restore result. Do not restore over the source. Keep the original dump untouched until the migration and cutover decision are closed.

### D1 manual remote export and rehearsal

Remote Cloudflare D1 manual export command:

```bash
npx wrangler d1 export <binding-or-name> --remote --output <local.sql>
```

Inspect the file, checksum it, and rehearse loading it into a new local SQLite database. Supply only that local file as `--source-kind d1-export --source <local.sql>`. A D1 name, URL, or remote binding passed to the CLI must refuse with `RMIG-E-D1-REMOTE-UNSUPPORTED`.

### Independent image/R2 backup

Back up image objects independently of the relational bundle using the provider's approved R2 export/backup mechanism. Record the object inventory, object keys, sizes, MIME findings, per-object checksums, destination, and operator/provider receipt. Do not treat the relational bundle, an R2 listing, or the migrator's image metadata as an object backup.

R2 handoff is operator-assisted: a human or separately authorized provider job performs the copy, then supplies a signed receipt and trusted public-key file to `copy-images --adapter r2`. An unsigned JSON file, a missing object, or a partial copy is not completion. Automatic R2/network transfer is unsupported by this lane.

## Encryption and sensitive artifacts

Encrypted bundles are the default. Use a permission-restricted passphrase file with `--passphrase-file <passphrase-file>`; the passphrase itself must never appear in argv, chat, shell history, or an artifact. The bundle envelope records KDF metadata, not the passphrase.

Plaintext is an exceptional, explicitly acknowledged mode. It requires both flags, exactly as implemented:

```text
--allow-plaintext-bundle --acknowledge-plaintext-risk
```

The choice is recorded in the manifest and report, and secret scanning still runs. Do not “fix” a plaintext refusal by removing one flag or by copying sensitive members elsewhere.

## Operator command sequence

Every step below is a command of the checked-in CLI, and the whole sequence needs nothing else: the CLI drafts the decisions, applies your review, builds the plan, prepares and fills the target, and validates against the live source and target itself. Run `node scripts/v32-to-v4/cli.mjs --help` for every command with its options, or `node scripts/v32-to-v4/cli.mjs <command> --help` for one; the help is checked against the parsers by a test, so it cannot drift. `--json` may be added to any command for structured result or refusal output on stdout. Values in angle brackets are placeholders, not secrets.

Set secret-bearing environment variables through the operator's secret manager, then use only `env:RMIG_SOURCE` and `env:RMIG_TARGET` references in commands. A passphrase is only ever a file.

**Connections.** Use a direct (non-pooled) connection for the migration wherever the provider offers one. Neon does: its pooled endpoint (the host name with `-pooler`) is PgBouncer in transaction mode, the direct one is not. The source is read in a single read-only transaction and its session settings (`TimeZone`, `DateStyle`, `search_path`, `extra_float_digits`) are set inside that transaction with `set_config`, not as connection options, so a transaction-mode pooler does not break the read the way a startup option would. That has been tested against a session whose defaults differ, not against Neon or PgBouncer themselves, so treat a pooled endpoint as unproven. If a pooler refuses the transaction or the settings, you will see `RMIG-E-SOURCE-DRIFT` ("PostgreSQL source inspection failed" or "did not apply the snapshot session settings") or `RMIG-E-SOURCE-NOT-READONLY`; switch to the direct connection. The target phases (`prepare-target`, `dry-run`, `import`, `validate`) run the released migrations and take advisory locks inside transactions, so use a direct connection for the target as well. The CLI verifies TLS to the target; for a local PostgreSQL without TLS put `sslmode=disable` in the URL held by the environment variable, and `PG_SSL_NO_VERIFY=1` keeps TLS but skips certificate verification.

### 1. Inspect the source

```bash
node scripts/v32-to-v4/cli.mjs inspect-source \
  --source-kind postgres \
  --source env:RMIG_SOURCE \
  --report <source-report.json>
```

For a local SQLite or D1 export, use `--source-kind sqlite` or `--source-kind d1-export` and a local path. Continue only when the report says the exact public v3.2 catalog matched. The report includes row counts, ambiguity counts, image inventory, and old-vector inventory.

### 2. Export an encrypted bundle

```bash
node scripts/v32-to-v4/cli.mjs export \
  --source-kind postgres \
  --source env:RMIG_SOURCE \
  --source-report <source-report.json> \
  --source-fingerprint <actual-fingerprint> \
  --migration-id <migration-id> \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file>
```

The source report and fingerprint options are accepted by the current parser. For the exceptional plaintext mode, replace the passphrase option with both explicit acknowledgement flags. Never mix the modes.

### 3. Verify the bundle

```bash
node scripts/v32-to-v4/cli.mjs verify-bundle \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file>
```

Use the same passphrase file and unchanged bundle. Verification checks stored-byte hashes, authenticated decryption, manifest hash, member counts, and NDJSON hashes.

### 4. Draft the decisions

```bash
node scripts/v32-to-v4/cli.mjs draft-decisions \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --out <decisions-draft.json>
```

The draft lists every value the migrator will not decide for you: duplicate entity names, entity kinds outside the v4 vocabulary, timestamps without an offset, malformed JSON, unknown enum values and contexts, broken foreign keys and name references, dormant observations, and tensions. Each item states why, which choices are allowed (`allowed_choices`), and which extra fields a choice needs (`required_choice_fields`). Nothing is guessed and no item has a choice, so a draft cannot be compiled. The command never overwrites an existing file.

### 5. Review the decisions and apply the review

The decision owner edits the draft: add a `choice` to every item, either one of its `allowed_choices` as a string, or an object whose `action` is one of them plus the fields it requires, for example `{ "action": "normalize-utc", "timezone": "+01:00" }`, `{ "action": "rename", "names": { "<id>": "<new name>", "<id>": "<new name>" } }`, or `{ "action": "preserve-visits-and-open", "last_visited": "<RFC 3339 time>" }`. Then:

```bash
node scripts/v32-to-v4/cli.mjs apply-decisions \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --decisions <decisions-draft.json> \
  --reviewed-by "<name of the decision owner>" \
  --out <decisions-reviewed.json>
```

`apply-decisions` selects nothing itself. It records who reviewed and when, recomputes the manifest hash, and applies the library's validation against the verified bundle: an item without a choice, a wildcard, a choice the item does not allow, a choice missing a required field, a stale or extra item, or a draft made for a different bundle is refused (`RMIG-E-POLICY-UNRESOLVED` or `RMIG-E-POLICY-MISMATCH`) and no file is written.

### 6. Compile the policy

```bash
node scripts/v32-to-v4/cli.mjs compile-policy \
  --bundle <bundle.rmigrate> \
  --decisions <decisions-reviewed.json> \
  --out <compiled-policy.json> \
  --passphrase-file <passphrase-file>
```

### 7. Build the relational plan

```bash
node scripts/v32-to-v4/cli.mjs plan-relational \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --compiled-policy <compiled-policy.json> \
  --out <relational-staging-plan.json>
```

The compiled policy must be unchanged since `compile-policy` wrote it and bound to this bundle. The plan holds every v4 row, the loss report (what is dropped, what v4 fills in), the image inventory and the re-embedding job plan. A reviewed decision that produces a row v4 cannot hold is a refusal, not a skipped row. The command prints the `bundle_manifest_sha256` and `compiled_policy_sha256` that `prepare-target` takes. The plan and the compiled policy contain the migrated content in plaintext: keep them with the same care as the bundle's contents.

### 8. Inspect and prepare the fresh target

```bash
node scripts/v32-to-v4/cli.mjs inspect-target \
  --target env:RMIG_TARGET \
  --source env:RMIG_SOURCE

node scripts/v32-to-v4/cli.mjs prepare-target \
  --target env:RMIG_TARGET \
  --source env:RMIG_SOURCE \
  --migration-id <migration-id> \
  --bundle-manifest-sha256 <bundle-manifest-sha256> \
  --compiled-policy-sha256 <compiled-policy-sha256> \
  --plan <relational-staging-plan.json>
```

For a SQLite or D1-export source add `--source-kind sqlite` (or `d1-export`) and give the local path as `--source`; the identity checked against the target is then the file's. `inspect-target` must report a distinct fresh target. A concurrent session's temporary tables do not count as objects; a user table, any other schema, an extension other than `vector`, a view, a sequence, a function or a type does. `prepare-target` applies the released v4 migration set unchanged, verifies its checksums, creates a run-scoped staging schema and prints its name (`schema=`). The optional `--resume-schema <schema>` input is intentionally rejected: there is no general resume contract, so discard an interrupted target and restart against a fresh target. Existing/nonempty, same-source, or wrong-schema targets refuse.

### 9. Dry run, then import

```bash
node scripts/v32-to-v4/cli.mjs dry-run \
  --target env:RMIG_TARGET \
  --plan <relational-staging-plan.json> \
  --staging-schema <staging-schema> \
  --receipt-out <dry-run-receipt.json>

node scripts/v32-to-v4/cli.mjs import \
  --target env:RMIG_TARGET \
  --plan <relational-staging-plan.json> \
  --dry-run <dry-run-receipt.json> \
  --staging-schema <staging-schema> \
  --receipt-out <import-receipt.json>
```

Do not import without a successful dry-run receipt bound to the same plan, target identity, schema, policy, bundle, and migrator version. This is a gate, not a suggestion. The import commits once; the receipt path is reserved before it runs, so a committed import is never left without its receipt file (the same receipt is also recorded in the target's `migration_import_receipts` table).

### 10. Plan and hand off images

Current image parsers use inventory/plan files:

```bash
node scripts/v32-to-v4/cli.mjs plan-images \
  --input <image-inventory.json> \
  --out <image-plan.json> \
  --migration-id <migration-id> \
  --bundle-manifest-sha256 <bundle-manifest-sha256> \
  --compiled-policy-sha256 <compiled-policy-sha256>

node scripts/v32-to-v4/cli.mjs copy-images \
  --plan <image-plan.json> \
  --adapter filesystem \
  --source <image-source-directory> \
  --target <image-target-directory> \
  --receipt-out <image-receipt.json>
```

For the external R2 handoff, use the same `copy-images` command with `--adapter r2 --external-receipt <external-r2-receipt.json> --trusted-public-key <trusted-public-key.pem>` instead of filesystem source/target. The operator/provider supplies the receipt; the CLI validates it and does not perform the network copy.

### 11. Plan provider re-embedding

```bash
node scripts/v32-to-v4/cli.mjs plan-reembed \
  --input <relational-staging-plan.json> \
  --images <image-plan.json> \
  --out <reembed-plan.json> \
  --migration-id <migration-id> \
  --bundle-manifest-sha256 <bundle-manifest-sha256> \
  --compiled-policy-sha256 <compiled-policy-sha256>
```

The provider/network job is external. Do not claim readiness until every planned job has an independently verifiable receipt, or a reviewed defer decision reports `data-imported-not-search-ready`.

### 12. Validate against the live systems, then read status

```bash
node scripts/v32-to-v4/cli.mjs validate \
  --bundle <bundle.rmigrate> \
  --passphrase-file <passphrase-file> \
  --decisions <decisions-reviewed.json> \
  --plan <relational-staging-plan.json> \
  --source-kind postgres \
  --source env:RMIG_SOURCE \
  --target env:RMIG_TARGET \
  --migration-id <migration-id> \
  --dry-run-receipt <dry-run-receipt.json> \
  --import-receipt <import-receipt.json> \
  --image-plan <image-plan.json> \
  --image-receipt <image-receipt.json> \
  --reembed-plan <reembed-plan.json> \
  --reembed-receipts <reembed-receipts.json> \
  --out <validation-report.json>

node scripts/v32-to-v4/cli.mjs status \
  --report <validation-report.json> \
  --cutover-evidence <cutover-evidence.json> \
  --operator-cutover-ack
```

`validate` reads the live source and the live target itself; it does not take snapshot files. The image and re-embedding options are optional, and `--trusted-public-key <trusted-public-key.pem>` is needed to verify a signed external image receipt. Read-only throughout, it checks:

- **The decisions and the plan.** The reviewed decisions compile (again) to the policy the plan was built from, and the plan is exactly what that policy produces from the bundle.
- **The receipts.** The dry-run and import receipts are internally valid, derived from this plan, bound to this bundle, policy and target, and the import receipt equals the record the importer committed inside the target.
- **The source.** The live source still holds, row for row, what the bundle holds, with the same catalog fingerprint; a source that moved since the export is a finding.
- **The target, column by column.** Every mapped column of every source row is compared with what the target holds, in exact text: timestamps as exact microsecond instants (not text, not milliseconds), JSON as a value, numbers, ids, and text byte for byte. A cell may differ from the source only where the reviewed policy accounts for that exact cell (a remapped id, an enum alias, a normalized timestamp, a reviewed decision, a v4 default for a NULL), and each such difference is counted by kind in the report. The plan is then compared with the target row by row as well. Missing rows, extra rows and duplicates are findings.
- **The target's own integrity.** Every constraint validated, every index valid, every foreign key re-proved with an anti-join, every unique index free of duplicates, every CHECK expression re-evaluated against the stored rows, every id sequence beyond the largest id, every entity routed to exactly one people/nodes row, observation versions numbered without gaps and in time order, the released migration set recorded.
- **External evidence.** Supplied image and re-embedding receipts are validated against their plans, and the re-embedding plan must be the one these imported rows produce. Evidence that is not supplied is not an error: the state stays `data-imported-images-pending` or `data-imported-not-search-ready`, never `ready-for-cutover`. A plan with no images, or no jobs, has nothing external to prove.

The report states counts, sanctioned differences by kind, invariants and findings by check (table, column, and an integer id or a hash of the key, never row content), and its hash. Any finding makes `validate` write the report with status `refused` and exit with `RMIG-E-VALIDATION`; it never overwrites an earlier report. `status` must be read after validation and after any separately created cutover evidence. It does not perform cutover.

## Risks, sizing, and quiescence

- **Write races:** Quiesce v3 writes before inspection and keep the source frozen through the final comparison. If writes cannot be stopped, do not present a static export as a cutover source.
- **Semantic loss:** Review the loss/audit report, not just row counts. A row-count match can coexist with changed kind, timestamps, JSON, FK, tension, or dormancy meaning.
- **Target capacity:** Size from the source report's table counts, bundle member bytes, transformed plan size, image inventory, and re-embedding job count. Reserve working space for the encrypted bundle, temporary D1 materialization, reports, and staging overhead; do not substitute a fixed generic estimate.
- **Database pressure:** The dry run is the capacity and invariant check. Watch connection limits, transaction duration, lock/wait time, staging growth, and pgvector/index build time. Stop if the target changes unexpectedly or the operator cannot retain receipts.
- **Image/object divergence:** Metadata can import while an object copy is incomplete. Treat each object receipt and checksum as a separate gate.
- **Search readiness:** Data import is not search readiness. Legacy vectors are discarded and provider re-embedding is external.
- **Cutover risk:** A valid migration report does not deploy or switch application traffic. Schedule a human-approved maintenance window and retain untouched v3 until acceptance is complete.

## Troubleshooting

Every refusal is fail-closed. Refusals use exit code 2 (`2`), human text on stderr by default, and JSON on stdout when --json is set. Unexpected internal failures use exit code 1 (`1`); success is 0 (`0`). Preserve the refusal report and apply only its remediation—never suppress it or edit an artifact to make a check pass.

| Code | Meaning and operator action |
|---|---|
| `RMIG-E-NODE-VERSION` | Node is below 22. Run with Node.js 22 or newer. |
| `RMIG-E-SOURCE-ARG` | A source kind/path or command option is missing/invalid. Use only the documented parser options. |
| `RMIG-E-SOURCE-FINGERPRINT` | The source is not the exact public v3.2 schema. Restore a supported snapshot; do not infer compatibility. |
| `RMIG-E-SOURCE-DRIFT` | The source changed or drifted during the operation, or the database did not apply the snapshot session settings. Restore an unchanged snapshot and restart inspection; if the source is behind a connection pooler, use the direct connection. |
| `RMIG-E-SOURCE-NOT-READONLY` | Source access was not read-only. Grant read-only access and rerun. |
| `RMIG-E-D1-REMOTE-UNSUPPORTED` | A remote D1 name/URL was supplied. Run the manual `wrangler d1 export` and use the local SQL file. |
| `RMIG-E-D1-SQL-UNSAFE` | The D1 SQL export contains unsupported statements/schema. Produce a standard local export. |
| `RMIG-E-BUNDLE-PLAINTEXT-ACK` | Plaintext mode lacks both explicit flags. Use encryption or provide both flags after risk review. |
| `RMIG-E-BUNDLE-INTEGRITY` | Bundle members or hashes changed. Regenerate from the verified source. |
| `RMIG-E-BUNDLE-DECRYPT` | The passphrase does not match the unchanged bundle. Use the correct secret-managed passphrase file. |
| `RMIG-E-SECRET-DETECTED` | Secret scanning found a sensitive value. Remove or resolve the finding before continuing. |
| `RMIG-E-POLICY-UNRESOLVED` | A decision remains unresolved. Review every policy item and compile again. |
| `RMIG-E-POLICY-MISMATCH` | Policy is not bound to this unchanged bundle. Compile against the exact bundle. |
| `RMIG-E-SAME-SOURCE-TARGET` | Source and target identities are the same. Choose a distinct fresh v4 PostgreSQL database. |
| `RMIG-E-TARGET-NOT-FRESH` | Target has non-system objects. Choose another empty target; never delete rows to bypass the gate. |
| `RMIG-E-TARGET-SCHEMA` | Target schema or released migration set is wrong. Prepare a fresh target with the exact released schema. |
| `RMIG-E-DRY-RUN-REQUIRED` | Apply was attempted without an accepted matching dry-run receipt. Complete the bound dry run. |
| `RMIG-E-DRY-RUN` | PostgreSQL staging dry run did not pass. Resolve the reported invariant/capacity issue and rerun on a clean target. |
| `RMIG-E-TARGET-CHANGED` | Target identity/schema changed after preparation. Restore the expected target state and rerun staging and dry-run validation. |
| `RMIG-E-ENTITY-COMPAT` | Entity compatibility/routing is inconsistent. Regenerate the plan with reviewed `people`/`nodes` routing. |
| `RMIG-E-RECEIPT-MISMATCH` | A receipt is not bound to the exact migration inputs. Regenerate it from the unchanged inputs. |
| `RMIG-E-IMAGE-INCOMPLETE` | An image object is missing or its receipt is incomplete. Complete and verify every planned copy. |
| `RMIG-E-REEMBED-INCOMPLETE` | Re-embedding receipts are incomplete. Finish the external job or use a reviewed defer policy. |
| `RMIG-E-CHECKPOINT` | Checkpoint chain or artifact binding is invalid. Do not splice or edit it; use a new clean run. |
| `RMIG-E-CHECKPOINT-FAULT` | Test fault injection is enabled outside its test context. Unset it and rerun. |
| `RMIG-E-VALIDATION` | Final validation found a violation. The report is written anyway (status `refused`, findings by check). Resolve every finding and validate again to a new report path. |
| `RMIG-E-COMMAND-UNKNOWN` | Command is not listed. Run `--help` and choose a listed command. |
| `RMIG-E-COMMAND-NOT-IMPLEMENTED` | The named phase is not implemented in this checkout. Use an implemented phase; do not invent flags or bypass the phase. |

The exact refusal form is:

```text
<RMIG-E-CODE>: <safe summary> <remediation>. Report: <safe report path>
```

With `--json`, preserve `{ code, phase, summary, safe_details, remediation, report_path }`. Never paste secret-bearing details into the report or chat.

## Interruption and restart

There is no general end-to-end resume contract for an operator run. The CLI exposes bounded checkpoint plumbing for internal artifact binding, but that is not permission to resume an arbitrary interrupted migration or reuse a partially written target. If an import, target preparation, image handoff, provider phase, or validation is interrupted or its evidence is ambiguous:

1. stop and preserve the receipts and logs;
2. do not retry writes into the interrupted target;
3. verify the untouched v3 source and backup;
4. discard/quarantine the target according to the operator's retention policy;
5. start again on a new fresh target with the same or a new reviewed migration ID, after checking artifact hashes.

A repeated command is not a proof that a partial target is safe.

## Cutover and rollback

Cutover is a human action after `validate` and `status` show readiness and the operator has separately recorded:

- source quiescence and final source identity;
- backup and restore rehearsal evidence;
- target identity, fresh-state evidence, and migration-set hash;
- policy, dry-run, import, image, re-embedding, and validation receipts;
- application smoke-test evidence on v4;
- a named approver and maintenance-window decision.

During cutover, stop writes, route the application to v4 through the normal deployment/change process, run smoke tests, and record the exact time and target identity. The migrator does not deploy, switch routing, or delete v3.

Rollback means stop v4 traffic and restore the application to the untouched v3 database using the normal operational change process. There is no reverse copy from v4 to v3. Do not mutate v3 to “undo” a cutover and do not delete the v3 backup until the retention window and acceptance decision are complete.

## Sensitive artifact retention

Keep the encrypted bundle, manifests, decisions, the compiled policy and the relational staging plan (both hold the migrated content in plaintext), source/target reports, image inventory, external receipts, and validation evidence only for the approved audit/rollback window. Restrict filesystem and object permissions, keep passphrases outside the artifact directory, and do not place sensitive values in filenames, logs, chat, or issue trackers. After the window, destroy the bundle, plaintext temporary exports, local D1 materializations, passphrase file, copied image staging area, and provider handoff artifacts using the organization's approved secure-destruction procedure. Retain only redacted hashes and non-sensitive evidence required by policy.
