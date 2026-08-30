"use strict";

const assert = require("node:assert/strict");
const { lookup } = require("node:dns/promises");
let createRedisClient;
const overlay = process.argv[2] === "overlay";
let stage = "load-shared-client";

async function probe(host, family, expectedFamily) {
  stage = `connect:${host}:family=${family ?? "default"}`;
  const client = await createRedisClient(`redis://${host}:6379`, {
    connectTimeout: 2500,
    retryStrategy: () => null,
    lazyConnect: true,
    ...(family === undefined ? {} : { family }),
  }, "disposable-ip-family-proof");
  try {
    stage = `PING:${host}:family=${family ?? "default"}`;
    assert.equal(await client.ping(), "PONG");
    stage = `effective-family:${host}:expected=${expectedFamily}`;
    assert.equal(client.options.family, expectedFamily);
  } finally {
    await client.quit();
  }
  console.log(`${overlay ? "overlay" : "baseline"}: ${host} family=${family ?? "default"} effective=${expectedFamily} PONG`);
}

(async () => {
  ({ createRedisClient } = require("/code/nodejs/dist/common/utils/db/redis.js"));
  stage = "shared-client-overlay-identity";
  assert.equal(createRedisClient.toString().includes("railwayRedisOptions"), overlay);
  if (!overlay) {
    // ioredis can wrap ENOTFOUND as "Connection is closed". Prove the DNS cause
    // directly, and isolate construction from PING/assertion/QUIT failures.
    stage = "baseline:IPv4-DNS-rejection";
    await assert.rejects(lookup("ipv6.railway.internal", { family: 4 }), (error) => {
      assert.equal(error.syscall, "getaddrinfo");
      assert.equal(error.hostname, "ipv6.railway.internal");
      // Docker's internal-only resolver may return SERVFAIL (EAI_AGAIN) instead
      // of NXDOMAIN (ENOTFOUND) when the hosts file contains only an IPv6 record.
      assert.ok(["ENOTFOUND", "EAI_AGAIN"].includes(error.code));
      console.log(`baseline: AAAA-only fixture rejects IPv4 DNS with ${error.code}`);
      return true;
    });
    await probe("ipv6.railway.internal", 6, 6);
    stage = "baseline:default-shared-client-rejection";
    await assert.rejects(createRedisClient("redis://ipv6.railway.internal:6379", {
      connectTimeout: 2500,
      retryStrategy: () => null,
      lazyConnect: true,
    }, "disposable-ip-family-baseline"));
    console.log("Baseline shared Redis client cannot resolve AAAA-only private hostname: reproduced");
  } else {
    await probe("ipv6.railway.internal", undefined, 0);
    await probe("ipv4.railway.internal", undefined, 0);
    await probe("unrelated.example.test", undefined, 4);
    await probe("ipv4.railway.internal", 4, 4);
    await probe("ipv6.railway.internal", 6, 6);
    console.log("Guarded shared Redis client: IPv6, IPv4 fallback, unrelated host and explicit families passed");
  }
  process.exit(0);
})().catch((error) => {
  // Only fixture hostnames/options and assertion primitives are present here.
  console.error(`Node Redis protocol proof failed: ${JSON.stringify({
    mode: overlay ? "overlay" : "baseline", stage, code: error.code ?? error.name,
    message: error.message, actual: error.actual, expected: error.expected,
  }).slice(0, 3000)}`);
  process.exit(1);
});
