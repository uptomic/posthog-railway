# Error-tracking ingestion

Capture routes `$exception` to its own Kafka lane. `ingestion-v2-combined` consumes
analytics and AI events; it does not own error tracking. Deploy the official Node
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
