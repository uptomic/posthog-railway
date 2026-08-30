import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { attachJanitorPoolErrorHandler } from "../images/node/janitor-pool-errors.cjs";
import { patchJanitorSource } from "../images/node/apply-overlay.cjs";

describe("Janitor idle PostgreSQL connection errors", () => {
  test("handles only the pool error event and records safe context without retaining the dead client", () => {
    const pool = new EventEmitter();
    const logs: unknown[][] = [];
    const logger = { error: (...args: unknown[]) => logs.push(args) };
    const processListeners = process.listenerCount("uncaughtException");
    attachJanitorPoolErrorHandler(pool, logger);
    const error = Object.assign(new Error("synthetic private connection details"), {
      code: "57P01", client: { connectionParameters: { password: "synthetic-not-a-credential" } },
    });
    expect(() => pool.emit("error", error, error.client)).not.toThrow();
    expect(logs).toEqual([["CyclotronV2Janitor idle PostgreSQL client disconnected", { code: "57P01" }]]);
    expect(pool.eventNames()).toEqual(["error"]);
    expect(process.listenerCount("uncaughtException")).toBe(processListeners);
  });

  test("never logs arbitrary emitted error values", () => {
    const pool = new EventEmitter();
    const logs: unknown[][] = [];
    attachJanitorPoolErrorHandler(pool, { error: (...args: unknown[]) => logs.push(args) });
    for (const error of [new Error("private context"), null, { code: "private://data" }]) {
      pool.emit("error", error);
    }
    expect(logs.every((args) => JSON.stringify(args) === JSON.stringify([
      "CyclotronV2Janitor idle PostgreSQL client disconnected", { code: "UNKNOWN" },
    ]))).toBe(true);
  });
});

describe("guarded Janitor pool wiring", () => {
  const constructor = `    constructor(config) {
        this.pool = new pg_1.Pool({
            connectionString: config.pool.dbUrl,
            max: config.pool.maxConnections ?? 5,
            idleTimeoutMillis: config.pool.idleTimeoutMs ?? 30000,
        });
        this.cleanupBatchSize = config.cleanupBatchSize ?? 10000;
    }`;
  const source = `const pg_1 = require("pg");\nconst logger_1 = require("../../../common/utils/logger");\nclass CyclotronV2Janitor {\n${constructor}\n    async runOnce() { return this.pool.query("SELECT 1"); }\n}`;
  const hash = createHash("sha256").update(constructor).digest("hex");

  test("adds only the error listener immediately after the exact owned Pool construction", () => {
    const patched = patchJanitorSource(source, hash);
    const injection = '\n        require("/opt/uptomic-node-overlay/janitor-pool-errors.cjs").attachJanitorPoolErrorHandler(this.pool, logger_1.logger);';
    expect(patched.replace(injection, "")).toBe(source);
    expect(patched).toContain(`        });${injection}\n        this.cleanupBatchSize`);
  });

  test("rejects changed constructor, imports, duplicate/missing constructors and repeat application", () => {
    for (const drift of [source.replace("30000", "30001"), source.replace('require("pg")', 'require("other")'),
      source.replace('require("../../../common/utils/logger")', 'require("other")'),
      source.replace(constructor, `${constructor}\n${constructor}`), source.replace(constructor, ""),
      patchJanitorSource(source, hash)]) {
      expect(() => patchJanitorSource(drift, hash)).toThrow("NODE_JANITOR_CONSTRUCTOR_DRIFT");
    }
  });

  test("exact-image smoke covers real Janitor idle recovery and active query rejection without global interception", async () => {
    const smoke = await Bun.file(new URL("./node-smoke.ts", import.meta.url)).text();
    const probe = await Bun.file(new URL("./node-janitor-probe.cjs", import.meta.url)).text();
    expect(smoke).toContain('"./node-janitor-probe.cjs"');
    expect(smoke).toContain('"POSTGRES_HOST_AUTH_METHOD=trust"');
    expect(probe).toContain('require("/code/nodejs/dist/cdp/services/cyclotron-v2/janitor.js")');
    expect(probe).toContain("pg_terminate_backend(pid)");
    expect(probe).toContain("application_name = $2");
    expect(probe).toContain('await activeFailure');
    expect(probe).not.toContain('process.on("uncaughtException"');
  });
});
