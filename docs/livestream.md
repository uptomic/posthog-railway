# Official Livestream runtime contract

The inherited wrapper supplied a config file that the official image does not include. Without
explicit configuration, startup fails with `mmdb.path must be set`; fixing only the database path is
insufficient because both Kafka consumers also need their complete settings.

The rendered Railway plan owns these non-secret production values:

| Variable | Value |
| --- | --- |
| `PORT` | `8080` |
| `LIVESTREAM_MMDB_PATH` | `/GeoLite2-City.mmdb` |
| `LIVESTREAM_CONSUMERS_EVENT_ENABLED` | `true` |
| `LIVESTREAM_CONSUMERS_EVENT_TOPIC` | `events_plugin_ingestion` |
| `LIVESTREAM_CONSUMERS_EVENT_SECURITY_PROTOCOL` | `PLAINTEXT` |
| `LIVESTREAM_CONSUMERS_EVENT_GROUP_ID` | `livestream-production` |
| `LIVESTREAM_CONSUMERS_SESSION_RECORDING_ENABLED` | `true` |
| `LIVESTREAM_CONSUMERS_SESSION_RECORDING_TOPIC` | `session_recording_snapshot_item_events` |
| `LIVESTREAM_CONSUMERS_SESSION_RECORDING_SECURITY_PROTOCOL` | `PLAINTEXT` |
| `LIVESTREAM_CONSUMERS_SESSION_RECORDING_GROUP_ID` | `livestream-session-recordings-production` |
| `LIVESTREAM_CONSUMERS_NOTIFICATION_ENABLED` | `false` |
| `LIVESTREAM_REDIS_PORT` | `6379` |
| `LIVESTREAM_CORS_ALLOW_ORIGINS` | `https://posthog.uptomic.com` |

Wire `LIVESTREAM_CONSUMERS_EVENT_BROKERS` and
`LIVESTREAM_CONSUMERS_SESSION_RECORDING_BROKERS` to production Kafka, not rehearsal brokers. Set
`LIVESTREAM_REDIS_ADDRESS` to the private Valkey hostname. `LIVESTREAM_JWT_SECRET` must match Web's
`SECRET_KEY`; copy/reference it through the secret-management boundary without logging its value.

Keep rehearsal consumer groups environment-specific. Production uses the group IDs above. Require
successful event and session-recording consumer startup, then verify the gateway's prefix-stripped
`/livestream` route. A healthy gateway alone does not prove Livestream is running.
