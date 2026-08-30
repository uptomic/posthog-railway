# Production promotion runbook

## Preconditions

- The candidate lock and Uptomic-built MCP image identify the same upstream commit.
- Every official component digest is immutable and its embedded revision is an ancestor of the
  candidate commit.
- The candidate Node overlay records the exact official base image, upstream revision and current
  overlay fingerprint; its exact-image Redis and inherited-startup checks have passed.
- Railway production topology and rendered variables have been exported without secret values.
- Manual Railway volume backups exist for PostgreSQL, ClickHouse, and object storage.
- PostgreSQL PITR is healthy and a logical dump has completed a disposable restore drill.
- The two locked ClickHouse bridge images and the locked release migrator have completed in order
  against the restored production ledger.
- The isolated `cyclotron_node` PostgreSQL database has been migrated by the locked `sqlx-migrate`
  image using `/migrations/bin/migrate-entry cyclotron-node` with
  `CYCLOTRON_NODE_DATABASE_URL` set; `DATABASE_URL` alone is ignored by this entrypoint.
- The current application bundle and every current service image digest are recorded for rollback.

The fresh-schema canary is necessary but not sufficient for production. Promotion also requires a
restore-based rehearsal against representative production PostgreSQL, ClickHouse, and object-storage
data because the inherited deployment predates the current candidate by several months.

## Canary

1. Create an isolated Railway environment with fresh volumes.
2. Restore a recent logical PostgreSQL dump and a bounded ClickHouse/object-storage sample.
3. If the restored ClickHouse ledger predates migration 0210, run Migration Bridge 1, Migration
   Bridge 2, and then the release migrator. Require a successful terminal marker from each one-shot
   job before continuing.
4. Migrate the isolated `cyclotron_node` database with
   `/migrations/bin/migrate-entry cyclotron-node` from the locked `sqlx-migrate` image. Set
   `CYCLOTRON_NODE_DATABASE_URL` on the migrator; setting only `DATABASE_URL` does not select the
   Cyclotron database.
5. Start PersonHog Replica and Router, then Node CDP services. Session replay requires both
   `recordings-blob-ingestion-v2` and `recording-api` modes from the same candidate Node overlay. Point Web
   and Worker `RECORDING_API_URL` at Recording API, share `INTERNAL_API_SECRET`, and enable
   PersonHog on Web, Worker, and Node consumers. Run the Cyclotron janitor from the
   candidate Node overlay with `PLUGIN_SERVER_MODE=cdp-cyclotron-v2-janitor`; the retired standalone
   janitor image is not part of the candidate. Recording API must resolve
   `SESSION_RECORDING_API_REDIS_HOST` from its own working complete authenticated `REDIS_URL`, not a
   bare private hostname or a URL with `?family=6`; see the [Redis client contract](private-networking.md#recording-api-redis-client).
6. Require Web readiness, worker readiness, capture ingestion, ClickHouse query visibility, feature
   flag evaluation, session replay upload, and authenticated UI access. Feature Flags must share
   Web's `SECRET_KEY`; otherwise encrypted remote configuration cannot be decrypted.
   Require real `/login` HTML and `/_preflight` from each Web replica, not only `/` returning 302
   or `/_livez` returning 200. `CDP_API_URL` must reach the running Plugins `cdp-api` process on
   private port 6738; a deployment labelled successful with an exited process does not pass.
7. Require MCP initialization, `project-get`, and a bounded aggregate query using a read-only key.
8. Run the versioned gateway config and verify analytics and replay SDK paths through it. Direct
   Web `/e` or `/s` redirects are not an ingestion pass. Follow the [gateway contract](gateway.md).
9. Rehearse the [private-network contract](private-networking.md) using the production address
   family. An IPv4-only rehearsal does not prove the inherited environment's private IPv6 paths.

## Production

1. Enter the maintenance window and create named pre-upgrade backups.
2. Record the active writer deployment IDs, explicitly remove those active deployments, and verify
   that no writer deployment remains running before taking the final logical metadata dump. Do not
   treat `region=0` scaling as a pause: Railway removes that region configuration and can fall back
   to `us-west2=1`, leaving a writer running.
3. For the inherited pre-0210 ClickHouse ledger, run both locked bridge images in order. Then run
   migrations with the locked upstream main image. Keep writers paused until all three jobs succeed.
4. Run the locked SQLx Cyclotron migration against the isolated `cyclotron_node` database using
   `CYCLOTRON_NODE_DATABASE_URL`, not `DATABASE_URL` alone.
5. Deploy the application bundle in dependency order: data dependencies, PersonHog Replica,
   PersonHog Router, Web and workers, Node CDP services including both session-recording modes, then
   ingestion/query services and the Caddy gateway. The candidate Node overlay keeps the official image's built-in
   command; service behavior is selected through documented environment variables. Supply all
   [Livestream settings](livestream.md) formerly injected by the legacy wrapper.
6. Keep `Capture` as the gateway and `PostHog-Capture-Backend` as the official capture service. Set
   Web, Worker, and Temporal Django Worker `CAPTURE_INTERNAL_URL` to the backend and
   `CAPTURE_REPLAY_INTERNAL_URL` to Replay Capture. Move `posthog.uptomic.com` to the gateway and
   update its Cloudflare CNAME while preserving proxying; do not change Career Mentor SDK settings.
   Preserve managed challenges for application/UI paths while excluding the
   [documented SDK and health paths](gateway.md#cloudflare-sdk-and-health-exceptions).
7. Set MCP runtime `PORT` and all of its Railway generated/custom domain target ports to 3000; do
   not retain the inherited 8080 domain target.
8. Apply the explicit IPv6 listener settings in the plan and verify every
   [private dependency path](private-networking.md). A public `/_livez` 200 is not private-connectivity
   proof; PersonHog gRPC and its IPv4-only metrics/readiness listeners are separate checks.
9. Verify public health, event capture, query results, feature flags, replay, authenticated PostHog,
   MCP, and Pulse's governed PostHog aggregate before leaving the window.

### Scoped application-only correction

For a reviewed application-only correction that needs no schema change, retain the migration and
backup evidence and change only the affected service configuration. Re-read both current and staged
Railway configuration before applying it. Use `environmentPatchCommit` with the exact production
environment and a minimal explicit service patch; do not commit an unrelated staged change set.
Some `serviceInstanceUpdate` fields can affect other non-fork environments, so do not use that
mutation as a presumed environment-local update.

For the Node Redis compatibility correction, promote Plugins/CDP first. Require at least three
minutes of actual running process state plus fast `/login` and `/_preflight` from both Web replicas
before promoting the other four Node roles to the same digest. Preserve commands, modes, ports,
health checks, credentials and topology. Check whether the patch already created a deployment before
requesting another, and retain only the changed fields for rollback. Do not restart databases or
unrelated application services as part of this correction.

## Rollback

- If migrations remain backward compatible, redeploy the recorded prior application bundle.
- If migrations are not backward compatible, stop writers, restore the named PostgreSQL backup or
  PITR sibling, restore any affected ClickHouse/object-storage volume, and redeploy the prior bundle.
- Do not partially roll back one PostHog application service.
