# Production promotion runbook

## Preconditions

- The candidate lock and Uptomic-built MCP image identify the same upstream commit.
- Every official component digest is immutable and its embedded revision is an ancestor of the
  candidate commit.
- Railway production topology and rendered variables have been exported without secret values.
- Manual Railway volume backups exist for PostgreSQL, ClickHouse, and object storage.
- PostgreSQL PITR is healthy and a logical dump has completed a disposable restore drill.
- The current application bundle and every current service image digest are recorded for rollback.

The fresh-schema canary is necessary but not sufficient for production. Promotion also requires a
restore-based rehearsal against representative production PostgreSQL, ClickHouse, and object-storage
data because the inherited deployment predates the current candidate by several months.

## Canary

1. Create an isolated Railway environment with fresh volumes.
2. Restore a recent logical PostgreSQL dump and a bounded ClickHouse/object-storage sample.
3. Deploy the complete candidate application bundle and run official migrations once.
4. Require Web readiness, worker readiness, capture ingestion, ClickHouse query visibility, feature
   flag evaluation, session replay upload, and authenticated UI access.
5. Require MCP initialization, `project-get`, and a bounded aggregate query using a read-only key.

## Production

1. Enter the maintenance window and create named pre-upgrade backups.
2. Pause nonessential workers and take the final logical metadata dump.
3. Run migrations with the locked upstream main image.
4. Deploy the complete application bundle in dependency order: Web/migrator, workers, Node services,
   then Rust ingestion/query services.
5. Verify public health, event capture, query results, feature flags, replay, authenticated PostHog,
   MCP, and Pulse's governed PostHog aggregate before leaving the window.

## Rollback

- If migrations remain backward compatible, redeploy the recorded prior application bundle.
- If migrations are not backward compatible, stop writers, restore the named PostgreSQL backup or
  PITR sibling, restore any affected ClickHouse/object-storage volume, and redeploy the prior bundle.
- Do not partially roll back one PostHog application service.
