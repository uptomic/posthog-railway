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
  peakQueryThreads: number;
}

export function calibrateBufferPool(current: number, active: number): number {
  assert.ok(Number.isInteger(active) && active > 0, "Invalid global occupancy");
  const next = current + 480 - active;
  assert.ok(Number.isInteger(next) && next >= 16 && next <= 400, "Unsafe fixture calibration");
  return next;
}

export function saturationRun(rows: Array<{ second: number; active: number; scheduled: number }>): { samples: number; spanMs: number } {
  let longest = 0;
  let run = 0;
  let previous = -Infinity;
  for (const row of rows) {
    const saturated = row.active === 512 && row.scheduled > 512;
    run = saturated ? (row.second === previous + 1 ? run + 1 : 1) : 0;
    longest = Math.max(longest, run);
    previous = row.second;
  }
  return { samples: longest, spanMs: Math.max(0, longest - 1) * 1000 };
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
    assert.ok(receipt.peakQueryThreads > 1, "Old load never exercised parallel workers");
    assert.equal(receipt.peakActive, 512, "Old global pool did not saturate");
    assert.ok(receipt.saturatedSamples >= 3, "No sustained old-image queued saturation");
    assert.ok(receipt.saturatedSpanMs >= 2000, "Old-image saturation was only transient");
    assert.ok(receipt.watchdogFailures > 0, "No execution watchdog failure reproduced");
  } else {
    assert.equal(receipt.overlappingQueries, 6, "Six candidate queries did not overlap");
    assert.ok(receipt.peakQueryThreads >= 16, "Candidate load did not exercise parallel streams");
    assert.equal(receipt.correctQueries, 6, "Concurrent UDF result mismatch or failure");
    assert.equal(receipt.watchdogFailures, 0, "Candidate execution watchdog failed");
    assert.ok(receipt.peakActive < 640, "Candidate exhausted global headroom");
    assert.ok(receipt.finalActive <= receipt.baselineActive + 8, "Workers did not recover");
    assert.ok(receipt.finalScheduled <= receipt.finalActive + 8, "Queued work did not recover");
  }
}
