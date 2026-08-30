import lock from "../posthog.lock.json";

const config = await Bun.file(new URL("../config/gateway.Caddyfile", import.meta.url)).text();
const services = [
  ["capture", "CAPTURE_INTERNAL_URL", 4101],
  ["replay", "CAPTURE_REPLAY_INTERNAL_URL", 4102],
  ["flags", "FEATURE_FLAGS_INTERNAL_URL", 4103],
  ["live", "LIVESTREAM_INTERNAL_URL", 4104],
  ["web", "WEB_INTERNAL_URL", 4105],
] as const;

async function runGatewaySmoke(webAvailable: boolean): Promise<number> {
  const mockConfig = services
    .filter(([name]) => webAvailable || name !== "web")
    .map(([name, , port]) =>
      `:${port} {\n respond "${name}|{http.request.uri}|{http.request.header.X-Forwarded-Proto}" 200\n}`,
    ).join("\n");
  const container = `posthog-gateway-routing-smoke-${Date.now()}`;
  const run = Bun.spawnSync([
    "docker", "run", "--rm", "-d", "--name", container,
    "-p", "127.0.0.1::3000",
    "-e", `CADDY_CONFIG=${config}\n${mockConfig}\n`,
    ...services.flatMap(([, env, port]) => ["-e", `${env}=http://127.0.0.1:${port}`]),
    lock.supportingImages.gateway,
    "sh", "-c", 'printf "%s" "$CADDY_CONFIG" | caddy run --config - --adapter caddyfile',
  ], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`Gateway smoke start failed: ${run.stderr.toString()}`);
  }
  try {
    const portResult = Bun.spawnSync(["docker", "port", container, "3000/tcp"], {
      stdout: "pipe", stderr: "pipe",
    });
    if (portResult.exitCode !== 0) throw new Error("Gateway smoke port lookup failed");
    const address = portResult.stdout.toString().trim().split("\n")[0];
    const origin = `http://${address}`;
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
        ready = response.status === 200 && await response.text() === "";
        if (ready) break;
      } catch {
        // The disposable server may still be binding its port.
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error("Gateway /health did not return its own empty HTTP 200 response");
    if (!webAvailable) {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2000) });
      if (response.status !== 502) {
        throw new Error(`Expected unavailable Web upstream to return 502, got ${response.status}`);
      }
      await response.text();
      return 0;
    }
    const routes = [
      ["/s", "replay", "/s"], ["/s/", "replay", "/s/"], ["/s/example", "replay", "/s/example"],
      ["/e", "capture", "/e"], ["/e/", "capture", "/e/"], ["/i/v0", "capture", "/i/v0"],
      ["/i/v1/analytics/events", "capture", "/i/v1/analytics/events"],
      ["/batch", "capture", "/batch"], ["/capture", "capture", "/capture"],
      ["/track", "capture", "/track"], ["/engage", "capture", "/engage"],
      ["/flags", "flags", "/flags"],
      ["/api/feature_flag/local_evaluation", "flags", "/api/feature_flag/local_evaluation"],
      ["/livestream/events", "live", "/events"],
      ["/", "web", "/"], ["/api/projects", "web", "/api/projects"],
    ];
    for (const [path, service, upstreamPath] of routes) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST", body: "synthetic-routing-probe", signal: AbortSignal.timeout(2000),
      });
      const body = await response.text();
      const expected = `${service}|${upstreamPath}|https`;
      if (response.status !== 200 || body !== expected) {
        throw new Error(`Gateway route ${path}: status=${response.status}, body=${body}, expected=${expected}`);
      }
    }
    return routes.length;
  } finally {
    const cleanup = Bun.spawnSync(["docker", "rm", "--force", container], {
      stdout: "pipe", stderr: "pipe",
    });
    if (cleanup.exitCode !== 0) {
      throw new Error(`Gateway smoke cleanup failed: ${cleanup.stderr.toString()}`);
    }
  }
}

await runGatewaySmoke(false);
const routeChecks = await runGatewaySmoke(true);
console.log(JSON.stringify({
  gatewayHealth: "passed",
  healthIndependentOfWeb: true,
  routeChecks,
  forwardedProto: "https",
  livestreamPrefixStripped: true,
}));
