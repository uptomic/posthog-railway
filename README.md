# Uptomic PostHog Railway release bundle

This repository keeps Uptomic's self-hosted PostHog deployment aligned with upstream PostHog
without allowing Railway services to drift independently.

PostHog does not publish versioned self-hosted releases. Upstream ships continuously from
`PostHog/posthog` `master`, so an Uptomic release is defined by one immutable bundle:

- the upstream Git commit;
- the exact OCI digest and embedded upstream revision of every published component image;
- Uptomic-built `main`, `node`, and `mcp` images from that same commit;
- the Railway service-to-image and start-command plan;
- completed migration, API, ingestion, UI, MCP, and rollback checks.

## Release flow

1. `bun run lock:resolve` resolves current upstream `master` and official component image digests.
2. `bun run check` rejects mutable tags, unknown sources, malformed digests, or component revisions
   that are not ancestors of the locked upstream commit.
3. The scheduled GitHub workflow builds candidate `main`, `node`, and `mcp` images from the exact
   locked commit and publishes immutable SHA tags to GHCR.
4. `bun run railway:plan` renders the coordinated application-service update. It does not apply it.
5. Production promotion requires verified volume backups, migration completion, a canary smoke run,
   and explicit application of the complete bundle. Never update PostHog services one at a time.

## Safety rules

- Never deploy a mutable `latest` or `master` tag to Railway production.
- Never mix PostHog application images from different release bundles.
- Never run migrations before Railway volume backups and a logical PostgreSQL restore drill exist.
- Keep data services and application services separate. PostgreSQL, ClickHouse, Redpanda/Kafka,
  Redis/Valkey, object storage, and Temporal upgrades have their own compatibility checks.
- Candidate builds may follow upstream daily. Production follows only candidates that pass the full
  compatibility and restore gates.
- Roll back application images as one bundle. Restore data only when migrations are not backward
  compatible and the rollback runbook explicitly requires it.

## Current baseline

The inherited Railway template was built on 2026-01-31 from PostHog commit
`9373a2b55081d3e711ad58bca060a6a9ab5d41a5`. The PostHog MCP service was later built from a much
newer source snapshot, which created the API/MCP version skew this repository is designed to prevent.
