import { fileURLToPath } from "node:url";
import { overlayFingerprint } from "../../images/node/apply-overlay.cjs";
import type { CandidateRelease, PosthogLock } from "./upstream";

export function nodeOverlayProvenance(lock: PosthogLock): CandidateRelease["nodeOverlay"] {
  return {
    baseImage: lock.officialImages.node.image,
    baseRevision: lock.officialImages.node.revision,
    fingerprintSha256: overlayFingerprint(
      lock.officialImages.node.image,
      fileURLToPath(new URL("../../images/node", import.meta.url)),
    ),
  };
}

export function nodeCandidateTag(lock: PosthogLock): string {
  return `sha-${lock.upstreamCommit.slice(0, 12)}-overlay-${nodeOverlayProvenance(lock).fingerprintSha256.slice(0, 16)}`;
}

export function assertNodeOverlayCandidate(candidate: CandidateRelease, lock: PosthogLock): void {
  const expected = nodeOverlayProvenance(lock);
  if (
    !/^ghcr\.io\/uptomic\/posthog-railway\/node@sha256:[0-9a-f]{64}$/.test(candidate.images.node ?? "") ||
    candidate.nodeOverlay?.baseImage !== expected.baseImage ||
    candidate.nodeOverlay?.baseRevision !== expected.baseRevision ||
    candidate.nodeOverlay?.fingerprintSha256 !== expected.fingerprintSha256
  ) {
    throw new Error("Built Node overlay does not match the locked base image and current overlay files");
  }
}
