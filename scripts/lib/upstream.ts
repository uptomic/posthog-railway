export const upstreamRepository = "PostHog/posthog";
export const upstreamRegistry = "ghcr.io";

export const officialComponents = {
  main: "posthog/posthog",
  capture: "posthog/posthog/capture",
  "feature-flags": "posthog/posthog/feature-flags",
  livestream: "posthog/posthog/livestream",
  node: "posthog/posthog-node",
  "personhog-replica": "posthog/posthog/personhog-replica",
  "personhog-router": "posthog/posthog/personhog-router",
  "property-defs-rs": "posthog/posthog/property-defs-rs",
  "sqlx-migrate": "posthog/posthog/sqlx-migrate",
} as const;

// The inherited Railway stack predates ClickHouse migration 0210. Newer PostHog
// source makes historical migrations reference columns introduced later in the
// same migration chain. Jump upgrades therefore advance through two exact
// predecessor images before the release image. These are one-shot migration
// evidence, never long-running application runtimes.
export const migrationBridgeImages = {
  "pre-session-replay-ai": {
    repository: "posthog/posthog",
    tag: "sha-84a70e4",
  },
  "pre-session-replay-surfacing": {
    repository: "posthog/posthog",
    tag: "sha-42a7cf3",
  },
} as const;

export type OfficialComponent = keyof typeof officialComponents;

export interface LockedImage {
  createdAt: string;
  digest: string;
  image: string;
  revision: string;
  source: string;
}
export interface PosthogLock {
  candidateImages: {
    mcp: string;
  };
  supportingImages: {
    gateway: string;
  };
  officialImages: Record<OfficialComponent, LockedImage>;
  migrationBridges: Record<keyof typeof migrationBridgeImages, LockedImage>;
  resolvedAt: string;
  schemaVersion: 1;
  upstreamCommit: string;
  upstreamRepository: typeof upstreamRepository;
}

export interface CandidateRelease {
  builtAt: string;
  images: {
    clickhouse: string;
    mcp: string;
    node: string;
  };
  nodeOverlay: {
    baseImage: string;
    baseRevision: string;
    fingerprintSha256: string;
  };
  schemaVersion: 1;
  upstreamCommit: string;
}

export function isSameRelease(left: PosthogLock, right: PosthogLock): boolean {
  const { resolvedAt: _leftResolvedAt, ...leftRelease } = left;
  const { resolvedAt: _rightResolvedAt, ...rightRelease } = right;
  return JSON.stringify(leftRelease) === JSON.stringify(rightRelease);
}

const manifestAccept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface RegistryToken {
  token?: string;
}

interface RegistryManifest {
  config?: { digest?: string };
  manifests?: Array<{
    digest?: string;
    platform?: { architecture?: string; os?: string };
  }>;
}

interface ImageConfig {
  created?: string;
  config?: {
    Labels?: Record<string, string>;
  };
}

async function jsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "User-Agent": "uptomic-posthog-railway",
  };
}

export async function resolveGithubHead(): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${upstreamRepository}/commits/master`, {
    headers: githubHeaders(),
  });
  const payload = await jsonResponse<{ sha?: string }>(response, "GitHub upstream head");
  if (!payload.sha || !/^[0-9a-f]{40}$/.test(payload.sha)) {
    throw new Error("GitHub upstream head did not contain a commit SHA");
  }
  return payload.sha;
}

export async function isAncestor(revision: string, head: string): Promise<boolean> {
  if (revision === head) {
    return true;
  }
  const response = await fetch(
    `https://api.github.com/repos/${upstreamRepository}/compare/${revision}...${head}`,
    {
      headers: githubHeaders(),
    },
  );
  const payload = await jsonResponse<{ status?: string }>(response, `GitHub compare ${revision}`);
  return payload.status === "ahead" || payload.status === "identical";
}

export async function resolveGhcrImage(repository: string, tag = "master"): Promise<LockedImage> {
  const tokenResponse = await fetch(
    `https://ghcr.io/token?scope=repository:${encodeURIComponent(repository)}:pull`,
  );
  const tokenPayload = await jsonResponse<RegistryToken>(tokenResponse, `GHCR token ${repository}`);
  if (!tokenPayload.token) {
    throw new Error(`GHCR token missing for ${repository}`);
  }
  const headers = {
    Accept: manifestAccept,
    Authorization: `Bearer ${tokenPayload.token}`,
  };
  const manifestResponse = await fetch(
    `https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
    { headers },
  );
  const digest = manifestResponse.headers.get("docker-content-digest");
  let manifest = await jsonResponse<RegistryManifest>(
    manifestResponse,
    `GHCR manifest ${repository}:${tag}`,
  );
  if (manifest.manifests) {
    const linuxAmd64 = manifest.manifests.find(
      (item) => item.platform?.architecture === "amd64" && item.platform.os === "linux",
    );
    if (!linuxAmd64?.digest) {
      throw new Error(`GHCR image ${repository}:${tag} has no linux/amd64 manifest`);
    }
    const childResponse = await fetch(
      `https://ghcr.io/v2/${repository}/manifests/${linuxAmd64.digest}`,
      { headers },
    );
    manifest = await jsonResponse<RegistryManifest>(
      childResponse,
      `GHCR child manifest ${repository}:${tag}`,
    );
  }
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest) || !manifest.config?.digest) {
    throw new Error(`GHCR image ${repository}:${tag} did not resolve immutably`);
  }
  const configResponse = await fetch(
    `https://ghcr.io/v2/${repository}/blobs/${manifest.config.digest}`,
    { headers: { Authorization: `Bearer ${tokenPayload.token}` } },
  );
  const config = await jsonResponse<ImageConfig>(
    configResponse,
    `GHCR image config ${repository}:${tag}`,
  );
  const labels = config.config?.Labels ?? {};
  const createdAt = config.created;
  const revision = labels["org.opencontainers.image.revision"];
  const source = labels["org.opencontainers.image.source"];
  if (
    !createdAt ||
    Number.isNaN(Date.parse(createdAt)) ||
    !revision ||
    !/^[0-9a-f]{40}$/.test(revision) ||
    source !== "https://github.com/PostHog/posthog"
  ) {
    throw new Error(`GHCR image ${repository}:${tag} has invalid upstream provenance`);
  }
  return {
    createdAt,
    digest,
    image: `${upstreamRegistry}/${repository}@${digest}`,
    revision,
    source,
  };
}
