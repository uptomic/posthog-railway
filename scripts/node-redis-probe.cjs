"use strict";

const assert = require("node:assert/strict");
const { lookup } = require("node:dns/promises");
const { createRedisClient } = require("/code/nodejs/dist/common/utils/db/redis.js");
const overlay = process.argv[2] === "overlay";
assert.equal(createRedisClient.toString().includes("railwayRedisOptions"), overlay);

async function probe(host, family, expectedFamily) {
  const client = await createRedisClient(`redis://${host}:6379`, {
    connectTimeout: 2500,
    retryStrategy: () => null,
    lazyConnect: true,
    ...(family === undefined ? {} : { family }),
  }, "disposable-ip-family-proof");
  try {
    assert.equal(await client.ping(), "PONG");
    assert.equal(client.options.family, expectedFamily);
  } finally {
    await client.quit();
  }
}

(async () => {
  if (!overlay) {
    // ioredis can wrap ENOTFOUND as "Connection is closed". Prove the DNS cause
    // directly, and isolate construction from PING/assertion/QUIT failures.
    await assert.rejects(lookup("ipv6.railway.internal", { family: 4 }), { code: "ENOTFOUND" });
    await probe("ipv6.railway.internal", 6, 6);
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
  console.error(`Node Redis protocol proof failed: ${error.code ?? error.name}`);
  process.exit(1);
});
