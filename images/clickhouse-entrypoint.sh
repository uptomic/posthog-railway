#!/bin/sh
set -eu

cluster_config=/etc/clickhouse-server/config.d/default.xml

: "${CLICKHOUSE_USER:?CLICKHOUSE_USER is required}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"
[ "$CLICKHOUSE_USER" = clickhouse ] || {
    echo "CLICKHOUSE_USER must be 'clickhouse' for this Railway image" >&2
    exit 1
}

if [ -f "$cluster_config" ]; then
    # Keep the hostname reachable from application containers while resolving
    # it locally inside ClickHouse. Current migrations require both properties:
    # they discover DATA nodes through system.clusters, then connect to the
    # discovered hostname from the migrator container.
    : "${RAILWAY_PRIVATE_DOMAIN:?RAILWAY_PRIVATE_DOMAIN is required}"
    cluster_host=$RAILWAY_PRIVATE_DOMAIN
    sed -i "s|<host>clickhouse</host>|<host>$cluster_host</host>|g" "$cluster_config"
    if ! grep -q "$cluster_host" /etc/hosts; then
        printf '127.0.0.1 %s\n' "$cluster_host" >> /etc/hosts
    fi

    # Distributed and ON CLUSTER queries connect back to the same node. Reuse
    # runtime-provided credentials instead of embedding them in the image.
    if ! grep -q '<user from_env="CLICKHOUSE_USER"' "$cluster_config"; then
        sed -i '/<port>9000<\/port>/a\
                    <user from_env="CLICKHOUSE_USER" />' "$cluster_config"
    fi
    if ! grep -q '<password from_env="CLICKHOUSE_PASSWORD"' "$cluster_config"; then
        sed -i '/<user from_env="CLICKHOUSE_USER" \/>/a\
                    <password from_env="CLICKHOUSE_PASSWORD" />' "$cluster_config"
    fi
fi

# The image defines both the authenticated network user and PostHog's
# localhost-only dictionary reader. Prevent the official entrypoint from
# replacing that complete user configuration with a single generated user.
export CLICKHOUSE_SKIP_USER_SETUP=1

exec /clickhouse-official-entrypoint.sh "$@"
