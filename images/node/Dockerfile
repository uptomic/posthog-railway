ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE}

ARG NODE_BASE_IMAGE
ARG NODE_BASE_REVISION
ARG NODE_OVERLAY_SHA256
LABEL org.opencontainers.image.source="https://github.com/uptomic/posthog-railway" \
      com.uptomic.node.base-image="${NODE_BASE_IMAGE}" \
      com.uptomic.node.overlay-sha256="${NODE_OVERLAY_SHA256}"

COPY --chown=posthog:posthog Dockerfile apply-overlay.cjs guard.json railway-redis-options.cjs /opt/uptomic-node-overlay/
RUN node /opt/uptomic-node-overlay/apply-overlay.cjs

# USER, WORKDIR, ENV, ENTRYPOINT, CMD and upstream revision labels are inherited unchanged.
