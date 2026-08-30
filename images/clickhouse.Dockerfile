ARG CLICKHOUSE_BASE_IMAGE
FROM ${CLICKHOUSE_BASE_IMAGE}

ARG CLICKHOUSE_BASE_IMAGE
ARG CLICKHOUSE_BUILD_SHA256
ARG COMMIT_HASH

COPY posthog/posthog/idl /idl
COPY posthog/docker/clickhouse/docker-entrypoint-initdb.d /docker-entrypoint-initdb.d
COPY posthog/docker/clickhouse/config.xml /etc/clickhouse-server/config.xml
COPY posthog/docker/clickhouse/config.d/default.xml /etc/clickhouse-server/config.d/default.xml
COPY images/clickhouse.railway.xml /etc/clickhouse-server/config.d/zz-railway-runtime.xml
COPY posthog/docker/clickhouse/users.xml /etc/clickhouse-server/users.xml
COPY images/clickhouse.railway-users.xml /etc/clickhouse-server/users.d/zz-railway-dictionary-user.xml
COPY posthog/docker/clickhouse/user_defined_function.xml /etc/clickhouse-server/user_defined_function.xml
COPY --chown=clickhouse:clickhouse posthog/posthog/user_scripts /opt/posthog/user_scripts

RUN test -n "${COMMIT_HASH}" \
    && test "${#CLICKHOUSE_BUILD_SHA256}" = 64 \
    && test -x /opt/posthog/user_scripts/aggregate_funnel \
    && test -r /opt/posthog/user_scripts/aggregate_funnel_x86_64 \
    && test -r /opt/posthog/user_scripts/aggregate_funnel_aarch64 \
    && printf '%s\n' "${COMMIT_HASH}" > /etc/uptomic-posthog-commit \
    && mv /entrypoint.sh /clickhouse-official-entrypoint.sh

COPY images/clickhouse-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

LABEL org.opencontainers.image.revision="${COMMIT_HASH}" \
  org.opencontainers.image.source="https://github.com/PostHog/posthog" \
  io.uptomic.clickhouse.base-image="${CLICKHOUSE_BASE_IMAGE}" \
  io.uptomic.clickhouse.build-sha256="${CLICKHOUSE_BUILD_SHA256}"
