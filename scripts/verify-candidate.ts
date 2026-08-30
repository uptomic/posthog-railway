import candidatePayload from "../posthog.candidate.json";
import lockPayload from "../posthog.lock.json";
import type { CandidateRelease, PosthogLock } from "./lib/upstream";

const candidate = candidatePayload as CandidateRelease;
const lock = lockPayload as PosthogLock;
if (candidate.schemaVersion !== 1 || candidate.upstreamCommit !== lock.upstreamCommit) {
  throw new Error("Candidate images do not match the locked PostHog release");
}

const candidateComponents = Object.keys(candidate.images).sort();
if (JSON.stringify(candidateComponents) !== JSON.stringify(["clickhouse", "mcp"])) {
  throw new Error("Candidate must lock both ClickHouse and MCP images");
}

for (const [component, image] of Object.entries(candidate.images)) {
  const expected = new RegExp(
    `^ghcr\\.io/uptomic/posthog-railway/${component}@sha256:[0-9a-f]{64}$`,
  );
  if (!expected.test(image)) {
    throw new Error(`Candidate ${component} image is not locked by digest`);
  }
}

console.log(`Verified built PostHog candidate ${candidate.upstreamCommit}`);
