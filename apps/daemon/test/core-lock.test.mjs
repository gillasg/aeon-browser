import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireCoreLock } from "../dist/core-startup.js";

test(
  "a core lock left by a killed daemon does not block the next start",
  { skip: process.platform === "win32" ? "Unix socket file" : false },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "aeon-core-lock-"));
    const socket = join(directory, "core-owner.sock");
    try {
      writeFileSync(socket, "stale");
      assert.equal(existsSync(socket), true);

      const unlock = await acquireCoreLock(directory);
      await unlock();
      assert.equal(existsSync(socket), false);

      const again = await acquireCoreLock(directory);
      await assert.rejects(acquireCoreLock(directory), /EADDRINUSE/);
      await again();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("unlocking does not unlink after close, where a new owner can appear", async () => {
  // Closing the server removes its own Unix socket. An unlink after that close can remove a
  // socket a concurrent daemon bound in the window (core-startup.ts' unlock).
  const source = readFileSync(new URL("../src/core-startup.ts", import.meta.url), "utf8");
  const start = source.indexOf("return async () => {");
  assert.notEqual(start, -1, "acquireCoreLock has an unlock");
  const unlock = source.slice(start, source.indexOf("};", start) + 2);
  assert.equal(/unlink\s*\(/.test(unlock), false, "unlock unlinks after the server closed");
});
