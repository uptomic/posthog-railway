#!/bin/sh
set -eu

cluster_config=/etc/clickhouse-server/config.d/default.xml

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

exec /clickhouse-official-entrypoint.sh "$@"
