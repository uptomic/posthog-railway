"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createRequire } = require("node:module");

const overlayFiles = ["Dockerfile", "apply-overlay.cjs", "guard.json", "railway-redis-options.cjs", "janitor-pool-errors.cjs"];
const sharedClientPath = "/code/nodejs/dist/common/utils/db/redis.js";
const janitorPath = "/code/nodejs/dist/cdp/services/cyclotron-v2/janitor.js";
const constructorAnchor = "const redis = new ioredis_1.default(url, {\n        ...options,";
const janitorPoolAnchor = `        this.pool = new pg_1.Pool({
            connectionString: config.pool.dbUrl,
            max: config.pool.maxConnections ?? 5,
            idleTimeoutMillis: config.pool.idleTimeoutMs ?? 30000,
        });`;

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

function patchJanitorSource(source, expectedConstructorSha256) {
  const matches = source.match(/^    constructor\([\s\S]*?^    \}/gm) ?? [];
  const original = matches[0];
  if (matches.length !== 1 || sha256(original) !== expectedConstructorSha256 ||
      original.split(janitorPoolAnchor).length !== 2 ||
      !source.includes('const pg_1 = require("pg");') ||
      !source.includes('const logger_1 = require("../../../common/utils/logger");')) {
    throw new Error("NODE_JANITOR_CONSTRUCTOR_DRIFT");
  }
  return source.replace(original, original.replace(janitorPoolAnchor,
    `${janitorPoolAnchor}\n        require("/opt/uptomic-node-overlay/janitor-pool-errors.cjs").attachJanitorPoolErrorHandler(this.pool, logger_1.logger);`));
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
  const janitorRequire = createRequire(janitorPath);
  const pgPackage = janitorRequire.resolve("pg/package.json");
  const pgPoolPackage = createRequire(pgPackage).resolve("pg-pool/package.json");
  if (JSON.parse(readFileSync(pgPackage, "utf8")).version !== guard.janitor.pgVersion ||
      JSON.parse(readFileSync(pgPoolPackage, "utf8")).version !== guard.janitor.pgPoolVersion) {
    throw new Error("NODE_JANITOR_PG_VERSION_DRIFT");
  }
  const patched = patchRedisSource(readFileSync(sharedClientPath, "utf8"), guard.functionSha256);
  const patchedJanitor = patchJanitorSource(readFileSync(janitorPath, "utf8"), guard.janitor.constructorSha256);
  // Validate both owners before changing either compiled file.
  writeFileSync(sharedClientPath, patched);
  writeFileSync(janitorPath, patchedJanitor);
  writeFileSync("/code/node-overlay-provenance.json", `${JSON.stringify({ baseImage, baseRevision, fingerprintSha256 })}\n`);
}

module.exports = { overlayFingerprint, patchRedisSource, patchJanitorSource };
if (require.main === module) applyOverlay();
