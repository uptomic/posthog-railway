# Production private-network listener contract

The inherited production Railway environment resolves private service DNS to IPv6, while the newer
rehearsal environment supports IPv4. Public Web `/_livez` returned 200 while a gateway connection to
the same service's private IPv6 address on port 8000 was refused. Capture had the same mismatch on
port 3000. Public health and IPv4 rehearsal success are therefore separate from private-path proof.

## Explicit listeners

| Service | Required setting | Private application port |
| --- | --- | --- |
| Web | `GRANIAN_HOST=::` | 8000 |
| PostHog-Capture-Backend | `ADDRESS=[::]:3000` | 3000 |
| Replay Capture | `ADDRESS=[::]:3000` | 3000 |
| Feature Flags | `ADDRESS=[::]:3001` | 3001 |
| PersonHog Replica | `GRPC_ADDRESS=[::]:50051` | 50051 |
| PersonHog Router | `GRPC_ADDRESS=[::]:50052` | 50052 |

Use the unspecified IPv6 listener so the Linux runtime can serve private IPv6 and dual-stack
traffic. Do not replace it with IPv4-only `0.0.0.0`. Keep private hostnames in upstream URLs; if a
diagnostic URL uses an IPv6 literal, enclose that literal in brackets.

## Exact locked-source audit

PersonHog images are locked to revision `e622e22afeeb300fe7ca2ad7fd471d0e875929c6`. Both
[Replica config](https://github.com/PostHog/posthog/blob/e622e22afeeb300fe7ca2ad7fd471d0e875929c6/rust/personhog-replica/src/config.rs)
and [Router config](https://github.com/PostHog/posthog/blob/e622e22afeeb300fe7ca2ad7fd471d0e875929c6/rust/personhog-router/src/config.rs)
expose `GRPC_ADDRESS` as a socket address and default to IPv4 loopback. Their gRPC servers bind that
address directly, so explicit IPv6 values are required in this environment.

Their separate metrics/readiness HTTP servers are hardcoded to `0.0.0.0` on `METRICS_PORT` (defaults
9100 for Replica and 9101 for Router). There is no supported metrics-host environment override in
this revision. `GRPC_ADDRESS` does not change those HTTP listeners. Check them locally or through an
IPv4-capable health path; private IPv6 access to those ports requires a separately reviewed proxy or
source change. Do not invent a `METRICS_ADDRESS` variable.

The Node image is locked to revision `49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7`. Its shared
[HTTP server](https://github.com/PostHog/posthog/blob/49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7/nodejs/src/servers/base-server.ts)
and ingestion [gRPC server](https://github.com/PostHog/posthog/blob/49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7/nodejs/src/ingestion/api/grpc-server.ts)
call `listen(port, callback)` without a host argument. Node uses `::` when IPv6 is available, with
dual-stack support by default; no Node host override is needed for these listeners. Recording API
uses that shared HTTP lifecycle. This is source evidence, not a substitute for checking each live
private path. [Node listener semantics](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)

## Recording API Redis client

Listening on IPv6 does not make every outbound Node client IPv6-capable. Recording API's
`SESSION_RECORDING_API_REDIS_HOST` must resolve to its own working `REDIS_URL`, including the scheme,
authentication, host, and port. The rendered plan uses the same-service reference `${{REDIS_URL}}`;
never copy its resolved secret value into source, logs, or this document.

Despite the variable's `HOST` suffix, the locked
[Recording API](https://github.com/PostHog/posthog/blob/49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7/nodejs/src/session-replay/recording-api/recording-api.ts)
passes it as `connection.url` to the shared
[Redis client](https://github.com/PostHog/posthog/blob/49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7/nodejs/src/common/utils/db/redis.ts).
A bare private hostname failed in production because this ioredis client defaults to IPv4 and the
inherited private DNS is IPv6-only. Appending `?family=6` is not a fix: the URL query value reaches
the socket as a string rather than a numeric address-family option.

The initial Recording API recovery reused the service's already working complete authenticated URL
without changing its image. A full URL alone does not make an IPv6-only hostname work: that original
endpoint was already reachable by the upstream client. Keep this working URL when promoting the
shared candidate Node overlay described below. Verify Recording API's Redis readiness and replay
metadata from Web after applying the candidate, without logging credentials.

## Private-path acceptance checks

Before completing production migration, verify from the actual caller:

- Gateway to Web, Capture Backend, Replay Capture, Feature Flags, and Livestream.
- Web to the running Plugins service in `cdp-api` mode on port 6738, using `CDP_API_URL`.
- Web and Worker to Recording API and PersonHog Router.
- PersonHog Router to PersonHog Replica over gRPC.
- Node consumers to PersonHog Router and their private data-service dependencies.
- MCP to its configured PostHog Web endpoint.

Resolve the private hostname inside the caller and test the advertised application port. Record
application responses or a gRPC request, not only DNS resolution, a public health result, or a
provider deployment label. Metrics/readiness HTTP limitations must be reported separately from gRPC
reachability.

## Web HTML bootstrap is a separate dependency check

The production Web root redirects anonymous requests to `/login` before rendering the SPA.
A quick 302 therefore does not exercise template startup. Web `/_livez` likewise does not prove
the template dependencies are available. Check real `/login` HTML and `/_preflight` from every
Web replica, then verify the canonical authenticated browser path.

At the locked Web revision, template rendering calls `preflight_check`, which invokes the Node
CDP API's `/_health` through `CDP_API_URL`. That request has no explicit timeout. An exited CDP
process can therefore leave Web waiting until the public edge times out, despite green Web
liveness and functioning authenticated query APIs. Inspect both Railway deployment status and
actual instance/process state; `SUCCESS` with an `EXITED` instance is not service readiness.

## CDP shadow Valkey client and secret boundary

At Node revision `49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7`, every CDP process creates a
required shadow Valkey writer pool. `CDP_VALKEY_HOST` and `CDP_VALKEY_READER_HOST` are used
as Redis connection URLs but logged verbatim by `createCdpValkeyShadowPools`. They must be
credential-free endpoints; provide authentication through `CDP_VALKEY_PASSWORD`. Do not copy
the Recording API's authenticated-URL pattern into these settings.

Test the exact deployed client's PING from the caller, then verify sustained CDP process
health after asynchronous startup. The shared Redis client calls `killGracefully` after more
than ten error events, even though the shadow startup probe catches its own initial failure.
An early `/_health` response can therefore precede process exit. Never expose an unauthenticated
Valkey store publicly or disable this required dependency to make preflight appear healthy.

Use `ALWAYS` restart policy for the long-running Plugins/CDP service. In this locked source,
the Redis retry-limit path emits SIGTERM and the lifecycle handler calls `stop` without an error,
which exits with code zero after cleanup. Railway's `ON_FAILURE` policy does not restart that
successful exit; [its `ALWAYS` policy does](https://docs.railway.com/deployments/restart-policy).
This is recovery behavior, not permission to accept a restart loop: require the same instance
and process start identity throughout the sustained health window, and restart that window if
the process changes. Keep one-shot migration jobs on their separate non-restarting policy.

## Versioned Node compatibility image

The release-owned `images/node` overlay derives from the exact official Node digest in the
upstream lock. It changes only the shared Redis constructor's options: a `redis://` or
`rediss://` URL ending in `.railway.internal` receives numeric `family: 0` when neither the
caller nor URL specifies a family or alternate host/path. Public hosts and explicit options
remain unchanged. No global DNS override, public Valkey endpoint or runtime filesystem
patch is part of this design.

The build fails on an unexpected upstream revision, ioredis version, or shared-constructor
function. Base-image and overlay-file fingerprints identify the resulting candidate, and all
five Node roles consume that same immutable candidate digest. Upstream commands and entrypoints
remain inherited. A future upstream fix or constructor change requires review of this one
guarded compatibility owner, not a silent fallback to an unverified image.

The build's exact-image tests must prove IPv6-only and IPv4-only Redis connections as well as
explicit-family and non-private-host behavior. Production acceptance additionally requires a
running CDP instance for at least three minutes, no Redis retry-limit termination, and fast HTML
bootstrap from each Web replica. Neither a successful image build nor its first health response
alone establishes production readiness.

## ClickHouse executable assets and persistent volumes

The data volume at `/var/lib/clickhouse` masks image files beneath that directory. Keep the
unchanged upstream UDF wrappers, binaries and versioned subdirectories in
`/opt/posthog/user_scripts`, owned by `clickhouse`, and set `user_scripts_path` to that location
in the single release-owned runtime XML. Do not copy executables into a production data volume
or change saved insights to bypass a missing `aggregate_funnel` executable.

`images/clickhouse-base.json` pins the engine independently from application upgrades. Its
26.6.2.158 index was verified to have exactly the same first eleven filesystem layers as the
previous production candidate. A new upstream engine version stops the build for a separately
reviewed data-service upgrade. The candidate records this base plus a fingerprint of every
owned ClickHouse image input and the upstream commit. Missing/stale fingerprints block plan
generation and force the scheduled candidate build; finalization rejects changed inputs.

The exact-image verification uses a disposable data volume with `volume-nocopy` so Docker
cannot seed it with image assets and conceal the regression. It checks the engine/layer
provenance, executable access as the runtime user, cluster/dictionary authentication, and
executes a synthetic ordered three-step browser funnel through ClickHouse SQL. No host ports
are published, no production data is used, and the fixture volume is removed afterward.
Promotion still requires a fresh recoverable production backup, preservation of the existing
volume and settings, and successful refresh of the original authenticated saved funnel.

## ClickHouse query scheduler headroom

The observed production background load occupies about 480 global workers. During the
2026-08-30 incident, every one-second sample for fourteen minutes had 512 active global
workers with up to 623 scheduled jobs, while CPU, memory and the 1000-PID cgroup were not
exhausted. A same-image restart restored query execution. The release-owned XML now keeps
the necessary Kafka/background pools at 128 each, increases the global pool to 640, and
bounds its admitted queue to 640. The authenticated default profile uses `max_threads=8`;
this is a default, not a restriction on explicit query settings. Queue-equals-pool prevents
the specific nonblocking nested global-pool admission path from indefinitely queueing more
jobs than workers; it is not a general guarantee against every possible deadlock.

Candidate finalization additionally requires `scripts/clickhouse-pressure.ts` to reproduce
the old d240 image's saturation and pass the candidate under the same six submitted,
nonconstant eight-stream UDF queries. Old-image admission may stall before all six queries
start: RED requires at least two genuinely overlapping persisted query IDs and more than
one active query worker, alongside consecutive queued saturation and watchdog failure.
GREEN requires all six actual overlapping queries, six correct results and at least sixteen
query workers. Unfinished old intervals are explicitly censored at the pressure-end time;
they are not reported as successful completions. Only the disposable fixture calibrates extra buffer
scheduler threads to about 480 active workers and reserves approximately 243 non-global
tasks to model native Kafka PID usage. Test CPU/parallelism overrides never enter the image.
The gate requires persisted query-start/finish overlap, consecutive saturated metric samples
for old-image RED, correct candidate results, a responsive serial `SELECT 1` watchdog,
bounded recovery, no PID/OOM exhaustion, and kernel `pids.peak < 950` under `--pids-limit=1000`.
Individual commands and the whole test have deadlines; only its own containers and volumes
are removed. No production data or settings are touched by this test.

An image build or static test is not this runtime proof. Do not promote until both exact-image
RED/GREEN and the existing mounted-volume UDF gate pass. After promotion, repeat the original
saved funnel and observe production scheduler/PID headroom; explicit query overrides and
larger concurrent workloads remain operational limits requiring review.
