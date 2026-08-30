import lockPayload from "../posthog.lock.json";
import { isAncestor, officialComponents, upstreamRepository } from "./lib/upstream";
import type { PosthogLock } from "./lib/upstream";

const lock = lockPayload as PosthogLock;
if (lock.schemaVersion !== 1 || lock.upstreamRepository !== upstreamRepository) {
  throw new Error("PostHog lock schema or repository is invalid");
}
if (!/^[0-9a-f]{40}$/.test(lock.upstreamCommit)) {
  throw new Error("PostHog upstream commit is invalid");
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
const immutableCandidate = new RegExp(`^ghcr\\.io/uptomic/posthog-railway/(main|node|mcp):sha-${lock.upstreamCommit.slice(0, 12)}$`);
for (const image of Object.values(lock.candidateImages)) {
  if (!immutableCandidate.test(image)) {
    throw new Error(`Candidate image is not tied to the locked upstream commit: ${image}`);
  }
}
console.log(`Verified PostHog release bundle ${lock.upstreamCommit}`);
