import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exitModule = fileURLToPath(new URL("../dist/exit.js", import.meta.url));

// An agent reads `graft repl` through a pipe. process.exit() used to drop what the pipe still held,
// so a large result arrived cut off mid-JSON.
test("a large result written just before exit reaches a pipe whole", async () => {
  const size = 1_000_000;
  const script = `
    const { exitAfterFlush } = await import(${JSON.stringify("file://" + exitModule.replace(/\\/g, "/"))});
    process.stdout.write("x".repeat(${size}));
    await exitAfterFlush(3);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
  let length = 0;
  // Read slowly, like a busy parent, so the pipe stays full when the child exits.
  child.stdout.on("data", (chunk) => {
    length += chunk.length;
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 2);
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 3);
  assert.equal(length, size);
});

// On macOS a command that has just closed its daemon WebSocket can sit on the async drain
// callback for minutes (a clean-install step took 15). The bounded exit must still end the run.
test("exitAfterFlush ends even when a drain callback never fires", async () => {
  const script = `
    const { exitAfterFlush } = await import(${JSON.stringify("file://" + exitModule.replace(/\\/g, "/"))});
    setInterval(() => {}, 1000); // a handle that keeps Node alive, like an unclosed socket
    for (const stream of [process.stdout, process.stderr]) {
      stream.write = () => false; // never call the flush callback
    }
    await exitAfterFlush(3, 200); // a short cap keeps this regression test fast
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, 6000);
    child.on("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(code, 3);
  assert.ok(Date.now() - started < 6000, "exitAfterFlush did not end the process");
});
