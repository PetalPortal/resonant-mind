# Strict agent migration runbook

This runbook governs an agent or automation operator performing the operator-assisted v3.2 to v4 pre-push release-candidate speedrun. It is stricter than the user guide: an agent may gather evidence, create local artifacts, and invoke the checked-in CLI, but it may not grant authorization, handle secrets in chat, approve semantic decisions, perform hidden network/provider work, or perform cutover.

The agent must read [USER_MIGRATION_GUIDE.md](USER_MIGRATION_GUIDE.md) first. The guide is the command and refusal reference; this document is the state machine and stop policy.

## State machine

Only the following transitions are legal. A failed gate has no forward transition.

```text
UNAUTHORIZED
  -> AUTHORIZED
  -> BACKUP_EVIDENCE_ACCEPTED
  -> SOURCE_IDENTITY_ACCEPTED
  -> DECISIONS_ACCEPTED
  -> BUNDLE_VERIFIED
  -> FRESH_TARGET_ACCEPTED
  -> DRY_RUN_ACCEPTED
  -> IMPORT_ACCEPTED
  -> EXTERNAL_EVIDENCE_ACCEPTED
  -> VALIDATION_ACCEPTED
  -> CUTOVER_READY
  -> CUTOVER_OPERATOR_APPROVED
  -> COMPLETE_OR_ROLLED_BACK
```

The agent must persist a redacted state record containing state, `migration_id`, artifact hashes, report paths, timestamps, and the human decision that allowed each transition. It must never persist a secret value. A missing, stale, contradictory, or unbound receipt moves the run to `STOPPED`, not to the next state.

There is no general end-to-end resume contract. After an interruption in target preparation/import, image handoff, provider work, or validation, the agent preserves evidence, quarantines the partial target, and restarts on a new fresh target after gates are repeated. Checkpoint flags are bounded implementation plumbing, not a bypass or a promise that a partial target can be trusted.

## Authorization gate

### `UNAUTHORIZED -> AUTHORIZED`

The agent may proceed only when a human operator has explicitly supplied all of the following in the approved control surface:

- source family: public PostgreSQL v3.2.0 or public final D1/SQLite v3.2.0;
- target identity class: a distinct fresh v4 PostgreSQL database;
- migration purpose, maintenance window, and named approver;
- permission to create local encrypted artifacts and to run the listed read-only/source and fresh-target commands;
- decision owner for ambiguous data semantics;
- rollback owner and retention/destruction window.

“Please migrate it,” a source URL in prose, a credential pasted into chat, or a green CI job is not sufficient authorization. The agent must not infer approval to cut over, delete v3, copy R2 objects, call an embedding provider, or deploy routing.

**Exact stop language:**

```text
STOP: authorization is incomplete. No migration command, target write, external handoff, or cutover is authorized.
```

## Secret boundary

The agent must never request, accept, repeat, print, inspect into chat, or store in a normal transcript:

- PostgreSQL/D1/R2 credentials, URLs containing credentials, passwords, tokens, API keys, private keys, or passphrases;
- a one-time code or provider approval;
- raw environment values or secret-manager output;
- plaintext bundle content when redacted metadata is enough.

Use secret-managed environment variables and pass only references such as `env:RMIG_SOURCE` and `env:RMIG_TARGET`. Use `--passphrase-file <passphrase-file>` with an operator-controlled restricted file. If a page, person, log, or tool output offers a secret, do not echo it; stop and request the operator to place it in the approved secret manager.

**Exact stop language:**

```text
STOP: a secret or credential crossed the agent/chat boundary. Do not paste it here; rotate or quarantine it through the approved secret-management process.
```

## Backup evidence gate

### `AUTHORIZED -> BACKUP_EVIDENCE_ACCEPTED`

Before source inspection, require a redacted evidence record for:

1. PostgreSQL: `pg_dump` completed, dump checksum recorded, restricted permissions confirmed, restore into a separate rehearsal database succeeded, and `inspect-source` on the restore matched the source fingerprint and material table counts.
2. D1: `npx wrangler d1 export <binding-or-name> --remote --output <local.sql>` completed by the operator, local SQL checksum recorded, and loading into a new local SQLite database succeeded without editing the export file.
3. Images/R2: independent provider backup/export or operator backup completed, inventory and per-object checksums recorded, and the handoff/restore rehearsal is named. A relational bundle is not an object backup.

The agent verifies evidence metadata and report bindings. It does not ask for a dump's password or copy a secret-bearing backup into the chat. If evidence is missing, old, unbound to the source identity, or only asserted in prose:

```text
STOP: backup and restore rehearsal evidence is missing or not bound to this source. Do not inspect, export, import, or cut over.
```

## Identity and freshness gate

### `BACKUP_EVIDENCE_ACCEPTED -> SOURCE_IDENTITY_ACCEPTED`

Run `inspect-source` with the exact current parser options from the user guide. Confirm all of these before export:

- Node.js is 22 or newer;
- source kind is one of `postgres`, `sqlite`, or `d1-export`;
- source identity is redacted but stable and matches the backup evidence;
- source access is read-only;
- catalog fingerprint is the exact public v3.2 PostgreSQL or final D1/SQLite fingerprint;
- no source drift occurred during the repeatable snapshot;
- ambiguity, image, and old-vector inventories are present;
- a remote D1 name/URL was not passed to the CLI.

Do not classify a private, partial, drifted, pre-`0003`, post-v3.2, or unknown schema as “close enough.” The exact refusal is:

```text
STOP: RMIG-E-SOURCE-FINGERPRINT: the source is not the exact supported public v3.2 schema. Restore an unchanged supported snapshot and restart inspection.
```

For a remote D1 input:

```text
STOP: RMIG-E-D1-REMOTE-UNSUPPORTED: export the remote D1 database manually and provide the unchanged local SQL file.
```

## Export and bundle gate

After source identity passes, export an encrypted bundle by default. Verify the bundle before any policy compilation. Check:

- `migration_id` is unique for this run and is recorded in every subsequent artifact;
- bundle manifest, member hashes, source report, and source fingerprint agree;
- secret scan passed;
- passphrase is referenced only by a restricted file path;
- plaintext mode is absent unless the human approver explicitly accepted the risk and both `--allow-plaintext-bundle` and `--acknowledge-plaintext-risk` are present;
- plaintext acknowledgement is recorded in the manifest and state record.

If verification fails, do not copy a member from another bundle, edit `checksums.sha256`, reuse a partially generated directory, or continue with a different decision file.

```text
STOP: RMIG-E-BUNDLE-INTEGRITY or RMIG-E-BUNDLE-DECRYPT: the bundle is not unchanged and verified. Regenerate or use the matching secret-managed passphrase file; do not repair it in place.
```

## Decision review gate

### `SOURCE_IDENTITY_ACCEPTED -> DECISIONS_ACCEPTED`

The agent runs `draft-decisions` on the verified bundle. The draft lists every ambiguity as an item with its allowed choices and no choice selected; the agent identifies candidates from it. Only the authorized decision owner may approve semantics: the owner (not the agent) supplies the `choice` of every item, and the agent writes exactly those choices into the draft. The agent then runs `apply-decisions --reviewed-by "<the decision owner's name>"`, never its own name and never a name the owner did not give, followed by `compile-policy` and `plan-relational`. `apply-decisions` selects nothing: it refuses an item without a choice, a wildcard, a choice the item does not allow, a missing required field, a stale or extra item, and a draft made for another bundle. The agent must show a redacted, hash-bound review list covering:

- duplicate entity names: merge survivor plus field rules, or final names for deterministic rename;
- final entity kind and `people`/`nodes` routing;
- enum, context, and status mappings;
- ambiguous timestamps/timezones and dates;
- malformed JSON shape-preserving mappings;
- broken/excluded FK treatment, including nullable nulling;
- observation-version ordering/tie breaks;
- dormancy/orphan translation;
- tension action for `status`, `sit_notes`, visits, and resolution;
- each declared loss and its audit reason;
- re-embedding defer/required choice, with its resulting readiness state.

The agent must apply and compile the policy only after every item is resolved and the decisions hash matches the unchanged bundle. It must not fill missing decisions with defaults, choose a merge survivor for convenience, translate malformed JSON to an empty container, or approve a loss because row counts look plausible.

```text
STOP: RMIG-E-POLICY-UNRESOLVED: a semantic decision is unresolved. Return the item to the decision owner; do not infer or coerce it.
```

```text
STOP: RMIG-E-POLICY-MISMATCH: the reviewed policy is not bound to this unchanged bundle. Recompile against the exact bundle.
```

## Fresh-target gate

### `DECISIONS_ACCEPTED -> BUNDLE_VERIFIED -> FRESH_TARGET_ACCEPTED`

The agent must run `inspect-target --target env:RMIG_TARGET --source env:RMIG_SOURCE` (for a SQLite or D1-export source: `--source-kind` and the local path) and capture the redacted identity. A concurrent session's temporary tables are not target objects; every other user object, schema or extension but `vector` is. Accept it only when:

- the target identity is distinct from the source identity;
- target is PostgreSQL with pgvector;
- there are no non-system objects;
- target owner/permissions allow the approved operation;
- no other run owns the target;
- the released v4 migration set and checksum are the expected ones.

Never use the source as target, an existing v4 database, SQLite/D1, or a database made empty by destructive cleanup. Never edit released migration files to satisfy a fingerprint.

```text
STOP: RMIG-E-SAME-SOURCE-TARGET or RMIG-E-TARGET-NOT-FRESH: target identity is unsafe. Choose a distinct empty v4 PostgreSQL target; do not delete rows or bypass the gate.
```

If the catalog or migration set differs:

```text
STOP: RMIG-E-TARGET-SCHEMA: the target does not have the exact released v4 schema/migration set. Prepare a new fresh target without changing the released migrations.
```

## Dry-run receipt gate

### `FRESH_TARGET_ACCEPTED -> DRY_RUN_ACCEPTED`

Run `prepare-target` (with the relational plan from `plan-relational`), then `dry-run` with `--receipt-out`. The compiled policy and the relational plan hold the migrated content, so `compile-policy` and `plan-relational` write them encrypted with the migration passphrase file, and every command that reads them (`prepare-target`, `dry-run`, `import`, `plan-images`, `plan-reembed`, `validate`) takes the same `--passphrase-file`. The agent never writes either as plaintext (`--allow-plaintext-artifact --acknowledge-plaintext-risk`) unless the human operator has authorized that exact exception, and no command overwrites an existing output: use new paths. Require a successful receipt bound to all of:

- `migration_id`;
- source identity and source report hash;
- bundle manifest hash;
- compiled policy hash;
- target identity/fingerprint;
- migrator version and migration-set hash;
- staging schema;
- relational plan and external image/re-embedding plan hashes.

Review transformed counts, excluded rows, losses, FK findings, invariant findings, target pressure, image inventory, and old-vector inventory. A dry run is not an import authorization if any input changed after it was created.

```text
STOP: RMIG-E-DRY-RUN-REQUIRED or RMIG-E-DRY-RUN: no matching accepted dry-run receipt exists. Do not apply; regenerate the bound dry run on a clean target.
```

## Import gate and target write

### `DRY_RUN_ACCEPTED -> IMPORT_ACCEPTED`

The agent may invoke `import` (with `--receipt-out` for the import receipt) only after a human or policy-controlled operator has acknowledged the dry-run receipt. Before invocation, re-read the source/target identities and all artifact hashes. The importer must write only to the fresh prepared target and must not mutate the source.

If the target changed, the receipt mismatches, or entity compatibility routing is inconsistent:

```text
STOP: RMIG-E-TARGET-CHANGED, RMIG-E-RECEIPT-MISMATCH, or RMIG-E-ENTITY-COMPAT: bound inputs or target state changed. Do not retry into this target; preserve evidence and restart on a new fresh target.
```

A successful relational import is not complete. It is only the `IMPORT_ACCEPTED` state pending image, provider, validation, and cutover evidence.

## External phase evidence gate

### `IMPORT_ACCEPTED -> EXTERNAL_EVIDENCE_ACCEPTED`

External work is explicit and separately authorized:

- **R2/images:** an operator or separately authorized provider job copies objects. The agent may make an inventory, create a plan, and validate a signed receipt with a trusted public key. The image plan is taken from the relational plan with `plan-images --plan`; `validate` accepts no other image plan, so a smaller, empty or different plan is a finding even with a matching receipt. It must not obtain hidden R2 credentials, automatically copy over the network, accept unsigned JSON, or declare metadata-only success.
- **Re-embedding:** an operator/provider executes the generated plan. The agent may validate receipts, not invoke a provider with hidden credentials. Old vectors remain discarded. If the policy intentionally defers this phase, the state is `data-imported-not-search-ready` and cannot become complete/search-ready by wording alone.
- **Network/provider state:** no automatic network phase is inferred from a local job plan, a provider configuration, or a generated command. Require external receipts with the same hashes and `migration_id`.

```text
STOP: RMIG-E-IMAGE-INCOMPLETE: image objects or signed external receipt are incomplete. Complete the operator/provider handoff and validate every planned object.
```

```text
STOP: RMIG-E-REEMBED-INCOMPLETE: provider receipts are incomplete. Finish the external job or record a reviewed defer state; do not claim search readiness.
```

## Validation and status gate

### `EXTERNAL_EVIDENCE_ACCEPTED -> VALIDATION_ACCEPTED`

Run the exact `validate` and `status` commands in the user guide. `validate` reads the live source and the live target itself (read-only) and writes a report; the agent supplies the verified bundle, the reviewed decisions, the plan, the receipts and any external evidence, not snapshots. It validates:

- the decisions compile to the policy the plan was built from, and the plan is what that policy produces from the bundle;
- the live source still equals the bundle, row for row;
- every mapped column of every source row against the live target (exact text, timestamps to the microsecond), each difference accounted for by a recorded policy entry, and the plan against the target;
- the target's constraints, indexes, foreign keys, CHECK expressions, sequences, routing, version order and migration-set record (only the released v4 schema's own CHECK expressions are evaluated; any other CHECK in the target is a finding and is never run);
- declared losses, including the `null-replaced-by-v4-default` entries for NULLs that v4 fills in;
- image plan/receipt completeness and signature trust, where the image plan must be the planned inventory and every imported image row must be listed in it, and the re-embedding plan/receipts, whose receipts are checked against the content the target holds now (supplied evidence is validated; evidence not supplied leaves the state at `data-imported-images-pending` or `data-imported-not-search-ready`, never ready);
- dry-run and import receipts, the import receipt against the target's own record;
- report hash and `migration_id`, and, with a passphrase file, a keyed seal on the report.

Any finding makes `validate` exit with `RMIG-E-VALIDATION` (exit code 2) after writing the report with status `refused`; the report path is in the refusal (or the refusal says the path is withheld, because it contained text that looks like a secret; the report is then at the `--out` the agent gave). Pass `--passphrase-file` to `validate` and to `status`. `status` is a report reader and readiness calculator; it never changes target state, and it reports a state only for a report whose hash is its own and whose keyed seal verifies. A report without a seal is shown as `unverified` and is not proof; a report whose seal fails, or cutover evidence that does not validate, exits 2 as `refused`. The agent never treats an `unverified` or `refused` status as readiness. A report with violations is not “mostly ready.” The agent never reruns `validate` to a path it has already used, edits a report to clear a finding, or points `validate` at a different source, target or plan to make a check pass.

```text
STOP: RMIG-E-VALIDATION: validation found a violation. Resolve every finding and rerun validation; do not edit the report or suppress the violation.
```

## Stop conditions

Stop immediately and move to `STOPPED` if any of the following occurs:

- authorization, backup evidence, approver, or rollback owner is missing;
- any secret enters chat, logs, argv, or an artifact;
- source access is not read-only or source drift is detected;
- source/target is not an exact allowed family, or target is not fresh and distinct;
- a required decision is unresolved or policy/bundle hashes mismatch;
- dry-run receipt is absent, stale, or mismatched;
- target state changes between gates;
- a refusal is returned;
- image/R2 or re-embedding work is merely asserted without a receipt;
- a command is missing from current `--help`/parser behavior;
- an operator asks to skip a gate, edit a receipt, reuse a partial target, or force completion;
- an interruption makes the target state or evidence ambiguous.

The agent must not “continue carefully” after a stop condition. It reports the exact refusal code or missing evidence, the safe remediation, and the state at which it stopped.

## Refusal language and no bypass

All migration refusals are structured with `code`, `phase`, `summary`, `safe_details`, `remediation`, and `report_path`. By default they are human text on stderr with exit code `2`; with `--json`, they are JSON on stdout. Unexpected internal failures use exit code `1`.

Use this exact shape and never invent a reassuring synonym:

```text
STOP: <RMIG-E-CODE>: <safe summary>. Remediation: <the refusal remediation>. No bypass is permitted.
```

The complete current refusal-code list and operator remediation are in the guide's [Troubleshooting](USER_MIGRATION_GUIDE.md#troubleshooting) table. Every code is a hard stop, including argument errors and checkpoint faults. Do not:

- remove a refusal-producing check;
- pass a different target/source to make a hash match;
- edit a report, receipt, manifest, decision file, or checksum after creation;
- use `--json` to hide a refusal;
- substitute `--allow-plaintext-bundle` for a missing passphrase policy;
- treat an unsigned R2 receipt as valid;
- copy old vectors to make search appear ready;
- retry an interrupted write into the same target;
- perform cutover because a local command returned exit code `0` without complete external evidence.

## Cutover and rollback

### `VALIDATION_ACCEPTED -> CUTOVER_READY`

The agent prepares a redacted cutover packet containing validation/status output, all artifact hashes, backup/restore evidence, target identity, source quiescence evidence, application smoke-test results, maintenance window, named approver, and rollback owner. The agent may state that the packet is ready; it may not switch traffic.

### `CUTOVER_READY -> CUTOVER_OPERATOR_APPROVED`

A named human operator separately approves the cutover after reviewing the packet. The agent must record the approval and exact time, then remain within the approved change procedure. Automatic cutover is unsupported. The agent does not deploy Workers, flip Hyperdrive, delete v3, or destroy the target/source.

### `CUTOVER_OPERATOR_APPROVED -> COMPLETE_OR_ROLLED_BACK`

The operator performs the traffic change and smoke tests. The agent records external evidence only if supplied by the operator or read back from the approved operational system. If acceptance fails, rollback is to the untouched v3 deployment/database through the normal operational process. There is no reverse copy from v4 to v3. Keep v3 and its backup through the retention window.

**Exact cutover refusal:**

```text
STOP: cutover is not an agent action. Provide named human approval and perform the normal deployment/change procedure; no automatic cutover or reverse copy is available.
```

## Artifact retention and destruction

The agent keeps only redacted paths, hashes, state transitions, and safe summaries in chat. The operator owns retention of encrypted bundles, decisions, reports, image inventories, external receipts, temporary D1 files, copied image staging, and provider handoff material. Passphrases remain outside the artifact directory.

At the approved end of the rollback/audit window, the operator securely destroys sensitive artifacts and confirms destruction without returning their contents. The agent must not delete the untouched v3 database, backup, or evidence merely because status is complete; destruction requires the separate retention decision.
