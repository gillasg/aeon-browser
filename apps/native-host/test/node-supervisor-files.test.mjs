// The app root outside the installer: the log writer itself must leave a private directory and
// a 0600 file, because daemon stderr can name URLs, sites and provider errors.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  startupFailureMessage,
  SupervisorLog,
  SupervisorStatus,
} from "../node/supervisor-files.mjs";

test(
  "a log written outside the installer is 0600 in a 0700 folder",
  { skip: process.platform === "win32" ? "POSIX modes" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "aeon-supervisor-files-"));
    const app = join(root, "Aeon");
    const path = join(app, "daemon-supervisor.log");
    try {
      const log = new SupervisorLog(path);
      log.write("a line");
      assert.equal(statSync(app).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      // A log left world-readable by an older run is tightened on the next write.
      chmodSync(path, 0o644);
      log.write("another line");
      assert.equal(statSync(path).mode & 0o777, 0o600);

      const statusPath = join(app, "daemon-supervisor-status.json");
      new SupervisorStatus(statusPath).setReady(42);
      assert.equal(statSync(statusPath).mode & 0o777, 0o600);
      const failed = new SupervisorStatus(statusPath);
      failed.setRestarting("startup-failed", "Refusing /tmp/aeon: it is owned by uid 65534.");
      assert.equal(failed.read().error, "Refusing /tmp/aeon: it is owned by uid 65534.");
      assert.equal(failed.read().state, "restarting");
      assert.equal(
        startupFailureMessage("AEON_DAEMON_FAILED Refusing /tmp/aeon: it is owned by uid 65534."),
        "Refusing /tmp/aeon: it is owned by uid 65534.",
      );
      assert.equal(startupFailureMessage("AEON_DAEMON_PHASE lock"), undefined);
      failed.setReady(7);
      assert.equal(failed.read().error, undefined);
      assert.equal(failed.read().state, "ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
