import type { CandidateRelease } from "./lib/upstream";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commit = process.env.EXPECTED_COMMIT;
const mcpDigest = process.env.MCP_DIGEST;

if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("EXPECTED_COMMIT must be a full Git commit SHA");
}
if (!mcpDigest || !digestPattern.test(mcpDigest)) {
  throw new Error("MCP_DIGEST must be an OCI sha256 digest");
}

const release: CandidateRelease = {
  builtAt: new Date().toISOString(),
  images: {
    mcp: `ghcr.io/uptomic/posthog-railway/mcp@${mcpDigest}`,
  },
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
    JSON.stringify(existing.images) === JSON.stringify(release.images)
  ) {
    release.builtAt = existing.builtAt;
  }
}

await Bun.write(candidatePath, `${JSON.stringify(release, null, 2)}\n`);
