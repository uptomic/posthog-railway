ARG CLICKHOUSE_BASE_IMAGE=clickhouse/clickhouse-server:26.6.2.158
FROM ${CLICKHOUSE_BASE_IMAGE}

ARG COMMIT_HASH

COPY posthog/posthog/idl /idl
COPY posthog/docker/clickhouse/docker-entrypoint-initdb.d /docker-entrypoint-initdb.d
COPY posthog/docker/clickhouse/config.xml /etc/clickhouse-server/config.xml
COPY posthog/docker/clickhouse/config.d/default.xml /etc/clickhouse-server/config.d/default.xml
COPY images/clickhouse.railway.xml /etc/clickhouse-server/config.d/zz-railway-runtime.xml
COPY posthog/docker/clickhouse/users.xml /etc/clickhouse-server/users.xml
COPY posthog/docker/clickhouse/user_defined_function.xml /etc/clickhouse-server/user_defined_function.xml
COPY posthog/posthog/user_scripts /var/lib/clickhouse/user_scripts

RUN test -n "${COMMIT_HASH}" && printf '%s\n' "${COMMIT_HASH}" > /etc/uptomic-posthog-commit

LABEL org.opencontainers.image.revision="${COMMIT_HASH}" \
  org.opencontainers.image.source="https://github.com/PostHog/posthog"
