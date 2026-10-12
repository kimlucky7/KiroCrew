"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildAttempt, buildWithRecovery } = require("../scripts/build-ci-nsis");

function httpError(statusCode) {
  return Object.assign(new Error(`Response code ${statusCode}`), {
    name: "HTTPError", response: { statusCode },
  });
}

test("unsigned CI build preserves x64 NSIS and never publishes", async () => {
  const code = await buildAttempt(async (options) => {
    assert.deepEqual(options, { win: ["nsis"], x64: true, publish: "never" });
  });
  assert.equal(code, 0);
});

for (const status of [502, 503, 504]) {
  test(`HTTP ${status} recovers once after bounded backoff`, async () => {
    const order = [];
    const code = await buildWithRecovery(async () => buildAttempt(async () => {
      order.push("build");
      if (order.length === 1) throw httpError(status);
    }, () => {}), async (ms) => { order.push(ms); }, () => {});
    assert.equal(code, 0);
    assert.deepEqual(order, ["build", 30000, "build"]);
  });
}

test("persistent 504 fails after exactly two attempts", async () => {
  let attempts = 0;
  const waits = [];
  const code = await buildWithRecovery(async () => buildAttempt(async () => {
    attempts += 1;
    throw httpError(504);
  }, () => {}), async (ms) => { waits.push(ms); }, () => {});
  assert.notEqual(code, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [30000]);
});

for (const error of [httpError(401), httpError(403), httpError(404),
  new Error("checksum mismatch"), new Error("signing failed: HTTP 504")]) {
  test(`${error.message} fails without retry`, async () => {
    let attempts = 0;
    const code = await buildWithRecovery(async () => buildAttempt(async () => {
      attempts += 1;
      throw error;
    }, () => {}), async () => assert.fail("unexpected backoff"));
    assert.equal(code, 1);
    assert.equal(attempts, 1);
  });
}

test("a different failure on the recovery attempt remains a failure", async () => {
  let attempts = 0;
  const code = await buildWithRecovery(async () => buildAttempt(async () => {
    throw ++attempts === 1 ? httpError(504) : new Error("invalid NSIS script");
  }, () => {}), async () => {}, () => {});
  assert.equal(code, 1);
  assert.equal(attempts, 2);
});

test("spawn errors propagate without retry", async () => {
  const error = new Error("spawn failed");
  await assert.rejects(buildWithRecovery(async () => { throw error; },
    async () => assert.fail("unexpected backoff")), (actual) => actual === error);
});

test("the CLI recovers in a fresh process and returns its status", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsis-recovery-"));
  try {
    const preload = path.join(dir, "builder-stub.cjs");
    const record = path.join(dir, "attempts.jsonl");
    fs.writeFileSync(preload, `
      const fs = require("node:fs");
      const Module = require("node:module");
      const load = Module._load;
      Module._load = function (name, ...args) {
        if (name === "node:timers/promises") return {
          setTimeout: async (ms) => {
            if (ms !== 30000) throw new Error("wrong backoff");
          },
        };
        if (name === "electron-builder") return { build: async (options) => {
          const file = process.env.NSIS_TEST_RECORD;
          const first = !fs.existsSync(file);
          fs.appendFileSync(file, JSON.stringify({ pid: process.pid, options }) + "\\n");
          if (first) throw Object.assign(new Error("Gateway Time-out"), {
            name: "HTTPError", response: { statusCode: 504 },
          });
        } };
        return load.call(this, name, ...args);
      };
    `);
    const result = spawnSync(process.execPath, [require.resolve("../scripts/build-ci-nsis")], {
      env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        NSIS_TEST_RECORD: record },
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const attempts = fs.readFileSync(record, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].pid, attempts[1].pid);
    for (const attempt of attempts) {
      assert.deepEqual(attempt.options, { win: ["nsis"], x64: true, publish: "never" });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
