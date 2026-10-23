import assert from "node:assert/strict";
import test from "node:test";
import { installProcessGuard } from "../dist/process-guard.js";

test("stray errors are logged and only a burst of exceptions restarts the daemon", () => {
  const before = {
    rejection: process.listeners("unhandledRejection"),
    exception: process.listeners("uncaughtException"),
  };
  // Set the test runner's own listeners aside so the simulated errors only reach the guard.
  process.removeAllListeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  const logs = [];
  const exits = [];
  installProcessGuard(
    (message) => logs.push(message),
    (code) => exits.push(code),
  );
  try {
    process.emit("unhandledRejection", new Error("extension promise"), Promise.resolve());
    assert.match(logs.at(-1), /kept running: Error: extension promise/);
    for (let index = 0; index < 4; index++) process.emit("uncaughtException", new Error("boom"));
    assert.deepEqual(exits, []);
    process.emit("uncaughtException", new Error("boom"));
    assert.deepEqual(exits, [1]);
  } finally {
    process.removeAllListeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    for (const listener of before.rejection) process.on("unhandledRejection", listener);
    for (const listener of before.exception) process.on("uncaughtException", listener);
  }
});
