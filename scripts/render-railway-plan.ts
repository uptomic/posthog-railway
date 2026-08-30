import lockPayload from "../posthog.lock.json";
import type { PosthogLock } from "./lib/upstream";

const lock = lockPayload as PosthogLock;
const plan = {
  bundle: lock.upstreamCommit,
  notes: [
    "This is a read-only plan. Backups and canary verification are required before apply.",
    "Data-service upgrades are intentionally separate from this application bundle.",
  ],
  services: {
    Capture: { image: lock.officialImages.capture.image },
    "Cyclotron Janitor": { image: lock.officialImages["cyclotron-janitor"].image },
    "Feature Flags": { image: lock.officialImages["feature-flags"].image },
    Livestream: { image: lock.officialImages.livestream.image },
    Plugins: {
      image: lock.candidateImages.node,
      startCommand: "./bin/posthog-node --no-restart-loop",
    },
    "PostHog MCP": { image: lock.candidateImages.mcp },
    "Property Defs RS": { image: lock.officialImages["property-defs-rs"].image },
    "Replay Capture": { image: lock.officialImages.capture.image },
    "Temporal Django Worker": {
      image: lock.officialImages.main.image,
      startCommand: "/compose/temporal-django-worker",
    },
    Web: { image: lock.officialImages.main.image, startCommand: "/compose/start" },
    Worker: {
      image: lock.officialImages.main.image,
      startCommand: "./bin/docker-worker-celery --with-scheduler",
    },
    "posthog-ingestion": {
      image: lock.candidateImages.node,
      startCommand: "./bin/posthog-node --no-restart-loop",
    },
  },
};

console.log(JSON.stringify(plan, null, 2));
