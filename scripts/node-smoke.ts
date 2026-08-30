const [image, baseImage, baseRevision, fingerprintSha256] = Bun.argv.slice(2);
if (!image || !baseImage || !baseRevision || !fingerprintSha256) {
  throw new Error("Usage: node-smoke.ts IMAGE BASE_IMAGE BASE_REVISION OVERLAY_SHA256");
}
// Multi-platform Redis 7.4.11-alpine index, not the local ARM64 child manifest.
const redisImage = "docker.io/library/redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf";
const container = `posthog-node-redis-proof-${Date.now()}`;

async function docker(args: string[], input?: string, includeStderr = false): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(`Disposable Node proof failed (${args[0]}): ${stdout}\n${stderr}`);
  return includeStderr ? `${stdout}\n${stderr}` : stdout;
}

await docker(["pull", baseImage]);
await docker(["pull", image]);
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
await docker(["create", "--platform", redisPlatform, "--name", container,
  "--add-host", "ipv6.railway.internal=::1",
  "--add-host", "ipv4.railway.internal=127.0.0.1",
  "--add-host", "unrelated.example.test=127.0.0.1", redisImage,
  "redis-server", "--bind", "0.0.0.0", "::", "--save", "", "--appendonly", "no"]);
try {
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
  const script = await Bun.file(new URL("./node-redis-probe.cjs", import.meta.url)).text();
  for (const [target, mode] of [[baseImage, "baseline"], [image, "overlay"]]) {
    const result = await docker([
      "run", "--rm", "-i", "--network", `container:${container}`,
      "-e", "NODE_ENV=test", "--entrypoint", "node", target!, "-", mode!,
    ], script);
    console.log(result.trim());
  }
} catch (error) {
  // The fixture is isolated, has no credentials and must survive until diagnostics
  // are collected; --rm would erase exec-format/startup failures before inspection.
  const state = await docker(["inspect", "--format", "{{json .State}}", container]).catch(() => "unavailable");
  const logs = await docker(["logs", "--tail", "60", container], undefined, true).catch(() => "unavailable");
  console.error(`Disposable Redis state: ${state.slice(0, 2000)}\nLogs: ${logs.slice(-12000)}`);
  throw error;
} finally {
  await docker(["rm", "--force", container]);
}
console.log("Exact official Node base and guarded overlay Redis proof passed; startup metadata inherited");
