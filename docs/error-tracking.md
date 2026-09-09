# Error-tracking ingestion

Capture routes `$exception` to its own Kafka lane. `ingestion-v2-combined` consumes
analytics and AI events; it does not own error tracking. Capture defaults to the
`error_tracking_events` topic, while the Node error consumer defaults to
`ingestion-errortracking-main`. Explicitly bind the consumer to Capture's topic. Deploy the official Node
`ingestion-errortracking` consumer, Cymbal processing HTTP service, and Cymbal
resolution gRPC service together. The processor requires a nonempty remote resolution
host and both Cymbal modes authenticate with the same existing internal API secret.

The versioned Railway plan owns modes, ports, health checks and private references.
Cymbal Resolution must be ready before Cymbal and the error consumer can process events.
For a bounded repair, use the running Node overlay's immutable image and inherit its
non-Railway runtime variables through references to `posthog-ingestion`; override only
`PLUGIN_SERVER_MODE`, `PORT` and `ERROR_TRACKING_CYMBAL_BASE_URL` from the plan.
Do not deploy an unrelated full candidate or copy secret values into source control.
Both Cymbal modes use Web's PostgreSQL and symbol-set object storage. Private IPv6
bindings and authenticated gRPC are required. No public domain is needed.

Verify a synthetic native SDK exception with an uploaded chunk ID, then read back its
issue ID and resolved source frames. HTTP 200 from capture or a successful source-map
upload alone does not establish ingestion, grouping or symbolication.

The deployed Node Cymbal client used IPv4-only `resolve4`, which fails on legacy Railway private DNS. The shared guarded Node overlay now resolves Railway names with family zero and brackets IPv6 HTTP authorities. Public-host behavior remains upstream-owned, and DNS failures still propagate. The resolver function hash is checked before any compiled owner is changed.

`build-node-repair.yml` builds this same overlay against the exact production Node base (revision `49c2532424f7f7e6825a0cd5ef61c4ba7bc212f7`). It does not advance the application release or deploy anything. Apply its immutable output only to the error ingestion service for this repair; the normal candidate pipeline incorporates the same overlay for subsequent coordinated releases.

Native screenshot heatmaps and exports require the private Browserless service. The Railway plan pins the Chromium version used by the deployed upstream hobby stack, binds IPv6, limits concurrency to two, and passes authentication through Railway references to Web and Worker. Keep Browserless private. Regenerate failed saved heatmaps after both callers have restarted with the new configuration.
