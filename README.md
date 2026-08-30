# Uptomic PostHog Railway release bundle

This repository keeps Uptomic's self-hosted PostHog deployment aligned with upstream PostHog
without allowing Railway services to drift independently.

PostHog does not publish versioned self-hosted releases. Upstream ships continuously from
`PostHog/posthog` `master`, so an Uptomic release is defined by one immutable bundle:

- the upstream Git commit;
- the exact OCI digest, creation time, and embedded upstream revision of every published component
  image;
- PostHog's official `main` and `posthog-node` bases locked by digest, an Uptomic-built Node
  compatibility overlay, and Uptomic-built MCP and ClickHouse images from the exact release commit;
- exact predecessor images used only as one-shot ClickHouse migration bridges for the inherited
  pre-0210 ledger;
- a separately digest-pinned Caddy gateway and one versioned SDK routing configuration;
- the Railway service-to-image and start-command plan;
- completed migration, API, ingestion, UI, MCP, and rollback checks.

## Release flow

1. `bun run lock:resolve` resolves current upstream `master` and official component image digests.
2. `bun run check` rejects mutable tags, unknown sources, malformed digests, or component revisions
   that are not ancestors of the locked upstream commit.
3. The scheduled GitHub workflow locks PostHog's official application digests, rejects a
   `posthog-node` publication more than 72 hours old, builds `mcp` from the exact locked commit, and
   rebuilds ClickHouse from PostHog's pinned ClickHouse base plus that commit's config and UDF assets.
   The ClickHouse build also layers a narrowly scoped Railway runtime configuration: bounded thread
   pools, one wildcard listener, edge-terminated TLS, console logging, local single-node cluster
   discovery, environment-backed credentials for distributed self-connections, and a localhost-only
   dictionary reader required by PostHog's local-single schema alongside the authenticated
   Railway network user. Its immutable tag
   includes a fingerprint of those build inputs so a runtime-config change cannot silently reuse an old image.
   The Node build applies a guarded, private-host-only Redis address-family correction to the exact
   official base without changing upstream commands or entrypoints. Its immutable tag fingerprints
   both the base and overlay files, and its exact-image tests exercise IPv6 and IPv4 connections.
   All three images are published with provenance and SBOMs to GHCR. Manual workflow runs keep the
   current lock unless `update_upstream=true` is explicitly selected; scheduled runs resolve upstream.
4. A successful build writes a second manifest that pins the built MCP, ClickHouse and Node images
   by OCI digest, including the Node base revision and overlay fingerprint.
5. `bun run railway:plan` renders the coordinated application-service update, including PersonHog,
   the isolated Cyclotron schema migrator, and the Node Cyclotron V2 janitor. It does not apply it.
6. Production promotion requires verified volume backups, migration completion, a canary smoke run,
   and explicit application of the complete bundle in dependency order. Do not independently select
   different component releases. A same-base application-only correction follows the
   [scoped correction runbook](docs/production-promotion.md#scoped-application-only-correction).

## Safety rules

- Never deploy a mutable `latest` or `master` tag to Railway production.
- Never mix PostHog application images from different release bundles.
- Never run migrations before Railway volume backups and a logical PostgreSQL restore drill exist.
- For the inherited ClickHouse ledger, run both locked migration bridges in order and then the
  locked release migrator. Do not skip directly to the release image.
- Run `/migrations/bin/migrate-entry cyclotron-node` from the locked `sqlx-migrate` image against an
  isolated `cyclotron_node` database before starting the Node Cyclotron V2 janitor. Set
  `CYCLOTRON_NODE_DATABASE_URL`; `DATABASE_URL` alone is ignored by that entrypoint.
- Pause production writers by removing their active deployments and verifying they stopped. Do not
  treat Railway `region=0` scaling as a pause; it can restore the default `us-west2=1` replica.
- Run both `recordings-blob-ingestion-v2` and `recording-api` from the same locked Node overlay; replay
  capture alone does not complete the session-recording ingestion path.
- Keep the inherited `Capture` service as the public gateway and run the official capture image in
  `PostHog-Capture-Backend`. The [gateway contract](docs/gateway.md) owns SDK routes, private URLs,
  and the canonical-domain cutover; official Web alone does not route SDK capture paths.
- Start PersonHog Replica and Router before Node CDP services. The candidate Node overlay inherits
  the official built-in command; `PLUGIN_SERVER_MODE` selects each documented service mode.
  Follow the [private-network contract](docs/private-networking.md) for credential-free CDP Valkey
  endpoints, sustained process checks and the Plugins/CDP restart policy.
- Keep data services and application services separate. PostgreSQL, ClickHouse, Redpanda/Kafka,
  Redis/Valkey, object storage, and Temporal upgrades have their own compatibility checks.
- Candidate builds may follow upstream daily. Production follows only candidates that pass the full
  compatibility and restore gates.
- Roll back application images as one bundle. Restore data only when migrations are not backward
  compatible and the rollback runbook explicitly requires it.

## Infisical boundary

Production promotion uses the dedicated `posthog-railway-release` machine identity in Career
Mentor's existing Infisical project. GitHub authenticates with OIDC from the
`uptomic/posthog-railway` repository on `main`; the identity has the built-in `no-access` role plus
one additional privilege that can only describe and read `RAILWAY_API_TOKEN` in `prod` at `/`.
It cannot list or read any other Career Mentor secret.

## Inherited baseline

The inherited Railway template was built on 2026-01-31 from PostHog commit
`9373a2b55081d3e711ad58bca060a6a9ab5d41a5`. The PostHog MCP service was later built from a much
newer source snapshot, which created the API/MCP version skew this repository is designed to prevent.
