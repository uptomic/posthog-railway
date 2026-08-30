import { expect, test } from "bun:test";
import { assertPressureReceipt, calibrateBufferPool, maximumOverlap, saturationRun, type PressureReceipt } from "./lib/clickhouse-pressure";

const green: PressureReceipt = { kind: "candidate", baselineActive: 480, peakPids: 890, pidLimitEvents: 0,
  oomKills: 0, correctQueries: 6, watchdogFailures: 0, saturatedSamples: 0, peakActive: 590,
  finalActive: 480, finalScheduled: 480, overlappingQueries: 6, saturatedSpanMs: 0,
  launchedQueries: 6, peakQueryThreads: 16 };
const red: PressureReceipt = { ...green, kind: "baseline", correctQueries: 0, watchdogFailures: 3,
  saturatedSamples: 12, saturatedSpanMs: 11000, peakActive: 512, finalActive: 480, finalScheduled: 480,
  overlappingQueries: 2, peakQueryThreads: 2 };

test("accepts only calibrated scheduler saturation as old-image RED", () => {
  expect(() => assertPressureReceipt(red)).not.toThrow();
  for (const change of [{ saturatedSamples: 0 }, { saturatedSpanMs: 1000 }, { peakActive: 511 }, { watchdogFailures: 0 },
    { baselineActive: 450 }, { launchedQueries: 5 }, { overlappingQueries: 1 }, { peakQueryThreads: 1 },
    { peakPids: 950 }, { pidLimitEvents: 1 }, { oomKills: 1 }]) {
    expect(() => assertPressureReceipt({ ...red, ...change })).toThrow();
  }
});

test("candidate requires correct concurrent UDF results, watchdog, recovery and PID headroom", () => {
  expect(() => assertPressureReceipt(green)).not.toThrow();
  for (const change of [{ correctQueries: 5 }, { watchdogFailures: 1 }, { finalActive: 510 },
    { finalScheduled: 510 }, { peakActive: 640 }, { peakPids: 950 }, { pidLimitEvents: 1 }, { oomKills: 1 },
    { overlappingQueries: 5 }, { launchedQueries: 5 }, { peakQueryThreads: 15 }]) {
    expect(() => assertPressureReceipt({ ...green, ...change })).toThrow();
  }
});

test("fixture-only buffer calibration targets production's observed occupancy and fails closed", () => {
  expect(calibrateBufferPool(16, 300)).toBe(196);
  expect(calibrateBufferPool(196, 480)).toBe(196);
  expect(() => calibrateBufferPool(16, 510)).toThrow();
  expect(() => calibrateBufferPool(16, Number.NaN)).toThrow();
});

test("saturation requires consecutive one-second samples, not unrelated spikes", () => {
  expect(saturationRun([{ second: 1, active: 512, scheduled: 520 }, { second: 2, active: 512, scheduled: 530 },
    { second: 3, active: 512, scheduled: 540 }])).toEqual({ samples: 3, spanMs: 2000 });
  expect(saturationRun([{ second: 1, active: 512, scheduled: 520 }, { second: 3, active: 512, scheduled: 530 },
    { second: 5, active: 512, scheduled: 540 }])).toEqual({ samples: 1, spanMs: 0 });
});

test("uses maximum actual interval overlap, including censored old queries", () => {
  expect(maximumOverlap([{ started: 1, finished: 5 }, { started: 2, finished: 4 }, { started: 8, finished: 9 }], 10)).toBe(2);
  expect(maximumOverlap([{ started: 1, finished: 0 }, { started: 2, finished: 0 }], 10)).toBe(2);
  expect(maximumOverlap([{ started: 1, finished: 2 }, { started: 2, finished: 3 }], 10)).toBe(1);
  expect(() => maximumOverlap([{ started: 5, finished: 4 }], 10)).toThrow();
});
