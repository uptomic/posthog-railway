import candidatePayload from "../posthog.candidate.json";
import lockPayload from "../posthog.lock.json";
import type { CandidateRelease, PosthogLock } from "./lib/upstream";

const candidate = candidatePayload as CandidateRelease;
const lock = lockPayload as PosthogLock;
export const gatewayCaddyfile = await Bun.file(
  new URL("../config/gateway.Caddyfile", import.meta.url),
).text();
export const gatewayStartCommand =
  'sh -c \'printf "%s" "$CADDY_CONFIG" | caddy run --config - --adapter caddyfile\'';

export function assertCandidateMatchesLock(candidate: CandidateRelease, lock: PosthogLock): void {
  if (candidate.upstreamCommit !== lock.upstreamCommit) {
    throw new Error("Built candidate does not match the locked PostHog release");
  }
}
export const railwayPlan = {
  bundle: lock.upstreamCommit,
  notes: [
    "This is a read-only plan. Backups and canary verification are required before apply.",
    "Data-service upgrades are intentionally separate from this application bundle.",
    "Run the one-shot migrator before starting Web or any writer.",
    "For the inherited pre-0210 ClickHouse ledger, run both replay-schema bridges in order before the release migrator.",
    "CDP_VALKEY_HOST must reference a dedicated Valkey-compatible service before Node services start.",
    "PersonHog Replica and PersonHog Router must start before any Node CDP service.",
    "Node services must use the official image CMD; the legacy wrapper is absent from the image.",
    "Pause production writers by removing their active deployments and verifying they stopped; Railway region=0 removes the region configuration and can fall back to us-west2=1.",
    "The inherited Capture service is the public Caddy gateway; PostHog-Capture-Backend runs the official capture image.",
    "Move posthog.uptomic.com to the Capture gateway and update its Cloudflare CNAME; Career Mentor SDK configuration stays unchanged.",
    "Production private DNS resolves IPv6; public health or IPv4 rehearsal success does not prove private connectivity. Verify every dependency from its caller.",
  ],
  services: {
    ClickHouse: { image: candidate.images.clickhouse, startCommand: "" },
    "PostHog Migration Bridge 1": {
      image: lock.migrationBridges["pre-session-replay-ai"].image,
      restartPolicy: "NEVER",
      startCommand: "./bin/migrate --scope=clickhouse",
    },
    "PostHog Migration Bridge 2": {
      image: lock.migrationBridges["pre-session-replay-surfacing"].image,
      restartPolicy: "NEVER",
      startCommand: "./bin/migrate --scope=clickhouse",
    },
    "PostHog Release Migrator": {
      image: lock.officialImages.main.image,
      restartPolicy: "NEVER",
      startCommand: "./bin/migrate",
    },
    "Cyclotron Schema Migrator": {
      image: lock.officialImages["sqlx-migrate"].image,
      restartPolicy: "NEVER",
      startCommand: "/migrations/bin/migrate-entry cyclotron-node",
    },
    "PersonHog Replica": {
      image: lock.officialImages["personhog-replica"].image,
      environment: { GRPC_ADDRESS: "[::]:50051" },
    },
    "PersonHog Router": {
      image: lock.officialImages["personhog-router"].image,
      environment: { GRPC_ADDRESS: "[::]:50052" },
    },
    Web: {
      image: lock.officialImages.main.image,
      startCommand: "./bin/docker-server",
      environment: { GRANIAN_HOST: "::" },
    },
    Worker: {
      image: lock.officialImages.main.image,
      startCommand: "./bin/docker-worker-celery --with-scheduler",
    },
    "Temporal Django Worker": {
      image: lock.officialImages.main.image,
      startCommand: "./bin/temporal-django-worker",
    },
    Plugins: { image: lock.officialImages.node.image },
    "posthog-ingestion": { image: lock.officialImages.node.image },
    "Recordings Blob Ingestion V2": {
      image: lock.officialImages.node.image,
      pluginServerMode: "recordings-blob-ingestion-v2",
    },
    "Recording API": {
      image: lock.officialImages.node.image,
      pluginServerMode: "recording-api",
      environment: { SESSION_RECORDING_API_REDIS_HOST: "${{REDIS_URL}}" },
    },
    "Cyclotron V2 Janitor": {
      image: lock.officialImages.node.image,
      pluginServerMode: "cdp-cyclotron-v2-janitor",
    },
    "Feature Flags": {
      image: lock.officialImages["feature-flags"].image,
      environment: { ADDRESS: "[::]:3001" },
    },
    "PostHog-Capture-Backend": {
      image: lock.officialImages.capture.image,
      serviceId: "27dff4e2-fedd-4633-98fc-27556efd5cd5",
      startCommand: "",
      healthcheckPath: "/_readiness",
      port: 3000,
      environment: { ADDRESS: "[::]:3000" },
    },
    "Replay Capture": {
      image: lock.officialImages.capture.image,
      environment: { ADDRESS: "[::]:3000" },
    },
    "Property Defs RS": { image: lock.officialImages["property-defs-rs"].image },
    Livestream: {
      image: lock.officialImages.livestream.image,
      port: 8080,
      environment: {
        PORT: "8080",
        LIVESTREAM_MMDB_PATH: "/GeoLite2-City.mmdb",
        LIVESTREAM_CONSUMERS_EVENT_ENABLED: "true",
        LIVESTREAM_CONSUMERS_EVENT_TOPIC: "events_plugin_ingestion",
        LIVESTREAM_CONSUMERS_EVENT_SECURITY_PROTOCOL: "PLAINTEXT",
        LIVESTREAM_CONSUMERS_EVENT_GROUP_ID: "livestream-production",
        LIVESTREAM_CONSUMERS_SESSION_RECORDING_ENABLED: "true",
        LIVESTREAM_CONSUMERS_SESSION_RECORDING_TOPIC: "session_recording_snapshot_item_events",
        LIVESTREAM_CONSUMERS_SESSION_RECORDING_SECURITY_PROTOCOL: "PLAINTEXT",
        LIVESTREAM_CONSUMERS_SESSION_RECORDING_GROUP_ID: "livestream-session-recordings-production",
        LIVESTREAM_CONSUMERS_NOTIFICATION_ENABLED: "false",
        LIVESTREAM_REDIS_PORT: "6379",
        LIVESTREAM_CORS_ALLOW_ORIGINS: "https://posthog.uptomic.com",
      },
    },
    Capture: {
      image: lock.supportingImages.gateway,
      serviceId: "bacb342e-f790-4234-845d-98c0bde19c99",
      role: "public-gateway",
      startCommand: gatewayStartCommand,
      healthcheckPath: "/health",
      port: 3000,
      configSource: "config/gateway.Caddyfile",
      environment: { PORT: "3000", CADDY_CONFIG: gatewayCaddyfile },
    },
    "PostHog MCP": {
      image: candidate.images.mcp,
      port: 3000,
      domainTargetPort: 3000,
      environment: { PORT: "3000" },
    },
  },
  requiredWiring: {
    privateNetworking: [
      "Use the IPv6-capable listener settings in this plan for production private DNS; do not replace them with 0.0.0.0",
      "Verify Gateway to Web/Capture/Replay/Flags/Livestream, Web/Worker to Recording API and PersonHog Router, and Router to Replica over private DNS",
      "Node shared HTTP listeners omit host and use the IPv6 unspecified address when available; no HOST override is supported or required",
      "PersonHog metrics/readiness listeners remain hardcoded IPv4 on 9100/9101; GRPC_ADDRESS only changes application RPC listeners",
    ],
    gateway: [
      "CADDY_CONFIG must be the unchanged contents of config/gateway.Caddyfile; PORT must be 3000",
      "CAPTURE_INTERNAL_URL must point to PostHog-Capture-Backend on private HTTP port 3000",
      "CAPTURE_REPLAY_INTERNAL_URL must point to Replay Capture on private HTTP port 3000",
      "FEATURE_FLAGS_INTERNAL_URL must point to Feature Flags on private HTTP port 3001",
      "LIVESTREAM_INTERNAL_URL must point to Livestream on private HTTP port 8080",
      "WEB_INTERNAL_URL must point to Web on private HTTP port 8000",
    ],
    mcpService: [
      "PORT must be 3000 and every Railway generated/custom MCP domain must target port 3000, not inherited port 8080",
    ],
    livestreamService: [
      "LIVESTREAM_CONSUMERS_EVENT_BROKERS and LIVESTREAM_CONSUMERS_SESSION_RECORDING_BROKERS must point to production Kafka",
      "LIVESTREAM_JWT_SECRET must match Web SECRET_KEY without exposing its value",
      "LIVESTREAM_REDIS_ADDRESS must point to the private Valkey hostname and LIVESTREAM_REDIS_PORT must be 6379",
      "Set the explicit Livestream environment in this plan; the official image does not supply the inherited wrapper's config",
    ],
    cyclotronSchemaMigrator: [
      "CYCLOTRON_NODE_DATABASE_URL must point to the isolated cyclotron_node PostgreSQL database",
      "DATABASE_URL alone is ignored by /migrations/bin/migrate-entry cyclotron-node",
    ],
    mainImageServices: [
      "PERSONS_DB_WRITER_URL and PERSONS_DB_READER_URL must point to the existing PostHog database",
      "FEATURE_FLAGS_SERVICE_URL must point to Feature Flags on its private port",
      "CLICKHOUSE_LOGS_CLUSTER_HOST and CLICKHOUSE_LOGS_CLUSTER_SECURE must match the ClickHouse transport",
      "SKIP_ASYNC_MIGRATIONS_SETUP must be absent or false for production migration",
      "CYCLOTRON_NODE_DATABASE_URL must point to the isolated cyclotron_node PostgreSQL database",
      "RECORDING_API_URL must point to Recording API on its private port",
      "INTERNAL_API_SECRET must match between Web, Worker, and Recording API",
      "PERSONHOG_ENABLED must be true and PERSONHOG_ADDR must point to PersonHog Router on its private gRPC port",
      "CAPTURE_INTERNAL_URL must point to PostHog-Capture-Backend, not the public Capture gateway",
      "CAPTURE_REPLAY_INTERNAL_URL must point to Replay Capture",
    ],
    nodeServices: [
      "CDP_VALKEY_HOST and CDP_VALKEY_PORT must point to the dedicated Valkey-compatible service",
      "PERSONHOG_ENABLED must be true and PERSONHOG_ADDR must point to PersonHog Router on its private gRPC port",
      "CYCLOTRON_NODE_DATABASE_URL must point to the migrated isolated cyclotron_node PostgreSQL database",
      "Recordings Blob Ingestion V2 and Recording API must be running before session replay can pass end to end",
      "Recording API must use the same INTERNAL_API_SECRET as Web and Worker",
    ],
    recordingApiService: [
      "SESSION_RECORDING_API_REDIS_HOST must resolve to this service's working REDIS_URL: a complete authenticated Redis URL, not a bare hostname",
      "The locked ioredis client defaults to IPv4 for hostnames; a bare IPv6-only private hostname fails DNS resolution",
      "Do not append ?family=6 to the URL: ioredis passes the query value as a string, not the numeric family option",
      "Reuse the working Redis URL without rebuilding or replacing the locked official Node image",
    ],
    personHogServices: [
      "PersonHog Replica PRIMARY_DATABASE_URL must point to the existing PostHog persons database",
      "PersonHog Router REPLICA_URL must point to PersonHog Replica on its private gRPC port",
      "Replica GRPC_ADDRESS must be [::]:50051 and Router GRPC_ADDRESS must be [::]:50052 for production private IPv6",
    ],
    featureFlagsService: [
      "SECRET_KEY must match the PostHog Web SECRET_KEY so encrypted remote configuration can be decrypted",
      "MAXMIND_DB_PATH must point to the GeoLite2 database bundled in the feature-flags image",
    ],
  },
};

if (import.meta.main) {
  // Lock resolution runs structural tests before building the matching candidate.
  // Enforce release compatibility when emitting a plan, not when tests import it.
  assertCandidateMatchesLock(candidate, lock);
  console.log(JSON.stringify(railwayPlan, null, 2));
}
