"use strict";

const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const TRANSIENT_DOWNLOAD_EXIT = 75;
const RECOVERY_DELAY_MS = 30000;

async function buildAttempt(build, report = console.error) {
  try {
    await build({ win: ["nsis"], x64: true, publish: "never" });
    return 0;
  } catch (error) {
    report(error);
    return error?.name === "HTTPError" && [502, 503, 504].includes(error?.response?.statusCode)
      ? TRANSIENT_DOWNLOAD_EXIT
      : 1;
  }
}

function spawnAttempt() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, "--attempt"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function buildWithRecovery(attempt = spawnAttempt, wait = delay, report = console.error) {
  const code = await attempt();
  if (code !== TRANSIENT_DOWNLOAD_EXIT) return code;
  // A fresh process discards electron-builder's memoized rejected download promises.
  // Its short download retries run first; this single recovery lets an outage clear.
  report("NSIS download failed with HTTP 502/503/504; retrying once in 30 seconds.");
  await wait(RECOVERY_DELAY_MS);
  return attempt();
}

if (require.main === module) {
  const run = process.argv[2] === "--attempt"
    ? buildAttempt(require("electron-builder").build)
    : buildWithRecovery();
  run.then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildAttempt, buildWithRecovery };
