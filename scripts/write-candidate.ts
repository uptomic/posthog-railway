import type { CandidateRelease, PosthogLock } from "./lib/upstream";
import lockPayload from "../posthog.lock.json";
import { nodeOverlayProvenance } from "./lib/node-overlay";
import { clickhouseBuildProvenance } from "./lib/clickhouse-build";

const lock = lockPayload as PosthogLock;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commit = process.env.EXPECTED_COMMIT;
const clickhouseDigest = process.env.CLICKHOUSE_DIGEST;
const mcpDigest = process.env.MCP_DIGEST;
const nodeDigest = process.env.NODE_DIGEST;

if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("EXPECTED_COMMIT must be a full Git commit SHA");
}
if (!mcpDigest || !digestPattern.test(mcpDigest)) {
  throw new Error("MCP_DIGEST must be an OCI sha256 digest");
}
if (!clickhouseDigest || !digestPattern.test(clickhouseDigest)) {
  throw new Error("CLICKHOUSE_DIGEST must be an OCI sha256 digest");
}
if (!nodeDigest || !digestPattern.test(nodeDigest)) {
  throw new Error("NODE_DIGEST must be an OCI sha256 digest");
}
const nodeOverlay = nodeOverlayProvenance(lock);
const clickhouseBuild = clickhouseBuildProvenance(lock);
if (commit !== lock.upstreamCommit || process.env.NODE_OVERLAY_SHA256 !== nodeOverlay.fingerprintSha256 ||
  process.env.CLICKHOUSE_BUILD_SHA256 !== clickhouseBuild.fingerprintSha256) {
  throw new Error("Built candidate inputs changed before finalization");
}

const release: CandidateRelease = {
  builtAt: new Date().toISOString(),
  clickhouseBuild,
  images: {
    clickhouse: `ghcr.io/uptomic/posthog-railway/clickhouse@${clickhouseDigest}`,
    mcp: `ghcr.io/uptomic/posthog-railway/mcp@${mcpDigest}`,
    node: `ghcr.io/uptomic/posthog-railway/node@${nodeDigest}`,
  },
  nodeOverlay,
  schemaVersion: 1,
  upstreamCommit: commit,
};

const candidatePath = new URL("../posthog.candidate.json", import.meta.url);
const existingFile = Bun.file(candidatePath);
if (await existingFile.exists()) {
  const existing = (await existingFile.json()) as CandidateRelease;
  if (
    existing.schemaVersion === release.schemaVersion &&
    existing.upstreamCommit === release.upstreamCommit &&
    JSON.stringify(existing.images) === JSON.stringify(release.images) &&
    JSON.stringify(existing.nodeOverlay) === JSON.stringify(release.nodeOverlay) &&
    JSON.stringify(existing.clickhouseBuild) === JSON.stringify(release.clickhouseBuild)
  ) {
    release.builtAt = existing.builtAt;
  }
}

await Bun.write(candidatePath, `${JSON.stringify(release, null, 2)}\n`);
