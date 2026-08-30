# Public PostHog gateway

The official PostHog Web image serves the application, not the complete SDK ingress surface. In the
rehearsal, `/e` and `/s` sent directly to Web returned HTTP 302 instead of reaching the capture
services. The release therefore includes a digest-pinned Caddy gateway without changing Career
Mentor's SDK configuration.

## Ownership and service identity

`config/gateway.Caddyfile` is the sole versioned routing owner. Set `CADDY_CONFIG` to that file's
unchanged contents; its environment placeholders resolve to private service URLs at startup. Do not
keep a second inline route implementation in deployment scripts.

- The inherited service named `Capture` (`bacb342e-f790-4234-845d-98c0bde19c99`) now means the public
  gateway. Its existing Railway hostname is `capture-production-8366.up.railway.app`.
- `PostHog-Capture-Backend` (`27dff4e2-fedd-4633-98fc-27556efd5cd5`) runs the locked official capture
  image. It is not the public gateway.
- `Web` continues to run the locked official main image.
- The Caddy digest is recorded separately in `posthog.lock.json` under `supportingImages.gateway`;
  PostHog upstream resolution preserves it until an explicit gateway upgrade.

The gateway listens on port 3000 with `PORT=3000`, checks readiness at `/health`, and starts with:

```sh
sh -c 'printf "%s" "$CADDY_CONFIG" | caddy run --config - --adapter caddyfile'
```

## Private routing

| Public path | Upstream environment variable | Private destination |
| --- | --- | --- |
| `/s`, `/s/`, `/s/*` | `CAPTURE_REPLAY_INTERNAL_URL` | Replay Capture, HTTP port 3000 |
| Analytics capture paths including `/e`, `/i/v0`, `/i/v1/analytics/events`, `/batch`, `/capture`, `/track`, `/engage` | `CAPTURE_INTERNAL_URL` | PostHog-Capture-Backend, HTTP port 3000 |
| `/flags` and `/api/feature_flag/local_evaluation` variants | `FEATURE_FLAGS_INTERNAL_URL` | Feature Flags, HTTP port 3001 |
| `/livestream*`, with the prefix stripped | `LIVESTREAM_INTERNAL_URL` | Livestream, HTTP port 8080 |
| All remaining paths | `WEB_INTERNAL_URL` | Web, HTTP port 8000 |

All five upstreams receive `X-Forwarded-Proto: https` because the public edge terminates TLS. The
gateway health response does not contact an upstream and is not proof of ingestion health.
The production upstream listeners must follow the [IPv6 private-network contract](private-networking.md);
public health does not prove the gateway can reach them privately.
Keep `/health` in the first `handle` block with its own `respond 200`. A standalone `respond /health`
directive can be sorted after the catch-all `handle`, causing health requests to proxy to Web.

Run `bun run gateway:smoke` with a working Docker-compatible runtime (or set `DOCKER_CONTEXT` to an
existing context). It first starts the locked Caddy image without a Web listener and requires an
empty HTTP 200 from `/health` while `/` returns 502. A second disposable instance checks 16 HTTP
routes with synthetic local upstreams. Both containers are removed; the check never contacts production.

Web, Worker, and Temporal Django Worker must also set `CAPTURE_INTERNAL_URL` to the new capture
backend and `CAPTURE_REPLAY_INTERNAL_URL` to Replay Capture. Neither variable should point back to
the public gateway.

## Domain cutover and verification

The 2026-08-30 production cutover moved `posthog.uptomic.com` to the `Capture` gateway. Railway custom
domain `c71eb59d-85ff-465d-9216-a271ea7f737c` was active with target port 3000. Its Cloudflare CNAME
points to `wkf9y1ab.up.railway.app` with proxying enabled. The existing
`capture-production-8366.up.railway.app` hostname and Career Mentor SDK settings remain unchanged.

The cutover operator verified both public hosts: health 200, one analytics canary and one replay
canary per host accepted with 200, exact HogQL counts of one for each canary, replay metadata 200,
and flag evaluation 200. These are capture/query checks, not authenticated browser acceptance.
The production authenticated UI browser path has not yet been verified; overall migration completion
remains pending. Continue to require the authenticated Web path and livestream route as part of the
full promotion checks. HTTP 302 on an SDK capture path is not a successful capture response.

## Cloudflare SDK and health exceptions

Cloudflare custom ruleset `6e37ba0d4846407b8bce7df9aebe0887`, rule
`fd171a67d8964a90b9a0682c07639b3e`, retains its `managed_challenge` action for application/UI
protection. SDK requests cannot complete an interactive browser challenge, so their existing
exceptions remain in place. The cutover added `/health`, `/e`, `/e/`, `/i/v0/`, and
`/i/v1/analytics/events` with and without a trailing slash to the challenge exclusions.

The prior batch, flags, decide, `/i/v0/e`, capture, engage, `/s`, track, `/_livez`, `/_health`, and
static-path exceptions were preserved. These are narrowly scoped exclusions from this challenge
rule, not a zone-wide security bypass or an authentication exemption. `config/gateway.Caddyfile`
continues to own origin routing; the Cloudflare rule controls whether a request reaches that origin.

An API request to canonical `/api/projects/1/` without Cloudflare clearance intentionally returns
403 with `cf-mitigated: challenge`. Do not diagnose that HTML response as PostHog serializer failure
or remove UI protection to make a server-side API check pass. MCP uses its configured direct Web
endpoint; verify the canonical application through a browser that has completed the challenge.

MCP retains its separate service/domain. Its runtime `PORT` and all Railway generated/custom domain
target ports must be 3000; the inherited domain target of 8080 is not compatible with this image.
