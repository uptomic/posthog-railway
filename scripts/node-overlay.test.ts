import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { railwayRedisOptions } from "../images/node/railway-redis-options.cjs";
import { overlayFingerprint, patchRedisSource } from "../images/node/apply-overlay.cjs";
import { nodeCandidateTag, nodeOverlayProvenance } from "./lib/node-overlay";
import lockPayload from "../posthog.lock.json";
import type { PosthogLock } from "./lib/upstream";

const lock = lockPayload as PosthogLock;

describe("Railway private Redis IPv6 compatibility", () => {
  test("selects numeric family zero only for private Redis URL hostnames", () => {
    for (const url of [
      "redis://valkey.railway.internal:6379",
      "rediss://cache.railway.internal:6380/1",
      "redis://CACHE.RAILWAY.INTERNAL.:6379",
    ]) {
      expect(railwayRedisOptions(url)).toEqual({ family: 0 });
    }
  });

  test("preserves unrelated hosts, transports, bare endpoints and explicit family choices", () => {
    for (const url of [
      "redis://localhost:6379", "redis://cache.example.com", "redis://railway.internal",
      "redis://cache.railway.internal.example.com", "http://cache.railway.internal",
      "cache.railway.internal", "/tmp/redis.sock", "invalid://[",
    ]) {
      const options = { connectTimeout: 2000 };
      expect(railwayRedisOptions(url, options)).toBe(options);
    }
    for (const family of [0, 4, 6, "6", null]) {
      const options = { family, port: 6379 };
      expect(railwayRedisOptions("redis://cache.railway.internal", options)).toBe(options);
    }
    for (const options of [{ host: "external.example.com" }, { path: "/tmp/redis.sock" }]) {
      expect(railwayRedisOptions("redis://cache.railway.internal", options)).toBe(options);
    }
    const options = { connectTimeout: 2000 };
    expect(railwayRedisOptions("redis://cache.railway.internal?family=6", options)).toBe(options);
    expect(railwayRedisOptions("redis://cache.railway.internal?host=external.example.com", options)).toBe(options);
    expect(railwayRedisOptions("redis://cache.railway.internal?path=/tmp/redis.sock", options)).toBe(options);
  });

  test("retains credentials and all caller options without mutation or logging", () => {
    const options = { password: "synthetic-local-only", connectionName: "fixture", lazyConnect: true };
    expect(railwayRedisOptions("redis://cache.railway.internal", options)).toEqual({ ...options, family: 0 });
    expect(options).not.toHaveProperty("family");
  });
});

describe("immutable Node release contract", () => {
  test("fingerprints the official base and every executable overlay input", async () => {
    const files = ["Dockerfile", "apply-overlay.cjs", "guard.json", "railway-redis-options.cjs"];
    const hashes = await Promise.all(files.map(async (name) => [
      name, createHash("sha256").update(await Bun.file(new URL(`../images/node/${name}`, import.meta.url)).text()).digest("hex"),
    ]));
    const expected = createHash("sha256").update(JSON.stringify({ baseImage: lock.officialImages.node.image, files: hashes })).digest("hex");
    expect(nodeOverlayProvenance(lock).fingerprintSha256).toBe(expected);
    expect(overlayFingerprint("ghcr.io/posthog/posthog-node@sha256:" + "a".repeat(64))).not.toBe(expected);
    expect(nodeCandidateTag(lock)).toBe(`sha-${lock.upstreamCommit.slice(0, 12)}-overlay-${expected.slice(0, 16)}`);
    const dockerfile = await Bun.file(new URL("../images/node/Dockerfile", import.meta.url)).text();
    expect(dockerfile).toContain("FROM ${NODE_BASE_IMAGE}");
    expect(dockerfile).not.toMatch(/^(CMD|ENTRYPOINT|USER|ENV|WORKDIR)\s/m);
  });

  test("manual builds retain the current lock and exact overlay source; all images verify before finalization", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/build-candidate.yml", import.meta.url)).text()) as any;
    expect(workflow.on.workflow_dispatch.inputs.update_upstream.default).toBe(false);
    const resolve = workflow.jobs.resolve;
    expect(resolve.steps.find((step: any) => step.id === "lock").run).toContain('"${{ github.event_name }}" = schedule ] || [ "${{ inputs.update_upstream }}" = true');
    expect(resolve.outputs.source_sha).toBe("${{ github.sha }}");
    expect(workflow.jobs["build-node"].steps[0].with.ref).toBe("${{ needs.resolve.outputs.source_sha }}");
    expect(workflow.jobs.verify.steps[0].with.ref).toBe("${{ needs.resolve.outputs.source_sha }}");
    expect(workflow.jobs.verify.needs).toContain("build-node");
    expect(workflow.jobs.verify.strategy.matrix.component).toEqual(["clickhouse", "mcp", "node"]);
    expect(workflow.jobs.finalize.needs).toContain("verify");
    expect(workflow.jobs.verify.steps.at(-1).run).toContain("bun scripts/node-smoke.ts");
  });

  test("baseline proves the exact DNS failure separately from shared-client connection failure", async () => {
    const probe = await Bun.file(new URL("./node-redis-probe.cjs", import.meta.url)).text();
    expect(probe).toContain('lookup("ipv6.railway.internal", { family: 4 })');
    expect(probe).toContain('{ code: "ENOTFOUND" }');
    expect(probe).toContain('await probe("ipv6.railway.internal", 6, 6)');
    expect(probe).not.toContain('assert.rejects(probe(');
  });

  test("uses a multi-platform Redis fixture, verifies its selected architecture and retains failure diagnostics", async () => {
    const smoke = await Bun.file(new URL("./node-smoke.ts", import.meta.url)).text();
    expect(smoke).toContain("sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf");
    expect(smoke).not.toContain("sha256:f8d15882ba108587477ce13c00ab0551933a84138427b7cc9abadfbe45ffd973");
    expect(smoke).toContain('redisConfig.Architecture !== baseConfig.Architecture');
    expect(smoke).toContain('["logs", "--tail", "60", container]');
    expect(smoke).toContain('"{{json .State}}"');
    expect(smoke).not.toContain('["run", "--rm", "-d", "--name", container');
  });
});

describe("guarded shared-client overlay", () => {
  const originalFunction = [
    "async function createRedisClient(url, options, connectionName) {",
    "    const redis = new ioredis_1.default(url, {",
    "        ...options,",
    "        maxRetriesPerRequest: -1,",
    "    });",
    "    await redis.info();",
    "    return redis;",
    "}",
  ].join("\n");
  const hash = createHash("sha256").update(originalFunction).digest("hex");

  test("changes only options at the guarded shared Redis construction", () => {
    const source = `const before = true;\n${originalFunction}\nexports.createRedisClient = createRedisClient;\n`;
    const patched = patchRedisSource(source, hash);
    expect(patched).toContain("...require(\"/opt/uptomic-node-overlay/railway-redis-options.cjs\").railwayRedisOptions(url, options),");
    expect(patched).toContain("maxRetriesPerRequest: -1");
    expect(patched).toStartWith("const before = true;\n");
    expect(patched).toEndWith("exports.createRedisClient = createRedisClient;\n");
  });

  test("fails closed on semantic drift, missing/duplicate functions or repeat application", () => {
    expect(() => patchRedisSource(originalFunction.replace("-1", "1"), hash)).toThrow("NODE_REDIS_FUNCTION_DRIFT");
    expect(() => patchRedisSource("unrelated source", hash)).toThrow("NODE_REDIS_FUNCTION_DRIFT");
    expect(() => patchRedisSource(`${originalFunction}\n${originalFunction}`, hash)).toThrow("NODE_REDIS_FUNCTION_DRIFT");
    expect(() => patchRedisSource(patchRedisSource(originalFunction, hash), hash)).toThrow("NODE_REDIS_FUNCTION_DRIFT");
  });
});
