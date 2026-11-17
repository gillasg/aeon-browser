import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDir, foreignSocket } from "../src/private-dir.ts";

const posix = process.platform !== "win32";
const fix = "Set AEON_DATA_DIR to a directory you own with mode 700.";

function sudo(args) {
  try {
    execFileSync("sudo", ["-n", "-u", "nobody", ...args], { stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

function skipAttacker() {
  if (!posix) return "Mac/Linux only";
  if (sudo(["true"]) !== 0) return "needs passwordless sudo for a second local user";
  return false;
}

test(
  "a private directory is created at mode 700 and a loose one we own is tightened",
  { skip: !posix },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "aeon-private-"));
    const dir = join(root, "data");
    const lines = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk, encoding, callback) => {
      lines.push(String(chunk));
      return write.call(process.stderr, chunk, encoding, callback);
    };
    try {
      await ensurePrivateDir(dir, { fix });
      assert.equal(lstatSync(dir).mode & 0o777, 0o700);
      assert.equal(lstatSync(dir).uid, process.getuid());
      assert.equal(lines.length, 0);
      chmodSync(dir, 0o775);
      await ensurePrivateDir(dir, { fix });
      assert.equal(lstatSync(dir).mode & 0o777, 0o700);
      assert.match(lines.join(""), /775/);
      assert.match(lines.join(""), /700/);
      const link = join(root, "link");
      symlinkSync(dir, link);
      await assert.rejects(ensurePrivateDir(link, { fix }), /not a real directory/);
      chmodSync(root, 0o775);
      await ensurePrivateDir(join(root, "grouped"), { fix });
      assert.equal(lstatSync(join(root, "grouped")).mode & 0o777, 0o700);
      chmodSync(root, 0o777);
      await assert.rejects(ensurePrivateDir(join(root, "child"), { fix }), /sticky/);
    } finally {
      process.stderr.write = write;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a second local user cannot pre-create Aeon's data directory",
  { skip: skipAttacker() },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "aeon-attacker-"));
    chmodSync(parent, 0o1777);
    const dir = join(parent, "data");
    try {
      assert.equal(sudo(["mkdir", "-m", "0755", dir]), 0);
      const before = lstatSync(dir);
      await assert.rejects(ensurePrivateDir(dir, { create: false, fix }), /owned by uid/);
      assert.equal(lstatSync(dir).uid, before.uid);
      assert.equal(lstatSync(dir).mode & 0o777, before.mode & 0o777);
      assert.equal(before.mode & 0o777, 0o755);
      assert.notEqual(before.uid, process.getuid());
      const planted = join(parent, "core-owner.sock");
      const script =
        "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1)";
      assert.equal(sudo(["python3", "-c", script, planted]), 0);
      assert.match(foreignSocket(planted) ?? "", /owned by uid/);
      const sockLink = join(parent, "sock-link");
      symlinkSync(planted, sockLink);
      assert.match(foreignSocket(sockLink) ?? "", /symlink/);
    } finally {
      sudo(["rm", "-rf", dir]);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
