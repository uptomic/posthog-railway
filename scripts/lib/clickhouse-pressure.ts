import assert from "node:assert/strict";

export interface PressureReceipt {
  kind: "baseline" | "candidate";
  baselineActive: number;
  peakPids: number;
  pidLimitEvents: number;
  oomKills: number;
  correctQueries: number;
  watchdogFailures: number;
  saturatedSamples: number;
  saturatedSpanMs: number;
  peakActive: number;
  finalActive: number;
  finalScheduled: number;
  overlappingQueries: number;
  launchedQueries: number;
  peakProtocolQueryThreads: number;
  peakPipelineThreads: number;
}

export function calibrateBufferPool(current: number, active: number): number {
  assert.ok(Number.isInteger(active) && active > 0, "Invalid global occupancy");
  const next = current + 480 - active;
  assert.ok(Number.isInteger(next) && next >= 16 && next <= 400, "Unsafe fixture calibration");
  return next;
}

export interface SchedulerSample { atMs: number; active: number; scheduled: number; protocolQueryThreads: number; pipelineThreads: number }
const schedulerGaugeNames = ["GlobalThread", "GlobalThreadActive", "GlobalThreadScheduled", "Query", "QueryThread", "QueryPipelineExecutorThreadsActive"] as const;
export type SchedulerMetrics = Record<typeof schedulerGaugeNames[number], number>;

export function parseSchedulerMetrics(body: string): SchedulerMetrics {
  const metrics: Partial<SchedulerMetrics> = {};
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) continue;
    const name = schedulerGaugeNames.find(key => line.startsWith(`ClickHouseMetrics_${key} `)
      || line.startsWith(`ClickHouseMetrics_${key}{`));
    if (!name) continue;
    assert.equal(metrics[name], undefined, `Duplicate scheduler gauge ${name}`);
    const match = line.match(new RegExp(`^ClickHouseMetrics_${name} ([0-9]+)$`));
    assert.ok(match, `Invalid scheduler gauge ${name}`);
    const value = Number(match[1]);
    assert.ok(Number.isSafeInteger(value), `Invalid scheduler gauge ${name}`);
    metrics[name] = value;
  }
  assert.ok(schedulerGaugeNames.every(name => metrics[name] !== undefined), "Incomplete direct scheduler metrics");
  return metrics as SchedulerMetrics;
}

export async function sampleScheduler(read: () => Promise<SchedulerMetrics>, shouldStop: () => boolean, intervalMs = 500): Promise<SchedulerSample[]> {
  const samples: SchedulerSample[] = [];
  while (!shouldStop()) {
    const started = performance.now();
    const metrics = await read(); // Failed observations throw; never synthesize zeros or repeat stale values.
    samples.push({ atMs: performance.now(), active: metrics.GlobalThreadActive,
      scheduled: metrics.GlobalThreadScheduled, protocolQueryThreads: metrics.QueryThread,
      pipelineThreads: metrics.QueryPipelineExecutorThreadsActive });
    await Bun.sleep(Math.max(0, intervalMs - (performance.now() - started)));
  }
  return samples;
}

export function saturationRun(rows: Array<{ atMs: number; active: number; scheduled: number }>): { samples: number; spanMs: number } {
  let longest = { samples: 0, spanMs: 0 };
  let run = 0;
  let runStart = 0;
  let previous = -Infinity;
  for (const row of rows) {
    assert.ok(Number.isFinite(row.atMs) && row.atMs > previous, "Non-monotonic scheduler observation");
    const saturated = row.active === 512 && row.scheduled > 512;
    if (!saturated) run = 0;
    else if (run && row.atMs - previous <= 1500) run++;
    else { run = 1; runStart = row.atMs; }
    const spanMs = run ? row.atMs - runStart : 0;
    if (run > 0 && (spanMs > longest.spanMs || (spanMs === longest.spanMs && run > longest.samples))) longest = { samples: run, spanMs };
    previous = row.atMs;
  }
  return longest;
}

export function maximumOverlap(intervals: Array<{ started: number; finished: number }>, censoredAt: number): number {
  const bounded = intervals.map(interval => {
    const finished = interval.finished || censoredAt;
    assert.ok(Number.isFinite(interval.started) && Number.isFinite(finished) && finished >= interval.started,
      "Invalid persisted query interval");
    return { started: interval.started, finished };
  });
  return Math.max(0, ...bounded.map(point => bounded.filter(interval =>
    interval.started <= point.started && interval.finished > point.started).length));
}

export function assertEightStreamPipeline(plan: string): void {
  for (const processor of ["NumbersRange", "FilterTransform", "AggregatingTransform"]) {
    assert.match(plan, new RegExp(`\\b${processor}\\s*×\\s*8\\b`), `Expected eight ${processor} streams`);
  }
}

export function assertPressureReceipt(receipt: PressureReceipt): void {
  assert.ok(receipt.kind === "baseline" || receipt.kind === "candidate", "Unknown pressure image kind");
  for (const [key, value] of Object.entries(receipt)) {
    if (key !== "kind") assert.ok(Number.isFinite(value) && Number(value) >= 0, `Invalid ${key}`);
  }
  assert.ok(Math.abs(receipt.baselineActive - 480) <= 4, "Background occupancy not calibrated");
  assert.ok(receipt.peakPids < 950, "Insufficient cgroup PID headroom");
  assert.equal(receipt.pidLimitEvents, 0, "PID exhaustion invalidates scheduler proof");
  assert.equal(receipt.oomKills, 0, "OOM invalidates scheduler proof");
  assert.equal(receipt.launchedQueries, 6, "Six unique load IDs were not launched");
  if (receipt.kind === "baseline") {
    // Admission itself can stall before all six start. Require real concurrent
    // work, but do not require the defective scheduler to admit every query.
    assert.ok(receipt.overlappingQueries >= 2, "Old queries did not actually overlap");
    assert.ok(receipt.peakPipelineThreads > 1, "Old load never exercised parallel workers");
    assert.equal(receipt.peakActive, 512, "Old global pool did not saturate");
    assert.ok(receipt.saturatedSamples >= 3, "No sustained old-image queued saturation");
    assert.ok(receipt.saturatedSpanMs >= 2000, "Old-image saturation was only transient");
    assert.ok(receipt.watchdogFailures > 0, "No execution watchdog failure reproduced");
  } else {
    assert.equal(receipt.overlappingQueries, 6, "Six candidate queries did not overlap");
    assert.ok(receipt.peakPipelineThreads >= 16, "Candidate load did not exercise parallel streams");
    assert.equal(receipt.correctQueries, 6, "Concurrent UDF result mismatch or failure");
    assert.equal(receipt.watchdogFailures, 0, "Candidate execution watchdog failed");
    assert.ok(receipt.peakActive < 640, "Candidate exhausted global headroom");
    assert.ok(receipt.finalActive <= receipt.baselineActive + 8, "Workers did not recover");
    assert.ok(receipt.finalScheduled <= receipt.finalActive + 8, "Queued work did not recover");
  }
}
