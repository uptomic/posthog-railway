"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const overlayFiles = ["Dockerfile", "apply-overlay.cjs", "guard.json", "railway-redis-options.cjs"];
const sharedClientPath = "/code/nodejs/dist/common/utils/db/redis.js";
const constructorAnchor = "const redis = new ioredis_1.default(url, {\n        ...options,";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function overlayFingerprint(baseImage, directory = __dirname) {
  return sha256(JSON.stringify({
    baseImage,
    files: overlayFiles.map((file) => [file, sha256(readFileSync(join(directory, file)))]),
  }));
}

function patchRedisSource(source, expectedFunctionSha256) {
  const matches = source.match(/^async function createRedisClient\(url, options, connectionName\) \{[\s\S]*?^\}/gm) ?? [];
  const original = matches[0];
  if (matches.length !== 1 || sha256(original) !== expectedFunctionSha256 || original.split(constructorAnchor).length !== 2) {
    throw new Error("NODE_REDIS_FUNCTION_DRIFT");
  }
  const replacement = original.replace(
    constructorAnchor,
    "const redis = new ioredis_1.default(url, {\n        ...require(\"/opt/uptomic-node-overlay/railway-redis-options.cjs\").railwayRedisOptions(url, options),",
  );
  return source.replace(original, replacement);
}

function applyOverlay() {
  const baseImage = process.env.NODE_BASE_IMAGE;
  const baseRevision = process.env.NODE_BASE_REVISION;
  if (!/^ghcr\.io\/posthog\/posthog-node@sha256:[0-9a-f]{64}$/.test(baseImage ?? "") ||
      !/^[0-9a-f]{40}$/.test(baseRevision ?? "") ||
      readFileSync("/code/commit.txt", "utf8").trim() !== baseRevision) {
    throw new Error("NODE_BASE_PROVENANCE_MISMATCH");
  }
  const fingerprintSha256 = overlayFingerprint(baseImage);
  if (fingerprintSha256 !== process.env.NODE_OVERLAY_SHA256) {
    throw new Error("NODE_OVERLAY_FINGERPRINT_MISMATCH");
  }
  const guard = JSON.parse(readFileSync(join(__dirname, "guard.json"), "utf8"));
  const redis = require.resolve("ioredis/package.json", { paths: ["/code/nodejs"] });
  if (JSON.parse(readFileSync(redis, "utf8")).version !== guard.ioredisVersion) {
    throw new Error("NODE_IOREDIS_VERSION_DRIFT");
  }
  const patched = patchRedisSource(readFileSync(sharedClientPath, "utf8"), guard.functionSha256);
  writeFileSync(sharedClientPath, patched);
  writeFileSync("/code/node-overlay-provenance.json", `${JSON.stringify({ baseImage, baseRevision, fingerprintSha256 })}\n`);
}

module.exports = { overlayFingerprint, patchRedisSource };
if (require.main === module) applyOverlay();
