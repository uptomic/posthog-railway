import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import base from "../../images/clickhouse-base.json";
import type { CandidateRelease, PosthogLock } from "./upstream";

export const clickhouseBuildFiles = [
  "clickhouse-base.json", "clickhouse.Dockerfile", "clickhouse-entrypoint.sh",
  "clickhouse.railway-users.xml", "clickhouse.railway.xml",
] as const;

export function clickhouseBuildProvenance(lock: Pick<PosthogLock, "upstreamCommit">): CandidateRelease["clickhouseBuild"] {
  if (!/^docker\.io\/clickhouse\/clickhouse-server@sha256:[0-9a-f]{64}$/.test(base.image)) {
    throw new Error("ClickHouse base must be pinned by immutable digest");
  }
  const files = clickhouseBuildFiles.map((name) => [name, createHash("sha256")
    .update(readFileSync(new URL(`../../images/${name}`, import.meta.url))).digest("hex")]);
  return {
    baseImage: base.image,
    baseVersion: base.version,
    fingerprintSha256: createHash("sha256").update(JSON.stringify({ upstreamCommit: lock.upstreamCommit, files })).digest("hex"),
  };
}

export function clickhouseCandidateTag(lock: Pick<PosthogLock, "upstreamCommit">): string {
  return `sha-${lock.upstreamCommit.slice(0, 12)}-bundle-${clickhouseBuildProvenance(lock).fingerprintSha256.slice(0, 16)}`;
}

export function assertClickhouseBuildCandidate(candidate: CandidateRelease, lock: PosthogLock): void {
  const expected = clickhouseBuildProvenance(lock);
  if (
    !/^ghcr\.io\/uptomic\/posthog-railway\/clickhouse@sha256:[0-9a-f]{64}$/.test(candidate.images.clickhouse ?? "") ||
    candidate.clickhouseBuild?.baseImage !== expected.baseImage ||
    candidate.clickhouseBuild?.baseVersion !== expected.baseVersion ||
    candidate.clickhouseBuild?.fingerprintSha256 !== expected.fingerprintSha256
  ) {
    throw new Error("Built ClickHouse candidate does not match the pinned engine and current image files");
  }
}
