import {
  isSameRelease,
  migrationBridgeImages,
  officialComponents,
  resolveGhcrImage,
  resolveGithubHead,
} from "./lib/upstream";
import type { OfficialComponent, PosthogLock } from "./lib/upstream";
import currentLockPayload from "../posthog.lock.json";

const shouldWrite = process.argv.includes("--write");
const upstreamCommit = await resolveGithubHead();
const entries = await Promise.all(
  Object.entries(officialComponents).map(async ([name, repository]) => [
    name,
    await resolveGhcrImage(repository),
  ]),
);
const migrationBridgeEntries = await Promise.all(
  Object.entries(migrationBridgeImages).map(async ([name, bridge]) => [
    name,
    await resolveGhcrImage(bridge.repository, bridge.tag),
  ]),
);
const shortCommit = upstreamCommit.slice(0, 12);
const candidate: PosthogLock = {
  candidateImages: {
    mcp: `ghcr.io/uptomic/posthog-railway/mcp:sha-${shortCommit}`,
  },
  // Supporting infrastructure pins change deliberately, not with PostHog master.
  supportingImages: (currentLockPayload as PosthogLock).supportingImages,
  officialImages: Object.fromEntries(entries) as PosthogLock["officialImages"],
  migrationBridges: Object.fromEntries(migrationBridgeEntries) as PosthogLock["migrationBridges"],
  resolvedAt: new Date().toISOString(),
  schemaVersion: 1,
  upstreamCommit,
  upstreamRepository: "PostHog/posthog",
};
const lockPath = new URL("../posthog.lock.json", import.meta.url);
let lock = candidate;
const currentFile = Bun.file(lockPath);
if (await currentFile.exists()) {
  const current = (await currentFile.json()) as PosthogLock;
  if (isSameRelease(current, candidate)) {
    lock = { ...candidate, resolvedAt: current.resolvedAt };
  }
}

const serialized = `${JSON.stringify(lock, null, 2)}\n`;
if (shouldWrite) {
  await Bun.write(lockPath, serialized);
} else {
  process.stdout.write(serialized);
}
