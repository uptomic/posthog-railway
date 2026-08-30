import assert from "node:assert/strict";

const [image, baseImage, baseVersion, fingerprintSha256, upstreamCommit] = Bun.argv.slice(2);
if (!image || !baseImage || !baseVersion || !fingerprintSha256 || !upstreamCommit) {
  throw new Error("Usage: clickhouse-smoke.ts IMAGE BASE_IMAGE BASE_VERSION BUILD_SHA256 UPSTREAM_COMMIT");
}
const container = `posthog-clickhouse-proof-${Date.now()}`;
const volume = `${container}-data`;
let stage = "image-provenance";
let containerCreated = false;
let volumeCreated = false;

async function docker(args: string[], includeStderr = false): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`Disposable ClickHouse proof ${stage} (${args[0]}): ${stdout}\n${stderr}`);
  return (includeStderr ? `${stdout}\n${stderr}` : stdout).trim();
}

async function query(sql: string, user = "clickhouse"): Promise<string> {
  return docker(["exec", container, "clickhouse-client", "--user", user,
    ...(user === "clickhouse" ? ["--password", "test-only"] : []),
    "--receive_timeout", "30", "--query", sql]);
}

try {
  await docker(["pull", baseImage]);
  await docker(["pull", image]);
  const [baseConfig] = JSON.parse(await docker(["image", "inspect", baseImage]));
  const [candidate] = JSON.parse(await docker(["image", "inspect", image]));
  assert.equal(candidate.Architecture, "amd64");
  assert.equal(candidate.Os, "linux");
  assert.equal(baseConfig.Architecture, candidate.Architecture);
  assert.deepEqual(candidate.RootFS.Layers.slice(0, baseConfig.RootFS.Layers.length), baseConfig.RootFS.Layers);
  assert.equal(candidate.Config.Labels["org.opencontainers.image.revision"], upstreamCommit);
  assert.equal(candidate.Config.Labels["io.uptomic.clickhouse.base-image"], baseImage);
  assert.equal(candidate.Config.Labels["io.uptomic.clickhouse.build-sha256"], fingerprintSha256);
  for (const field of ["Cmd", "Entrypoint", "User", "WorkingDir", "Env"]) {
    assert.deepEqual(candidate.Config[field], baseConfig.Config[field], `Inherited ${field} changed`);
  }

  stage = "empty-data-volume";
  await docker(["volume", "create", volume]);
  volumeCreated = true;
  // nocopy reproduces an existing production mount: Docker must not populate
  // this empty volume with any executables baked beneath the image data path.
  // Production's existing data is already owned by clickhouse. The explicit
  // runtime command bypasses the official entrypoint's initial root chown, so
  // prepare ownership of this disposable empty mount only, without copying data.
  await docker(["run", "--rm", "--entrypoint", "sh",
    "--mount", `type=volume,source=${volume},target=/var/lib/clickhouse,volume-nocopy`,
    image, "-c", "chown clickhouse:clickhouse /var/lib/clickhouse && test ! -e /var/lib/clickhouse/user_scripts/aggregate_funnel"]);
  await docker(["create", "--name", container,
    "--mount", `type=volume,source=${volume},target=/var/lib/clickhouse,volume-nocopy`,
    "-e", "RAILWAY_PRIVATE_DOMAIN=clickhouse.railway.internal",
    "-e", "CLICKHOUSE_USER=clickhouse", "-e", "CLICKHOUSE_PASSWORD=test-only",
    "-e", "KAFKA_HOSTS=localhost:9092", image,
    "clickhouse", "su", "clickhouse", "clickhouse-server", "--config-file=/etc/clickhouse-server/config.xml"]);
  containerCreated = true;
  await docker(["start", container]);
  stage = "server-readiness";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = await query("SELECT 1") === "1"; } catch { /* Only the disposable server is starting. */ }
    if (ready) break;
    await Bun.sleep(500);
  }
  assert.ok(ready, "Mounted ClickHouse did not become ready");
  assert.equal(await query("SELECT version()"), baseVersion);

  stage = "mounted-asset-permissions";
  await docker(["exec", "--user", "clickhouse", container, "sh", "-c",
    "test ! -e /var/lib/clickhouse/user_scripts/aggregate_funnel && test -x /opt/posthog/user_scripts/aggregate_funnel && test -r /opt/posthog/user_scripts/aggregate_funnel_x86_64"]);
  assert.equal(await docker(["exec", container, "clickhouse", "extract-from-config",
    "--config-file=/etc/clickhouse-server/config.xml", "--key=user_scripts_path"]), "/opt/posthog/user_scripts/");

  stage = "cluster-and-dictionary-auth";
  assert.equal(await query("SELECT host_name FROM system.clusters WHERE cluster = 'posthog' LIMIT 1"), "clickhouse.railway.internal");
  assert.equal(await query("SELECT is_local FROM system.clusters WHERE cluster = 'posthog' LIMIT 1"), "1");
  assert.equal(await query("SELECT count() FROM clusterAllReplicas('posthog', system.one)"), "1");
  assert.equal(await query("SELECT 1", "default"), "1");

  stage = "mounted-volume-aggregate-funnel";
  const sql = await Bun.file(new URL("./clickhouse-funnel-proof.sql", import.meta.url)).text();
  assert.equal(await query(sql), "1", "Synthetic ordered three-step browser funnel changed");
  console.log("ClickHouse mounted-volume aggregate_funnel SQL, pinned engine, provenance and cluster authentication passed");
} catch (error) {
  const state = containerCreated ? await docker(["inspect", "--format", "{{json .State}}", container]).catch(() => "unavailable") : "not-created";
  const logs = containerCreated ? await docker(["logs", "--tail", "60", container], true).catch(() => "unavailable") : "not-created";
  console.error(JSON.stringify({ stage, message: error instanceof Error ? error.message : String(error),
    state: state.slice(0, 2000), logs: logs.slice(-12000) }));
  throw error;
} finally {
  try {
    if (containerCreated) await docker(["rm", "--force", container]);
  } finally {
    if (volumeCreated) await docker(["volume", "rm", volume]);
  }
}
