import lockPayload from "../posthog.lock.json";
import { nodeCandidateTag, nodeOverlayProvenance } from "./lib/node-overlay";
import type { PosthogLock } from "./lib/upstream";

const lock = lockPayload as PosthogLock;
const provenance = nodeOverlayProvenance(lock);
console.log(`node_base_image=${provenance.baseImage}`);
console.log(`node_base_revision=${provenance.baseRevision}`);
console.log(`node_overlay_sha256=${provenance.fingerprintSha256}`);
console.log(`node_tag=${nodeCandidateTag(lock)}`);
