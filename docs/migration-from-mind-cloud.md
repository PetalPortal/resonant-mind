# Migrating to Resonant Mind v4

For the operator-assisted pre-push candidate, read the [complete user migration guide](../USER_MIGRATION_GUIDE.md) and [strict agent migration runbook](../AGENT_MIGRATION_RUNBOOK.md). They are the source of truth for the exact public v3.2 boundaries, evidence gates, current CLI options, refusals, external handoffs, and manual cutover/rollback. They do not promise a release or support commitment.

## Fresh installations

Create an empty Neon Postgres database with the `vector` extension, set `PG_URL`, and run:

```bash
npm run db:migrate
```

The migration runner records checksums and refuses to modify an existing untracked schema.

## Existing v3.2 installations

An in-place v3.2→v4 migration is **not yet released**. Do not point the fresh-install runner at an existing v3 database.

The required upgrade is staged because v3 and v4 differ in entity uniqueness, people/nodes routing, observation versions, tensions, dormant/orphan semantics, and consolidation provenance:

1. preflight and backup;
2. additive expansion;
3. explicit backfill with audit reports;
4. constraint and row-count validation;
5. v4 Worker deployment and observation period;
6. delayed destructive contraction.

Until that path is reviewed and tested against populated fixtures, keep v3 databases on v3 and create a separate empty database for evaluating v4.

## Private AI-mind deployments

Do not run the public migration chain against a private lived Mind. Private deployments have their own applied migration history and tenant configuration. Promote architecture through source review; never treat a live cognitive database as a public migration fixture.
