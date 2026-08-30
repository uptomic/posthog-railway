const [image, baseImage, baseRevision, fingerprintSha256] = Bun.argv.slice(2);
if (!image || !baseImage || !baseRevision || !fingerprintSha256) {
  throw new Error("Usage: node-smoke.ts IMAGE BASE_IMAGE BASE_REVISION OVERLAY_SHA256");
}
// Multi-platform Redis 7.4.11-alpine index, not the local ARM64 child manifest.
const redisImage = "docker.io/library/redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf";
// PostgreSQL 17-alpine multi-platform index (linux/amd64 and linux/arm64 verified).
const postgresImage = "docker.io/library/postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const container = `posthog-node-redis-proof-${Date.now()}`;
const postgresContainer = `${container}-postgres`;
const network = `${container}-network`;
const globalId = randomBytes(5).toString("hex");
const ipv6Prefix = `fd${globalId.slice(0, 2)}:${globalId.slice(2, 6)}:${globalId.slice(6)}:1`;
const fixtureIpv6 = `${ipv6Prefix}::2`;

async function docker(args: string[], input?: string, includeStderr = false, timeoutMs = 120000): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  clearTimeout(deadline);
  if (exit !== 0) throw new Error(`Disposable Node proof failed (${args[0]}): ${stdout}\n${stderr}`);
  return includeStderr ? `${stdout}\n${stderr}` : stdout;
}

await docker(["pull", baseImage], undefined, false, 600000);
await docker(["pull", image], undefined, false, 600000);
const [baseConfig] = JSON.parse(await docker(["image", "inspect", baseImage]));
const [overlayConfig] = JSON.parse(await docker(["image", "inspect", image]));
for (const field of ["Cmd", "Entrypoint", "User", "WorkingDir", "Env"]) {
  if (JSON.stringify(baseConfig.Config[field]) !== JSON.stringify(overlayConfig.Config[field])) {
    throw new Error(`Node overlay unexpectedly changed inherited ${field}`);
  }
}
if (overlayConfig.Config.Labels["org.opencontainers.image.revision"] !== baseRevision) {
  throw new Error("Node overlay changed the upstream revision");
}
const provenance = JSON.parse(await docker([
  "run", "--rm", "--entrypoint", "node", image, "-e",
  'process.stdout.write(require("fs").readFileSync("/code/node-overlay-provenance.json", "utf8"))',
]));
if (JSON.stringify(provenance) !== JSON.stringify({ baseImage, baseRevision, fingerprintSha256 })) {
  throw new Error("Node overlay runtime provenance does not match build inputs");
}

const redisPlatform = `${baseConfig.Os}/${baseConfig.Architecture}`;
await docker(["pull", "--platform", redisPlatform, redisImage]);
const [redisConfig] = JSON.parse(await docker(["image", "inspect", redisImage]));
if (redisConfig.Os !== baseConfig.Os || redisConfig.Architecture !== baseConfig.Architecture) {
  throw new Error("Disposable Redis fixture platform does not match the exact Node image");
}
await docker(["pull", "--platform", redisPlatform, postgresImage]);
const [postgresConfig] = JSON.parse(await docker(["image", "inspect", postgresImage]));
if (postgresConfig.Os !== baseConfig.Os || postgresConfig.Architecture !== baseConfig.Architecture) {
  throw new Error("Disposable PostgreSQL fixture platform does not match the exact Node image");
}
// glibc maps a ::1-only hosts alias back to 127.0.0.1 for AF_INET lookups.
// Use an actual isolated ULA address so the AAAA-only regression is meaningful.
await docker(["network", "create", "--internal", "--ipv6", "--subnet", `${ipv6Prefix}::/64`, network]);
let fixtureCreated = false;
let postgresCreated = false;
const janitorProbes = new Set<string>();
try {
  await docker(["create", "--platform", redisPlatform, "--network", network,
    "--ip6", fixtureIpv6, "--name", container, redisImage,
    "redis-server", "--bind", "0.0.0.0", "::", "--save", "", "--appendonly", "no"]);
  fixtureCreated = true;
  await docker(["start", container]);
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      ready = (await docker(["exec", container, "redis-cli", "ping"])).trim() === "PONG";
      if (ready) break;
    } catch { /* Only the disposable fixture may still be starting. */ }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error("Disposable Redis did not become ready");
  const [fixture] = JSON.parse(await docker(["inspect", container]));
  const endpoint = fixture.NetworkSettings.Networks[network];
  const ipv4 = endpoint?.IPAddress;
  const ipv6 = endpoint?.GlobalIPv6Address;
  if (isIP(ipv4 ?? "") !== 4 || isIP(ipv6 ?? "") !== 6 || !ipv6.startsWith("fd")) {
    throw new Error("Disposable Redis needs both a private IPv4 address and a non-loopback ULA IPv6 address");
  }
  const script = await Bun.file(new URL("./node-redis-probe.cjs", import.meta.url)).text();
  for (const [target, mode] of [[baseImage, "baseline"], [image, "overlay"]]) {
    const result = await docker([
      "run", "--rm", "-i", "--network", network,
      "--add-host", `ipv6.railway.internal=${ipv6}`,
      "--add-host", `ipv4.railway.internal=${ipv4}`,
      "--add-host", `unrelated.example.test=${ipv4}`,
      "-e", "NODE_ENV=test", "--entrypoint", "node", target!, "-", mode!,
    ], script);
    console.log(result.trim());
  }
  // A tmpfs database on this internal-only network is not a production service.
  // No host ports, persistent volumes, credentials or application schemas are used.
  await docker(["create", "--platform", redisPlatform, "--network", network,
    "--network-alias", "postgres.fixture", "--name", postgresContainer,
    "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_DB=janitor_fixture", postgresImage]);
  postgresCreated = true;
  await docker(["start", postgresContainer]);
  let postgresReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      // The official entrypoint's temporary init server is socket-only. Require
      // TCP so readiness cannot race its shutdown before the real server starts.
      postgresReady = (await docker(["exec", postgresContainer, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "janitor_fixture", "-Atc", "SELECT 1"])).trim() === "1";
      if (postgresReady) break;
    } catch { /* This new disposable database may still be starting. */ }
    await Bun.sleep(250);
  }
  if (!postgresReady) throw new Error("Disposable PostgreSQL did not become ready");
  const janitorScript = await Bun.file(new URL("./node-janitor-probe.cjs", import.meta.url)).text();
  for (const [target, mode] of [[baseImage, "baseline"], [image, "overlay"]]) {
    const probeContainer = `${container}-janitor-${mode}`;
    // Name before running so a timed-out Docker client cannot orphan its server-side container.
    janitorProbes.add(probeContainer);
    const result = await docker(["run", "--rm", "-i", "--name", probeContainer, "--network", network,
      "-e", "NODE_ENV=test", "-e", `JANITOR_PROBE_SOURCE=${janitorScript}`,
      "--entrypoint", "node", target!, "-", mode!], janitorScript, false, 45000);
    janitorProbes.delete(probeContainer);
    console.log(result.trim());
  }
} catch (error) {
  // The fixture is isolated, has no credentials and must survive until diagnostics
  // are collected; --rm would erase exec-format/startup failures before inspection.
  const state = await docker(["inspect", "--format", "{{json .State}}", container]).catch(() => "unavailable");
  const logs = await docker(["logs", "--tail", "60", container], undefined, true).catch(() => "unavailable");
  console.error(`Disposable Redis state: ${state.slice(0, 2000)}\nLogs: ${logs.slice(-12000)}`);
  if (postgresCreated) {
    const logs = await docker(["logs", "--tail", "40", postgresContainer], undefined, true).catch(() => "unavailable");
    console.error(`Disposable PostgreSQL logs: ${logs.slice(-8000)}`);
  }
  throw error;
} finally {
  try {
    for (const name of janitorProbes) await docker(["rm", "--force", name]).catch(() => {});
    try {
      if (postgresCreated) await docker(["rm", "--force", postgresContainer]);
    } finally {
      if (fixtureCreated) await docker(["rm", "--force", container]);
    }
  } finally {
    await docker(["network", "rm", network]);
  }
}
console.log("Exact official Node base and guarded overlay Redis/Janitor proofs passed; startup metadata inherited");
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
