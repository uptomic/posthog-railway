import assert from "node:assert/strict";
import { isIP } from "node:net";
import { assertEightStreamPipeline, assertPressureReceipt, calibrateBufferPool, maximumOverlap, parseSchedulerMetrics, sampleScheduler,
  saturationRun, type PressureReceipt, type SchedulerMetrics, type SchedulerSample } from "./lib/clickhouse-pressure";

const candidate = Bun.argv[2];
assert.match(candidate ?? "", /^ghcr\.io\/uptomic\/posthog-railway\/clickhouse@sha256:[a-f0-9]{64}$/);
const baseline = "ghcr.io/uptomic/posthog-railway/clickhouse@sha256:d240f6f0283447b4725aae6e2cc38bd05cbe574d9338666fc44fbf372763e50d";
const prefix = `posthog-pressure-${Date.now()}-${process.pid}`;
let container: string | undefined;
let volume: string | undefined;
let containerCreated = false;
let volumeCreated = false;
let stage = "starting";
let cleaning: Promise<void> | undefined;
let metricsEndpoint: string | undefined;

async function docker(args: string[], timeoutMs = 10_000): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut || exit !== 0) throw new Error(`${stage}: docker ${args[0]} ${timedOut ? "deadline" : `exit ${exit}`}: ${stderr.slice(-2000)}`);
    return (args[0] === "logs" ? `${stdout}\n${stderr}` : stdout).trim();
  } finally { clearTimeout(timer); }
}

function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try {
      if (containerCreated && container) await docker(["rm", "--force", container], 15_000);
      containerCreated = false;
      container = undefined;
    } finally {
      if (volumeCreated && volume) await docker(["volume", "rm", volume], 15_000);
      volumeCreated = false;
      volume = undefined;
    }
  })();
}
async function abort(): Promise<never> {
  console.error(`ClickHouse pressure hard deadline/signal at ${stage}`);
  try { await cleanup(); } finally { process.exit(1); }
}
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
const deadline = setTimeout(abort, 480_000);

function query(sql: string, timeout = 5000, queryId?: string): Promise<string> {
  assert.ok(container);
  return docker(["exec", container, "clickhouse-client", "--user", "clickhouse", "--password", "test-only",
    "--receive_timeout", String(Math.ceil(timeout / 1000)), ...(queryId ? ["--query_id", queryId] : []), "--query", sql], timeout + 1000);
}
async function metrics(): Promise<SchedulerMetrics> {
  assert.ok(metricsEndpoint, "Disposable container metrics address missing");
  const response = await fetch(metricsEndpoint, { signal: AbortSignal.timeout(1000), redirect: "error" });
  assert.ok(response.ok, `Direct scheduler metrics HTTP ${response.status}`);
  return parseSchedulerMetrics(await response.text());
}
async function locateMetricsEndpoint(): Promise<void> {
  assert.ok(containerCreated && container);
  const address = await docker(["inspect", "--format", "{{.NetworkSettings.IPAddress}}", container]);
  assert.equal(isIP(address), 4, "Expected this disposable container's bridge IPv4");
  assert.ok(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address), "Fixture address is not private");
  metricsEndpoint = `http://${address}:9363/metrics`;
  await metrics();
}
async function cgroup(): Promise<{ current: number; peak: number; pidEvents: number; oom: number }> {
  assert.ok(container);
  const values = (await docker(["exec", container, "sh", "-c",
    "cat /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.peak; cat /sys/fs/cgroup/pids.events /sys/fs/cgroup/memory.events"])).split("\n");
  const result = { current: Number(values[0]), peak: Number(values[1]),
    pidEvents: Number(values.find(line => line.startsWith("max "))?.split(" ")[1]),
    oom: Number(values.find(line => line.startsWith("oom_kill "))?.split(" ")[1]) };
  assert.ok(Object.values(result).every(Number.isFinite), "Missing unified cgroup PID/memory evidence");
  return result;
}
async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { if (await query("SELECT 1", 1000) === "1") return; } catch { /* Bounded fixture startup. */ }
    await Bun.sleep(300);
  }
  throw new Error(`${stage}: server not ready`);
}
async function create(image: string, bufferThreads: number): Promise<void> {
  assert.ok(container && volume);
  // These overrides exist only on this disposable command line, never in an
  // image. Soft-limit 48 reproduces production on GitHub's smaller CPU runner.
  await docker(["create", "--name", container, "--pids-limit", "1000",
    "--mount", `type=volume,source=${volume},target=/var/lib/clickhouse,volume-nocopy`,
    "-e", "RAILWAY_PRIVATE_DOMAIN=clickhouse.railway.internal",
    "-e", "CLICKHOUSE_USER=clickhouse", "-e", "CLICKHOUSE_PASSWORD=test-only", "-e", "KAFKA_HOSTS=localhost:9092",
    image, "clickhouse", "su", "clickhouse", "clickhouse-server", "--config-file=/etc/clickhouse-server/config.xml", "--",
    `--background_buffer_flush_schedule_pool_size=${bufferThreads}`,
    "--concurrent_threads_soft_limit_num=48", "--concurrent_threads_soft_limit_ratio_to_cores=0",
    // Dedicated native HTTP handler reads CurrentMetrics atomics without SQL or
    // GlobalThreadPool work. Only this fixture enables it; no host port is published.
    "--prometheus.port=9363", "--prometheus.endpoint=/metrics", "--prometheus.metrics=true",
    "--prometheus.events=false", "--prometheus.asynchronous_metrics=false", "--prometheus.errors=false",
    "--prometheus.info=false", "--prometheus.histograms=false", "--prometheus.dimensional_metrics=false"]);
  containerCreated = true;
  await docker(["start", container]);
  await ready();
  await locateMetricsEndpoint();
}
const constantSql = await Bun.file(new URL("./clickhouse-funnel-proof.sql", import.meta.url)).text();
const loadSql = await Bun.file(new URL("./clickhouse-pressure.sql", import.meta.url)).text();

async function run(image: string, kind: PressureReceipt["kind"]): Promise<void> {
  stage = `${kind}:pull`;
  await docker(["pull", image], 120_000);
  container = `${prefix}-${kind}`;
  volume = `${container}-data`;
  cleaning = undefined;
  await docker(["volume", "create", volume]);
  volumeCreated = true;
  await docker(["run", "--rm", "--entrypoint", "sh", "--mount",
    `type=volume,source=${volume},target=/var/lib/clickhouse,volume-nocopy`, image,
    "-c", "chown clickhouse:clickhouse /var/lib/clickhouse"]);
  stage = `${kind}:calibration`;
  let bufferThreads = 16;
  let active = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await create(image, bufferThreads);
    assert.equal(await query(constantSql), "1", "UDF fixture invalid before pressure");
    await Bun.sleep(1500);
    active = (await metrics()).GlobalThreadActive;
    if (Math.abs(active - 480) <= 4) break;
    bufferThreads = calibrateBufferPool(bufferThreads, active);
    await docker(["rm", "--force", container]);
    containerCreated = false;
  }
  assert.ok(Math.abs(active - 480) <= 4, `Calibration failed: ${active}`);
  const settings = JSON.parse(await query("SELECT name,value FROM system.server_settings WHERE name IN ('max_thread_pool_size','thread_pool_queue_size','background_schedule_pool_size','background_message_broker_schedule_pool_size') FORMAT JSON"));
  const actual = Object.fromEntries(settings.data.map((row: { name: string; value: string }) => [row.name, Number(row.value)]));
  assert.equal(actual.max_thread_pool_size, kind === "baseline" ? 512 : 640);
  assert.equal(actual.thread_pool_queue_size, kind === "baseline" ? 10000 : 640);
  assert.equal(actual.background_schedule_pool_size, 128);
  assert.equal(actual.background_message_broker_schedule_pool_size, 128);
  if (kind === "candidate") assert.equal(await query("SELECT value FROM system.settings WHERE name='max_threads'"), "8");
  stage = `${kind}:eight-stream-pipeline`;
  // Plan only: no UDF execution. This guards runner-specific source/memory
  // clamps independently of the actual worker gauge observed during load.
  const pipeline = await query(`EXPLAIN PIPELINE ${loadSql.replace(/FORMAT TabSeparated\s*$/, "")}`);
  assertEightStreamPipeline(pipeline);
  console.log(JSON.stringify({ stage, sourceStreams: 8, filterStreams: 8, aggregationStreams: 8 }));

  // Empty test databases lack production's native Kafka threads. Reserve the
  // observed 243 non-global tasks without CPU work, network or test-image edits.
  const initial = await cgroup();
  const totalGlobal = (await metrics()).GlobalThread;
  // Account for ALL allocated global workers, including idle ones. Four extra
  // tasks conservatively cover the transient shell/cat used for observation.
  const reserve = Math.max(0, 247 - (initial.current - totalGlobal));
  assert.ok(reserve <= 247);
  await docker(["exec", "--detach", container, "sh", "-c", `i=0; while [ "$i" -lt ${reserve} ]; do sleep 300 & i=$((i+1)); done; wait`]);
  await Bun.sleep(300);
  const reserved = await cgroup();
  assert.ok(reserved.current - totalGlobal >= 247, "Native-thread PID reservation was not established");
  stage = `${kind}:six-concurrent-funnels`;
  console.log(JSON.stringify({ stage, active, totalGlobal, bufferThreads, reserve,
    observedExternalTasks: reserved.current - totalGlobal, settings: actual }));
  let done = 0;
  let correct = 0;
  const failures: string[] = [];
  const queryIds = Array.from({ length: 6 }, (_, index) => `${prefix}-${kind}-query-${index}`);
  let stopSampling = false;
  let sampleError: unknown;
  const sampler = sampleScheduler(metrics, () => stopSampling).catch(error => { sampleError = error; return []; });
  const loads = queryIds.map((queryId, index) => query(loadSql, 35_000, queryId).then(result => {
    if (result === "8192") correct++; else failures.push(`query-${index}:wrong-count`);
  }).catch(error => { failures.push(`query-${index}:${error.message}`); }).finally(() => { done++; }));
  let watchdogFailures = 0;
  let peakPids = 0;
  let pidEvents = 0;
  let oom = 0;
  const launched = Date.now();
  let history: SchedulerSample[];
  try {
    // Sampling runs independently: a blocked serial SQL watchdog must not
    // prevent observation of the scheduler that is blocking it.
    while (done < 6 || Date.now() - launched < 20_000) {
      if (sampleError) throw sampleError;
      const cg = await cgroup();
      peakPids = Math.max(peakPids, cg.peak);
      pidEvents = Math.max(pidEvents, cg.pidEvents);
      oom = Math.max(oom, cg.oom);
      try { assert.equal(await query("SELECT 1", 2000), "1"); } catch { watchdogFailures++; }
      await Bun.sleep(250);
    }
    await Promise.all(loads);
  } finally {
    stopSampling = true;
    history = await sampler;
  }
  if (sampleError) throw sampleError;
  const cg = await cgroup();
  peakPids = Math.max(peakPids, cg.peak);
  pidEvents = Math.max(pidEvents, cg.pidEvents);
  oom = Math.max(oom, cg.oom);
  const pressureEnd = Date.now();
  stage = `${kind}:bounded-recovery`;
  if (kind === "baseline") {
    // Clear ONLY the disposable old server's stalled state to retrieve its
    // persisted query-start records. Direct metric samples survive outside it.
    await docker(["stop", "--time", "1", container]);
    assert.equal(await docker(["inspect", "--format", "{{.State.OOMKilled}}", container]), "false");
    await docker(["start", container]);
    await ready();
    await locateMetricsEndpoint();
  }
  let recovered = await metrics();
  for (let attempt = 0; attempt < 20 && (recovered.GlobalThreadActive > active + 8 || recovered.GlobalThreadScheduled > recovered.GlobalThreadActive + 8); attempt++) {
    await Bun.sleep(500);
    recovered = await metrics();
  }
  await query("SYSTEM FLUSH LOGS", 10_000);
  assert.ok(history.length > 0, "No direct scheduler observations captured");
  const saturation = saturationRun(history);
  const peakProtocolQueryThreads = Math.max(...history.map(row => row.protocolQueryThreads));
  const peakPipelineThreads = Math.max(...history.map(row => row.pipelineThreads));
  const intervals = JSON.parse(await query(`SELECT query_id,
    min(toUnixTimestamp64Milli(query_start_time_microseconds)) AS started,
    maxIf(toUnixTimestamp64Milli(event_time_microseconds),type!='QueryStart') AS finished,
    countIf(type='QueryStart') AS starts
    FROM system.query_log WHERE query_id IN (${queryIds.map(id => `'${id}'`).join(",")})
    GROUP BY query_id FORMAT JSON`)).data as Array<{ started: string; finished: string; starts: string }>;
  const startedIntervals = intervals.filter(interval => Number(interval.starts) >= 1);
  // Failed old queries may have no finish record before the fixture stop. Their
  // intervals are explicitly censored at the measured pressure end, not called
  // successfully completed. Baseline admission can stall before all six start;
  // candidate acceptance requires all six real overlapping QueryStart records.
  const overlappingQueries = maximumOverlap(startedIntervals.map(interval =>
    ({ started: Number(interval.started), finished: Number(interval.finished) })), pressureEnd);
  const receipt: PressureReceipt = { kind, baselineActive: active, peakPids, pidLimitEvents: pidEvents, oomKills: oom,
    correctQueries: correct, watchdogFailures, saturatedSamples: saturation.samples, saturatedSpanMs: saturation.spanMs,
    peakActive: Math.max(...history.map(row => row.active)), overlappingQueries,
    launchedQueries: new Set(queryIds).size, peakProtocolQueryThreads, peakPipelineThreads,
    finalActive: recovered.GlobalThreadActive, finalScheduled: recovered.GlobalThreadScheduled };
  console.log(JSON.stringify({ receipt, metricObservation: "direct-prometheus-atomic-gauges",
    metricSamples: history.length, sampleSpanMs: history.at(-1)!.atMs - history[0].atMs,
    persistedQueryStarts: startedIntervals.length,
    censoredQueryIntervals: startedIntervals.filter(interval => !Number(interval.finished)).length, failures }));
  assertPressureReceipt(receipt);
  assert.equal(await query("SELECT 1"), "1");
  await cleanup();
}

try {
  await run(baseline, "baseline");
  await run(candidate, "candidate");
  console.log("Exact-image old scheduler saturation RED and bounded candidate UDF pressure GREEN passed");
} catch (error) {
  const state = container ? await docker(["inspect", "--format", "{{json .State}}", container]).catch(() => "unavailable") : "removed";
  const logs = container ? await docker(["logs", "--tail", "35", container]).catch(() => "unavailable") : "removed";
  console.error(JSON.stringify({ stage, state, logs: logs.slice(-6000), message: error instanceof Error ? error.message : String(error) }));
  throw error;
} finally {
  clearTimeout(deadline);
  await cleanup();
}
