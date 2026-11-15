import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
