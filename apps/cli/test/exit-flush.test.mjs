import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exitModule = fileURLToPath(new URL("../dist/exit.js", import.meta.url));

// An agent reads `aeon repl` through a pipe. process.exit() used to drop what the pipe still held,
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
