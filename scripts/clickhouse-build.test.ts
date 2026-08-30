import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assertClickhouseBuildCandidate, clickhouseBuildFiles, clickhouseBuildProvenance, clickhouseCandidateTag } from "./lib/clickhouse-build";
import { assertCandidateMatchesLock } from "./render-railway-plan";
import { nodeOverlayProvenance } from "./lib/node-overlay";
import type { CandidateRelease, PosthogLock } from "./lib/upstream";
import lockPayload from "../posthog.lock.json";
import candidatePayload from "../posthog.candidate.json";

const lock = lockPayload as PosthogLock;
const candidate: CandidateRelease = { ...candidatePayload,
  upstreamCommit: lock.upstreamCommit,
  images: { ...candidatePayload.images, clickhouse: `ghcr.io/uptomic/posthog-railway/clickhouse@sha256:${"2".repeat(64)}` },
  clickhouseBuild: clickhouseBuildProvenance(lock),
  nodeOverlay: nodeOverlayProvenance(lock),
};

describe("ClickHouse immutable executable assets", () => {
  test("reserves bounded nested-query headroom without starving Kafka consumers", async () => {
    const runtime = await Bun.file(new URL("../images/clickhouse.railway.xml", import.meta.url)).text();
    const users = await Bun.file(new URL("../images/clickhouse.railway-users.xml", import.meta.url)).text();
    expect(runtime).toContain("<max_thread_pool_size>640</max_thread_pool_size>");
    expect(runtime).toContain("<thread_pool_queue_size>640</thread_pool_queue_size>");
    expect(runtime).toContain("<background_schedule_pool_size>128</background_schedule_pool_size>");
    expect(runtime).toContain("<background_message_broker_schedule_pool_size>128</background_message_broker_schedule_pool_size>");
    expect(users).toContain("<max_threads>8</max_threads>");
    expect(users).toContain('<password from_env="CLICKHOUSE_PASSWORD" />');
    expect(users).toContain("<profile>readonly</profile>");
  });

  test("requires old-image saturation RED and candidate pressure GREEN before finalization", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/build-candidate.yml", import.meta.url)).text()) as any;
    expect(workflow.jobs.verify.steps.at(-1).run).toContain('bun scripts/clickhouse-pressure.ts "$image"');
    expect(workflow.jobs.verify.steps.at(-1).run).toContain('Expected exactly one immutable ClickHouse digest');
  });

  test("stores executable UDFs outside the persistent data mount", async () => {
    const dockerfile = await Bun.file(new URL("../images/clickhouse.Dockerfile", import.meta.url)).text();
    const config = await Bun.file(new URL("../images/clickhouse.railway.xml", import.meta.url)).text();
    expect(dockerfile).toContain("COPY --chown=clickhouse:clickhouse posthog/posthog/user_scripts /opt/posthog/user_scripts");
    expect(dockerfile).not.toContain("COPY posthog/posthog/user_scripts /var/lib/clickhouse");
    expect(config).toContain('<user_scripts_path replace="replace">/opt/posthog/user_scripts/</user_scripts_path>');
    expect(dockerfile).toContain("test -x /opt/posthog/user_scripts/aggregate_funnel");
  });

  test("requires a mounted-volume SQL funnel proof before candidate finalization", async () => {
    const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/build-candidate.yml", import.meta.url)).text()) as any;
    expect(workflow.jobs.verify.steps.at(-1).run).toContain("bun scripts/clickhouse-smoke.ts");
    expect(workflow.jobs.resolve.outputs.clickhouse_build_sha256).toBe("${{ steps.lock.outputs.clickhouse_build_sha256 }}");
    expect(workflow.jobs["build-clickhouse"].steps[0].with.ref).toBe("${{ needs.resolve.outputs.source_sha }}");
    expect(workflow.jobs.finalize.steps.find((step: any) => step.name === "Lock the verified candidate digests").env.CLICKHOUSE_BUILD_SHA256).toBe("${{ needs.resolve.outputs.clickhouse_build_sha256 }}");
    const smoke = await Bun.file(new URL("./clickhouse-smoke.ts", import.meta.url)).text();
    expect(smoke).toContain("target=/var/lib/clickhouse,volume-nocopy");
    expect(smoke).toContain('"exec", "--user", "clickhouse"');
    expect(smoke).toContain('...(user === "clickhouse" ? ["--password", "test-only", "--receive_timeout", "30"] : [])');
    expect(smoke).toContain('assert.equal(await query(sql), "1"');
    expect(smoke).toContain('candidate.RootFS.Layers.slice(0, baseConfig.RootFS.Layers.length)');
    expect(smoke).toContain('["volume", "rm", volume]');
    expect(smoke).not.toContain('"--publish"');
    const sql = await Bun.file(new URL("./clickhouse-funnel-proof.sql", import.meta.url)).text();
    expect(sql).toContain("WITH aggregate_funnel(");
    expect(sql).toContain("AND result[1].5 = 7");
    expect(sql).not.toMatch(/\b(?:FROM|INSERT|UPDATE|CREATE|ALTER)\b/i);
  });

  test("fingerprints all owned image inputs plus upstream assets and pins the same engine", async () => {
    expect(clickhouseBuildFiles).toEqual(["clickhouse-base.json", "clickhouse.Dockerfile", "clickhouse-entrypoint.sh", "clickhouse.railway-users.xml", "clickhouse.railway.xml"]);
    const files = await Promise.all(clickhouseBuildFiles.map(async name => [name, createHash("sha256")
      .update(await Bun.file(new URL(`../images/${name}`, import.meta.url)).bytes()).digest("hex")]));
    const expected = createHash("sha256").update(JSON.stringify({ upstreamCommit: lock.upstreamCommit, files })).digest("hex");
    expect(clickhouseBuildProvenance(lock)).toEqual({
      baseImage: "docker.io/clickhouse/clickhouse-server@sha256:95f7cbf466dba734947775eb74808a13a3558e4398666ea6b1d992af85b9740d",
      baseVersion: "26.6.2.158", fingerprintSha256: expected,
    });
    expect(clickhouseCandidateTag(lock)).toBe(`sha-${lock.upstreamCommit.slice(0, 12)}-bundle-${expected.slice(0, 16)}`);
    expect(clickhouseBuildProvenance({ upstreamCommit: "f".repeat(40) }).fingerprintSha256).not.toBe(expected);
  });

  test("rejects missing, stale or mutable ClickHouse builds in verification and rendering", () => {
    expect(() => assertClickhouseBuildCandidate(candidate, lock)).not.toThrow();
    for (const stale of [
      { ...candidate, clickhouseBuild: undefined },
      { ...candidate, clickhouseBuild: { ...candidate.clickhouseBuild, fingerprintSha256: "0".repeat(64) } },
      { ...candidate, clickhouseBuild: { ...candidate.clickhouseBuild, baseVersion: "25.1" } },
      { ...candidate, clickhouseBuild: { ...candidate.clickhouseBuild, baseImage: "clickhouse/clickhouse-server:latest" } },
      { ...candidate, images: { ...candidate.images, clickhouse: "ghcr.io/uptomic/posthog-railway/clickhouse:latest" } },
    ]) {
      expect(() => assertClickhouseBuildCandidate(stale as CandidateRelease, lock)).toThrow("Built ClickHouse candidate");
      expect(() => assertCandidateMatchesLock(stale as CandidateRelease, lock)).toThrow("Built ClickHouse candidate");
    }
  });
});
