"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const janitorRequire = createRequire("/code/nodejs/dist/cdp/services/cyclotron-v2/janitor.js");
const { Client } = janitorRequire("pg");
const isWorker = process.argv.at(-1) === "worker";
const mode = isWorker ? process.argv[1] : process.argv[2];
const applicationName = `uptomic-janitor-fixture-${mode}`;
// Trust is limited to the disposable internal Docker network; no host port or
// production configuration/credential is accepted by this proof.
const url = `postgresql://postgres@postgres.fixture:5432/janitor_fixture?application_name=${applicationName}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stage = "start";

async function worker() {
  const { CyclotronV2Janitor } = require("/code/nodejs/dist/cdp/services/cyclotron-v2/janitor.js");
  const janitor = new CyclotronV2Janitor({ pool: { dbUrl: url, maxConnections: 1, idleTimeoutMs: 30000 } });
  const pool = janitor.pool;
  assert.equal(janitorRequire("pg/package.json").version, "8.10.0");
  assert.equal(pool.listenerCount("error"), mode === "overlay" ? 1 : 0);
  const first = await pool.query("SELECT pg_backend_pid() AS pid");
  assert.equal(pool.idleCount, 1);
  process.send({ type: "idle-ready", pid: first.rows[0].pid });
  // Observe removal only, never add an error/uncaughtException listener here:
  // the baseline must exercise the actual unhandled idle-pool error path.
  pool.on("remove", () => process.send({ type: "removed" }));
  process.on("message", async (message) => {
    try {
      if (message === "recover") {
        assert.equal(pool.totalCount, 0);
        const next = await pool.query("SELECT 1 AS value, pg_backend_pid() AS pid");
        assert.equal(next.rows[0].value, 1);
        assert.notEqual(next.rows[0].pid, first.rows[0].pid);
        process.send({ type: "recovered", pid: next.rows[0].pid });
      } else if (message === "active") {
        // Attach rejection handling immediately; this error must reach the
        // caller, not the idle listener, and the following query must recover.
        const activeFailure = pool.query("SELECT pg_sleep(10)").then(
          () => { throw new Error("ACTIVE_QUERY_UNEXPECTEDLY_SUCCEEDED"); },
          (error) => { assert.equal(error.code, "57P01"); return error.code; },
        );
        process.send({ type: "active-started" });
        const code = await activeFailure;
        const next = await pool.query("SELECT 1 AS value");
        assert.equal(next.rows[0].value, 1);
        process.send({ type: "active-rejected-and-recovered", code });
        await janitor.stop();
        process.disconnect();
      }
    } catch (error) {
      console.error(`JANITOR_WORKER_ASSERTION:${error.code ?? error.name}`);
      process.exit(2);
    }
  });
}

async function proof() {
  assert.ok(["baseline", "overlay"].includes(mode));
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 2000 });
  let child;
  let exit;
  let stderr = "";
  const messages = [];
  const deadline = Date.now() + 20000;
  const hardStop = setTimeout(() => {
    if (child && exit === undefined) child.kill("SIGKILL");
    console.error("JANITOR_PROOF_HARD_TIMEOUT");
    process.exit(2);
  }, 25000);
  async function waitFor(predicate, label) {
    stage = label;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`JANITOR_PROOF_TIMEOUT:${label}`);
      if (exit !== undefined) throw new Error(`JANITOR_UNEXPECTED_EXIT:${exit}:${label}`);
      await delay(20);
    }
  }
  const has = (type) => messages.find((message) => message.type === type);
  try {
    await admin.connect();
    // stdin script is passed via a bounded env value so the child executes the
    // identical versioned probe, not a duplicate Janitor implementation.
    child = spawn(process.execPath, ["-e", process.env.JANITOR_PROBE_SOURCE, mode, "worker"], {
      env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-12000); });
    child.on("message", (message) => messages.push(message));
    child.on("exit", (code) => { exit = code; });
    await waitFor(() => has("idle-ready"), "owned-pool-idle");
    const pid = has("idle-ready").pid;
    stage = "terminate-owned-idle-backend";
    const terminated = await admin.query(
      "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid = $1 AND application_name = $2 AND datname = current_database() AND state = 'idle'",
      [pid, applicationName],
    );
    assert.deepEqual(terminated.rows, [{ terminated: true }]);
    if (mode === "baseline") {
      // Wait directly: an early worker exit is the expected result only after
      // the proved idle backend termination and its exact PostgreSQL error.
      while (exit === undefined && Date.now() < deadline) await delay(20);
      stage = "baseline-fatal-idle-error";
      assert.equal(exit, 1);
      assert.match(stderr, /57P01/);
      assert.match(stderr, /Unhandled 'error' event/);
      assert.ok(!stderr.includes("JANITOR_WORKER_ASSERTION"));
      console.log("Janitor baseline: real idle backend termination causes unhandled pool error and exit 1");
    } else {
      await waitFor(() => has("removed"), "idle-client-eviction");
      await delay(50); // let the same error event finish before sending recovery
      assert.equal(exit, undefined);
      child.send("recover");
      await waitFor(() => has("recovered"), "new-backend-query");
      child.send("active");
      await waitFor(() => has("active-started"), "active-query-started");
      const activePid = has("recovered").pid;
      // Confirm the fixture query is active before terminating its own backend.
      let active = false;
      while (!active && Date.now() < deadline) {
        const result = await admin.query("SELECT state, query FROM pg_stat_activity WHERE pid=$1 AND application_name=$2", [activePid, applicationName]);
        active = result.rows[0]?.state === "active" && result.rows[0]?.query === "SELECT pg_sleep(10)";
        if (!active) await delay(20);
      }
      assert.ok(active);
      const killed = await admin.query("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND application_name = $2 AND datname=current_database() AND state='active'", [activePid, applicationName]);
      assert.deepEqual(killed.rows, [{ terminated: true }]);
      await waitFor(() => has("active-rejected-and-recovered"), "active-query-rejection-and-recovery");
      while (exit === undefined && Date.now() < deadline) await delay(20);
      assert.equal(exit, 0);
      console.log("Janitor overlay: same process survives idle disconnect, gets a new backend, preserves active-query rejection and recovers again");
    }
  } finally {
    if (child && exit === undefined) child.kill("SIGKILL");
    await admin.end();
    clearTimeout(hardStop);
  }
}

// node -e places its first argument at argv[1], unlike node - from stdin.
(isWorker ? worker() : proof()).catch((error) => {
  console.error(`Janitor fixture proof failed: ${JSON.stringify({ mode, stage, code: error.code ?? error.name, message: error.message }).slice(0, 1500)}`);
  process.exit(2);
});
