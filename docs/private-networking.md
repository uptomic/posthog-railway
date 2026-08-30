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

Reuse the service's already working complete authenticated URL; this is a configuration correction,
not a source-image change. A full URL alone does not make an IPv6-only hostname work: the referenced
endpoint must already be reachable by this client. Verify Recording API's Redis readiness and replay
metadata from Web after applying it, without logging credentials.

## Private-path acceptance checks

Before completing production migration, verify from the actual caller:

- Gateway to Web, Capture Backend, Replay Capture, Feature Flags, and Livestream.
- Web and Worker to Recording API and PersonHog Router.
- PersonHog Router to PersonHog Replica over gRPC.
- Node consumers to PersonHog Router and their private data-service dependencies.
- MCP to its configured PostHog Web endpoint.

Resolve the private hostname inside the caller and test the advertised application port. Record
application responses or a gRPC request, not only DNS resolution, a public health result, or a
provider deployment label. Metrics/readiness HTTP limitations must be reported separately from gRPC
reachability.
