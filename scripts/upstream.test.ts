import { describe, expect, test } from "bun:test";
import { officialComponents } from "./lib/upstream";

describe("PostHog release bundle ownership", () => {
  test("tracks every externally published PostHog application component used by Railway", () => {
    expect(Object.keys(officialComponents).sort()).toEqual([
      "capture",
      "cyclotron-janitor",
      "feature-flags",
      "livestream",
      "property-defs-rs",
    ]);
  });

  test("does not accept mutable production image references in the rendered plan", async () => {
    const planSource = await Bun.file(new URL("./render-railway-plan.ts", import.meta.url)).text();
    expect(planSource).not.toMatch(/:(latest|master)["'`]/);
  });
});
