import { expect, test } from "bun:test";
import { assertEightStreamPipeline, assertPressureReceipt, calibrateBufferPool, maximumOverlap, parseSchedulerMetrics, sampleScheduler, saturationRun, type PressureReceipt } from "./lib/clickhouse-pressure";

const green: PressureReceipt = { kind: "candidate", baselineActive: 480, peakPids: 890, pidLimitEvents: 0,
  oomKills: 0, correctQueries: 6, watchdogFailures: 0, saturatedSamples: 0, peakActive: 590,
  finalActive: 480, finalScheduled: 480, overlappingQueries: 6, saturatedSpanMs: 0,
  launchedQueries: 6, peakProtocolQueryThreads: 6, peakPipelineThreads: 16 };
const red: PressureReceipt = { ...green, kind: "baseline", correctQueries: 0, watchdogFailures: 3,
  saturatedSamples: 12, saturatedSpanMs: 11000, peakActive: 512, finalActive: 480, finalScheduled: 480,
  overlappingQueries: 2, peakProtocolQueryThreads: 17, peakPipelineThreads: 2 };

test("accepts only calibrated scheduler saturation as old-image RED", () => {
  expect(() => assertPressureReceipt(red)).not.toThrow();
  for (const change of [{ saturatedSamples: 0 }, { saturatedSpanMs: 1000 }, { peakActive: 511 }, { watchdogFailures: 0 },
    { baselineActive: 450 }, { launchedQueries: 5 }, { overlappingQueries: 1 }, { peakPipelineThreads: 1 },
    { peakPids: 950 }, { pidLimitEvents: 1 }, { oomKills: 1 }]) {
    expect(() => assertPressureReceipt({ ...red, ...change })).toThrow();
  }
});

test("candidate requires correct concurrent UDF results, watchdog, recovery and PID headroom", () => {
  expect(() => assertPressureReceipt(green)).not.toThrow();
  for (const change of [{ correctQueries: 5 }, { watchdogFailures: 1 }, { finalActive: 510 },
    { finalScheduled: 510 }, { peakActive: 640 }, { peakPids: 950 }, { pidLimitEvents: 1 }, { oomKills: 1 },
    { overlappingQueries: 5 }, { launchedQueries: 5 }, { peakPipelineThreads: 15 }]) {
    expect(() => assertPressureReceipt({ ...green, ...change })).toThrow();
  }
});

test("protocol handlers never stand in for actual parallel pipeline workers", () => {
  expect(() => assertPressureReceipt({ ...green, peakProtocolQueryThreads: 6, peakPipelineThreads: 48 })).not.toThrow();
  expect(() => assertPressureReceipt({ ...green, peakProtocolQueryThreads: 48, peakPipelineThreads: 6 })).toThrow("parallel streams");
  expect(() => assertPressureReceipt({ ...red, peakProtocolQueryThreads: 17, peakPipelineThreads: 1 })).toThrow("parallel workers");
});

test("the exact workload must plan eight number, filter and aggregation streams", () => {
  const plan = "ExpressionTransform × 8\nAggregatingTransform × 8\nFilterTransform × 8\nNumbersRange × 8 0 → 1";
  expect(() => assertEightStreamPipeline(plan)).not.toThrow();
  expect(() => assertEightStreamPipeline(plan.replace("NumbersRange × 8", "NumbersRange × 1"))).toThrow();
  expect(() => assertEightStreamPipeline("NumbersRange × 8 0 → 1")).toThrow();
});

test("fixture-only buffer calibration targets production's observed occupancy and fails closed", () => {
  expect(calibrateBufferPool(16, 300)).toBe(196);
  expect(calibrateBufferPool(196, 480)).toBe(196);
  expect(() => calibrateBufferPool(16, 510)).toThrow();
  expect(() => calibrateBufferPool(16, Number.NaN)).toThrow();
});

test("saturation uses actual sample times without interpolating missing observations", () => {
  expect(saturationRun([{ atMs: 1000, active: 512, scheduled: 520 }, { atMs: 2010, active: 512, scheduled: 530 },
    { atMs: 3020, active: 512, scheduled: 540 }])).toEqual({ samples: 3, spanMs: 2020 });
  expect(saturationRun([{ atMs: 1000, active: 512, scheduled: 520 }, { atMs: 3000, active: 512, scheduled: 530 },
    { atMs: 5000, active: 512, scheduled: 540 }])).toEqual({ samples: 1, spanMs: 0 });
  expect(() => saturationRun([{ atMs: 1000, active: 512, scheduled: 520 },
    { atMs: 1000, active: 512, scheduled: 530 }])).toThrow();
  expect(saturationRun([0, 1000, 2000, 5000, 5100, 5200, 5300].map(atMs =>
    ({ atMs, active: 512, scheduled: 550 })))).toEqual({ samples: 3, spanMs: 2000 });
});

const exposition = ["# TYPE ClickHouseMetrics_GlobalThread gauge", "ClickHouseMetrics_GlobalThread 512",
  "ClickHouseMetrics_GlobalThreadActive 512", "ClickHouseMetrics_GlobalThreadScheduled 600",
  "ClickHouseMetrics_Query 6", "ClickHouseMetrics_QueryThread 6",
  "ClickHouseMetrics_QueryPipelineExecutorThreadsActive 48"].join("\n");

test("reads complete direct atomic scheduler gauges and never substitutes missing scrapes with zero", () => {
  expect(parseSchedulerMetrics(exposition)).toEqual({ GlobalThread: 512, GlobalThreadActive: 512,
    GlobalThreadScheduled: 600, Query: 6, QueryThread: 6, QueryPipelineExecutorThreadsActive: 48 });
  for (const invalid of ["", "<html>unavailable</html>", exposition.replace("ClickHouseMetrics_QueryPipelineExecutorThreadsActive 48", ""),
    `${exposition}\nClickHouseMetrics_GlobalThread 512`, exposition.replace("QueryThread 6", "QueryThread NaN"),
    exposition.replace("QueryThread 6", "QueryThread -1"), exposition.replace("QueryThread 6", 'QueryThread{host="unexpected"} 6')]) {
    expect(() => parseSchedulerMetrics(invalid)).toThrow();
  }
});

test("direct metrics are fixture-only and sampled independently of blocked SQL watchdogs", async () => {
  const smoke = await Bun.file(new URL("./clickhouse-pressure.ts", import.meta.url)).text();
  expect(smoke).toContain("--prometheus.port=9363");
  expect(smoke).toContain("--prometheus.asynchronous_metrics=false");
  expect(smoke).toContain("await sampler");
  expect(smoke).not.toContain("FROM system.metric_log");
  expect(smoke).not.toContain('"--publish"');
  const xml = await Bun.file(new URL("../images/clickhouse.railway.xml", import.meta.url)).text();
  expect(xml).not.toContain("prometheus");
});

test("sampler keeps observing real local HTTP while another operation is blocked", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(exposition) });
  let stop = false;
  let count = 0;
  let observed!: () => void;
  const threeSamples = new Promise<void>(resolve => { observed = resolve; });
  let unblock!: () => void;
  let blockedDone = false;
  const blockedOperation = new Promise<void>(resolve => { unblock = resolve; }).then(() => { blockedDone = true; });
  const sampler = sampleScheduler(async () => {
    const data = parseSchedulerMetrics(await (await fetch(server.url)).text());
    if (++count === 3) observed();
    return data;
  }, () => stop, 5);
  const timeout = setTimeout(observed, 1000);
  try {
    await threeSamples;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(blockedDone).toBe(false);
    stop = true;
    const samples = await sampler;
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(samples.every(sample => sample.active === 512 && sample.protocolQueryThreads === 6 && sample.pipelineThreads === 48)).toBe(true);
  } finally {
    clearTimeout(timeout);
    stop = true;
    unblock();
    await blockedOperation;
    await sampler.catch(() => undefined);
    server.stop(true);
  }
});

test("sampler fails on a lost scrape rather than reusing its last successful gauges", async () => {
  let reads = 0;
  await expect(sampleScheduler(async () => {
    if (++reads === 2) throw new Error("fixture scrape unavailable");
    return parseSchedulerMetrics(exposition);
  }, () => false, 1)).rejects.toThrow("fixture scrape unavailable");
  expect(reads).toBe(2);
});

test("uses maximum actual interval overlap, including censored old queries", () => {
  expect(maximumOverlap([{ started: 1, finished: 5 }, { started: 2, finished: 4 }, { started: 8, finished: 9 }], 10)).toBe(2);
  expect(maximumOverlap([{ started: 1, finished: 0 }, { started: 2, finished: 0 }], 10)).toBe(2);
  expect(maximumOverlap([{ started: 1, finished: 2 }, { started: 2, finished: 3 }], 10)).toBe(1);
  expect(() => maximumOverlap([{ started: 5, finished: 4 }], 10)).toThrow();
});
