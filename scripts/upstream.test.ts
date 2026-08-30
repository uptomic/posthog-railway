import { describe, expect, test } from "bun:test";
import { isSameRelease, officialComponents } from "./lib/upstream";
import type { CandidateRelease, PosthogLock } from "./lib/upstream";
import { nodeOverlayProvenance } from "./lib/node-overlay";
import productionBaseline from "../railway.production.json";
import lockPayload from "../posthog.lock.json";
import candidatePayload from "../posthog.candidate.json";
import {
  assertCandidateMatchesLock,
  gatewayCaddyfile,
  gatewayStartCommand,
  buildRailwayPlan,
} from "./render-railway-plan";

// Structural tests must run before the real candidate is built; this digest is test-only.
const candidateFixture: CandidateRelease = {
  ...candidatePayload,
  upstreamCommit: lockPayload.upstreamCommit,
  images: { ...candidatePayload.images, node: `ghcr.io/uptomic/posthog-railway/node@sha256:${"1".repeat(64)}` },
  nodeOverlay: nodeOverlayProvenance(lockPayload as PosthogLock),
};
const railwayPlan = buildRailwayPlan(candidateFixture, lockPayload as PosthogLock);

describe("PostHog release bundle ownership", () => {
  test("rejects plan generation before the matching candidate is built", () => {
    expect(() =>
      assertCandidateMatchesLock(
        { ...candidateFixture, upstreamCommit: "0".repeat(40) },
        lockPayload as PosthogLock,
      ),
    ).toThrow("Built candidate does not match the locked PostHog release");
  });

  test("accepts a candidate matching the resolved lock", () => {
    const lock = lockPayload as PosthogLock;
    expect(() =>
      assertCandidateMatchesLock(
        { ...candidateFixture, upstreamCommit: lock.upstreamCommit },
        lock,
      ),
    ).not.toThrow();
  });

  test("tracks every externally published PostHog application component used by Railway", () => {
    expect(Object.keys(officialComponents).sort()).toEqual([
      "capture",
      "feature-flags",
      "livestream",
      "main",
      "node",
      "personhog-replica",
      "personhog-router",
      "property-defs-rs",
      "sqlx-migrate",
    ]);
  });

  test("does not accept mutable production image references in the rendered plan", () => {
    for (const service of Object.values(railwayPlan.services)) {
      expect(service.image).toMatch(/^(ghcr\.io\/.+|docker\.io\/library\/caddy)@sha256:[0-9a-f]{64}$/);
    }
  });

  test("preserves Capture as the public gateway and separates the official backend", () => {
    const lock = lockPayload as PosthogLock;
    expect(railwayPlan.services.Capture).toMatchObject({
      image: lock.supportingImages.gateway,
      serviceId: "bacb342e-f790-4234-845d-98c0bde19c99",
      role: "public-gateway",
      port: 3000,
      healthcheckPath: "/health",
      startCommand: gatewayStartCommand,
      configSource: "config/gateway.Caddyfile",
      environment: { PORT: "3000", CADDY_CONFIG: gatewayCaddyfile },
    });
    expect(railwayPlan.services["PostHog-Capture-Backend"]).toMatchObject({
      image: lock.officialImages.capture.image,
      serviceId: "27dff4e2-fedd-4633-98fc-27556efd5cd5",
      healthcheckPath: "/_readiness",
    });
    expect(railwayPlan.services.Web.image).toBe(lock.officialImages.main.image);
  });

  test("owns the gateway SDK routes in one versioned Caddyfile", () => {
    expect(gatewayCaddyfile).toContain("handle /health {\n\t\trespond 200\n\t}");
    expect(gatewayCaddyfile.indexOf("handle /health")).toBeLessThan(
      gatewayCaddyfile.indexOf("handle @replay"),
    );
    expect(gatewayCaddyfile).toContain("@replay path /s /s/ /s/*");
    expect(gatewayCaddyfile).toContain("reverse_proxy {$CAPTURE_REPLAY_INTERNAL_URL}");
    expect(gatewayCaddyfile).toContain("@capture path /e /e/ /e/*");
    expect(gatewayCaddyfile).toContain("/i/v1/analytics/events");
    expect(gatewayCaddyfile).toContain("reverse_proxy {$CAPTURE_INTERNAL_URL}");
    expect(gatewayCaddyfile).toContain("@flags path /flags /flags/ /flags/*");
    expect(gatewayCaddyfile).toContain("/api/feature_flag/local_evaluation");
    expect(gatewayCaddyfile).toContain("reverse_proxy {$FEATURE_FLAGS_INTERNAL_URL}");
    expect(gatewayCaddyfile).toContain("handle_path /livestream*");
    expect(gatewayCaddyfile).toContain("reverse_proxy {$LIVESTREAM_INTERNAL_URL}");
    expect(gatewayCaddyfile).toContain("handle {\n\t\treverse_proxy {$WEB_INTERNAL_URL}");
    expect(gatewayCaddyfile.match(/header_up X-Forwarded-Proto https/g)).toHaveLength(5);
    expect(gatewayCaddyfile).not.toContain("railway.internal");
  });

  test("keeps gateway infrastructure changes distinct from PostHog image resolution", () => {
    const lock = lockPayload as PosthogLock;
    expect(lock.supportingImages.gateway).toMatch(
      /^docker\.io\/library\/caddy@sha256:[0-9a-f]{64}$/,
    );
    expect(isSameRelease(lock, {
      ...lock,
      supportingImages: { gateway: `docker.io/library/caddy@sha256:${"0".repeat(64)}` },
    })).toBe(false);
  });

  test("aligns MCP runtime and domain ports", () => {
    expect(railwayPlan.services["PostHog MCP"]).toMatchObject({
      port: 3000,
      domainTargetPort: 3000,
      environment: { PORT: "3000" },
    });
  });

  test("keeps production private listeners IPv6-capable", () => {
    expect(railwayPlan.services.Web.environment.GRANIAN_HOST).toBe("::");
    expect(railwayPlan.services["PostHog-Capture-Backend"].environment.ADDRESS).toBe("[::]:3000");
    expect(railwayPlan.services["Replay Capture"].environment.ADDRESS).toBe("[::]:3000");
    expect(railwayPlan.services["Feature Flags"].environment.ADDRESS).toBe("[::]:3001");
    expect(railwayPlan.services["PersonHog Replica"].environment.GRPC_ADDRESS).toBe("[::]:50051");
    expect(railwayPlan.services["PersonHog Router"].environment.GRPC_ADDRESS).toBe("[::]:50052");
    expect(railwayPlan.requiredWiring.privateNetworking.join(" ")).toContain(
      "metrics/readiness listeners remain hardcoded IPv4",
    );
  });

  test("provides the Livestream config formerly injected by the legacy wrapper", () => {
    expect(railwayPlan.services.Livestream.environment).toEqual({
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
    });
    const wiring = railwayPlan.requiredWiring.livestreamService.join(" ");
    for (const variable of [
      "LIVESTREAM_CONSUMERS_EVENT_BROKERS",
      "LIVESTREAM_CONSUMERS_SESSION_RECORDING_BROKERS",
      "LIVESTREAM_JWT_SECRET",
      "LIVESTREAM_REDIS_ADDRESS",
    ]) {
      expect(wiring).toContain(variable);
    }
  });

  test("keeps every Node role on the same guarded image and inherited built-in command", () => {
    for (const serviceName of [
      "Cyclotron V2 Janitor",
      "Plugins",
      "posthog-ingestion",
      "Recordings Blob Ingestion V2",
      "Recording API",
    ] as const) {
      expect(railwayPlan.services[serviceName].image).toBe(candidateFixture.images.node);
      expect(railwayPlan.services[serviceName]).not.toHaveProperty("startCommand");
    }
  });

  test("replaces the obsolete standalone Cyclotron janitor", () => {
    const lock = lockPayload as PosthogLock;
    expect(railwayPlan.services).not.toHaveProperty("Cyclotron Janitor");
    expect(railwayPlan.services["Cyclotron V2 Janitor"].pluginServerMode).toBe(
      "cdp-cyclotron-v2-janitor",
    );
    expect(railwayPlan.services["Cyclotron Schema Migrator"]).toEqual({
      image: lock.officialImages["sqlx-migrate"].image,
      restartPolicy: "NEVER",
      startCommand: "/migrations/bin/migrate-entry cyclotron-node",
    });
  });

  test("includes both Node services required for session replay", () => {
    expect(railwayPlan.services["Recordings Blob Ingestion V2"].pluginServerMode).toBe(
      "recordings-blob-ingestion-v2",
    );
    expect(railwayPlan.services["Recording API"].pluginServerMode).toBe("recording-api");
  });

  test("requires the running CDP API behind the HTML preflight, not only Web liveness", () => {
    expect(railwayPlan.services.Plugins).toMatchObject({
      pluginServerMode: "cdp-api",
      port: 6738,
      healthcheckPath: "/_health",
      restartPolicyType: "ALWAYS",
    });
    expect(railwayPlan.requiredWiring.mainImageServices).toContain(
      "CDP_API_URL must point to the running Plugins cdp-api service on private HTTP port 6738",
    );
    expect(railwayPlan.requiredWiring.privateNetworking).toContain(
      "Verify Web login HTML and /_preflight from every Web replica; a fast root-to-login redirect and /_livez do not execute the HTML dependency checks",
    );
  });

  test("keeps shadow Valkey credentials out of raw-logged endpoint settings", () => {
    expect(railwayPlan.requiredWiring.nodeServices).toContain(
      "CDP_VALKEY_HOST and CDP_VALKEY_READER_HOST must be credential-free Redis endpoint URLs; use CDP_VALKEY_PASSWORD separately because the locked source logs the host settings verbatim",
    );
    expect(railwayPlan.requiredWiring.nodeServices).toContain(
      "Prove CDP API remains running after its asynchronous Valkey startup checks; an initial health response can precede a Redis retry-limit shutdown",
    );
  });

  test("uses Recording API's complete working Redis URL instead of a bare private host", () => {
    expect(railwayPlan.services["Recording API"].environment).toEqual({
      SESSION_RECORDING_API_REDIS_HOST: "${{REDIS_URL}}",
    });
    const wiring = railwayPlan.requiredWiring.recordingApiService.join(" ");
    expect(wiring).toContain("complete authenticated Redis URL, not a bare hostname");
    expect(wiring).toContain("overlay enables IPv6-only private Redis URL hostnames");
    expect(wiring).toContain("Do not append ?family=6");
    expect(railwayPlan.services["Recording API"].image).toBe(candidateFixture.images.node);
  });

  test("rejects a missing or stale Node overlay instead of falling back to official Node", () => {
    for (const candidate of [
      { ...candidateFixture, images: { ...candidateFixture.images, node: lockPayload.officialImages.node.image } },
      { ...candidateFixture, nodeOverlay: { ...candidateFixture.nodeOverlay, fingerprintSha256: "0".repeat(64) } },
      { ...candidateFixture, nodeOverlay: { ...candidateFixture.nodeOverlay, baseImage: "different-base" } },
      { ...candidateFixture, nodeOverlay: { ...candidateFixture.nodeOverlay, baseRevision: "0".repeat(40) } },
    ]) {
      expect(() => buildRailwayPlan(candidate, lockPayload as PosthogLock)).toThrow("Built Node overlay does not match");
    }
  });

  test("requires the Cyclotron-specific SQLx database variable", () => {
    expect(railwayPlan.requiredWiring.cyclotronSchemaMigrator).toEqual([
      "CYCLOTRON_NODE_DATABASE_URL must point to the isolated cyclotron_node PostgreSQL database",
      "DATABASE_URL alone is ignored by /migrations/bin/migrate-entry cyclotron-node",
    ]);
  });

  test("does not treat Railway zero-region scaling as a writer pause", () => {
    expect(railwayPlan.notes).toContain(
      "Pause production writers by removing their active deployments and verifying they stopped; Railway region=0 removes the region configuration and can fall back to us-west2=1.",
    );
  });

  test("renders services in dependency order", () => {
    const serviceNames = Object.keys(railwayPlan.services);
    expect(serviceNames.indexOf("PostHog Migration Bridge 1")).toBeLessThan(
      serviceNames.indexOf("PostHog Migration Bridge 2"),
    );
    expect(serviceNames.indexOf("PostHog Migration Bridge 2")).toBeLessThan(
      serviceNames.indexOf("PostHog Release Migrator"),
    );
    expect(serviceNames.indexOf("PostHog Release Migrator")).toBeLessThan(
      serviceNames.indexOf("Web"),
    );
    expect(serviceNames.indexOf("Cyclotron Schema Migrator")).toBeLessThan(
      serviceNames.indexOf("Cyclotron V2 Janitor"),
    );
    expect(serviceNames.indexOf("PersonHog Replica")).toBeLessThan(
      serviceNames.indexOf("PersonHog Router"),
    );
    expect(serviceNames.indexOf("PersonHog Router")).toBeLessThan(
      serviceNames.indexOf("Plugins"),
    );
    expect(serviceNames.indexOf("PostHog-Capture-Backend")).toBeLessThan(
      serviceNames.indexOf("Capture"),
    );
    expect(serviceNames.indexOf("Replay Capture")).toBeLessThan(
      serviceNames.indexOf("Capture"),
    );
  });

  test("locks the jump-upgrade ClickHouse migration bridge", async () => {
    const lock = (await Bun.file(new URL("../posthog.lock.json", import.meta.url)).json()) as PosthogLock;
    expect(lock.migrationBridges["pre-session-replay-ai"].revision).toBe(
      "84a70e43c322df6acbed9d3a18ba55328a1cb088",
    );
    expect(lock.migrationBridges["pre-session-replay-ai"].image).toMatch(
      /^ghcr\.io\/posthog\/posthog@sha256:[0-9a-f]{64}$/,
    );
    expect(lock.migrationBridges["pre-session-replay-surfacing"].revision).toBe(
      "42a7cf3e99d4c4448cd28811eec3873786b1a1e5",
    );
    expect(lock.migrationBridges["pre-session-replay-surfacing"].image).toMatch(
      /^ghcr\.io\/posthog\/posthog@sha256:[0-9a-f]{64}$/,
    );
  });

  test("does not create a new release when only the resolution time changes", async () => {
    const lock = (await Bun.file(new URL("../posthog.lock.json", import.meta.url)).json()) as PosthogLock;
    expect(isSameRelease(lock, { ...lock, resolvedAt: new Date(0).toISOString() })).toBe(true);
  });

  test("records a complete, immutable rollback baseline", () => {
    const services = Object.values(productionBaseline.services);
    expect(services).toHaveLength(13);
    expect(new Set(services.map((service) => service.serviceId)).size).toBe(13);
    for (const service of services) {
      expect(service.deploymentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(service.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});
