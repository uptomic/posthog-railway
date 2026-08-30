import lockPayload from "../posthog.lock.json";
import {
  isAncestor,
  migrationBridgeImages,
  officialComponents,
  upstreamRepository,
} from "./lib/upstream";
import type { PosthogLock } from "./lib/upstream";

const lock = lockPayload as PosthogLock;
if (lock.schemaVersion !== 1 || lock.upstreamRepository !== upstreamRepository) {
  throw new Error("PostHog lock schema or repository is invalid");
}
if (!/^[0-9a-f]{40}$/.test(lock.upstreamCommit)) {
  throw new Error("PostHog upstream commit is invalid");
}
if (!/^docker\.io\/library\/caddy@sha256:[0-9a-f]{64}$/.test(lock.supportingImages?.gateway ?? "")) {
  throw new Error("PostHog gateway must use the official Caddy image locked by digest");
}
for (const [name, repository] of Object.entries(officialComponents)) {
  const image = lock.officialImages[name as keyof typeof lock.officialImages];
  if (!image || image.image !== `ghcr.io/${repository}@${image.digest}`) {
    throw new Error(`PostHog ${name} image is not locked by digest`);
  }
  if (!(await isAncestor(image.revision, lock.upstreamCommit))) {
    throw new Error(`PostHog ${name} image revision is not an ancestor of the locked upstream`);
  }
}
for (const [name, bridge] of Object.entries(migrationBridgeImages)) {
  const image = lock.migrationBridges[name as keyof typeof lock.migrationBridges];
  if (!image || image.image !== `ghcr.io/${bridge.repository}@${image.digest}`) {
    throw new Error(`PostHog migration bridge ${name} is not locked by digest`);
  }
  if (!(await isAncestor(image.revision, lock.upstreamCommit))) {
    throw new Error(`PostHog migration bridge ${name} is newer than the locked upstream`);
  }
}
const nodeCreatedAt = Date.parse(lock.officialImages.node.createdAt);
const resolvedAt = Date.parse(lock.resolvedAt);
if (Number.isNaN(nodeCreatedAt) || resolvedAt - nodeCreatedAt > 72 * 60 * 60 * 1000) {
  throw new Error("Official PostHog Node image is more than 72 hours behind the locked release");
}
const immutableCandidate = new RegExp(
  `^ghcr\\.io/uptomic/posthog-railway/mcp:sha-${lock.upstreamCommit.slice(0, 12)}$`,
);
for (const image of Object.values(lock.candidateImages)) {
  if (!immutableCandidate.test(image)) {
    throw new Error(`Candidate image is not tied to the locked upstream commit: ${image}`);
  }
}
console.log(`Verified PostHog release bundle ${lock.upstreamCommit}`);
