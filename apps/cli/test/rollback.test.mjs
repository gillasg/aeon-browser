import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rollbackRelease, runRollback } from "../dist/rollback.js";

async function layout() {
  const root = await mkdtemp(join(tmpdir(), "aeon-rollback-"));
  const current = "0.2.0-bbbbbbb";
  const previous = "0.1.0-aaaaaaa";
  await mkdir(join(root, "builds", current), { recursive: true });
  await mkdir(join(root, "builds", previous), { recursive: true });
  await writeFile(join(root, "builds", current, "main.js"), "new");
  await writeFile(join(root, "builds", previous, "main.js"), "old");
  const hostConfig = join(root, "host-config.json");
  await writeFile(
    hostConfig,
    JSON.stringify({
      extensionId: "a".repeat(32),
      nodeExecutable: "C:\\node.exe",
      daemonEntrypoint: join(root, "builds", current, "main.js"),
      dataDirectory: join(root, "data"),
    }),
  );
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({ current, previous, channel: "stable" }),
  );
  return { root, hostConfig, current, previous };
}

test("rollback points the daemon at the previous build and keeps the other host settings", async () => {
  const { root, hostConfig, current, previous } = await layout();
  const result = await rollbackRelease({ root, hostConfig });
  assert.equal(result.from, current);
  assert.equal(result.to, previous);
  assert.equal(result.entrypoint, join(root, "builds", previous, "main.js"));
  const config = JSON.parse(await readFile(hostConfig, "utf8"));
  assert.equal(config.daemonEntrypoint, result.entrypoint);
  assert.equal(config.extensionId, "a".repeat(32));
  assert.equal(config.nodeExecutable, "C:\\node.exe");
  assert.equal("current" in config, false);
  assert.equal("previous" in config, false);
  const release = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
  assert.equal(release.current, previous);
  assert.equal(release.previous, current);
  assert.equal(release.channel, "stable");
  const log = await readFile(join(root, "rollback.log"), "utf8");
  assert.match(log, new RegExp(`from ${current} to ${previous}`));
});

test("rollback refuses a missing previous build and does not change the entrypoint", async () => {
  const { root, hostConfig } = await layout();
  const before = await readFile(hostConfig, "utf8");
  await writeFile(join(root, "release.json"), JSON.stringify({ current: "0.2.0-bbbbbbb" }));
  await assert.rejects(rollbackRelease({ root, hostConfig }), /No previous build/);
  assert.equal(await readFile(hostConfig, "utf8"), before);
});

test("rollback refuses a previous build whose daemon file is gone", async () => {
  const { root, hostConfig, previous } = await layout();
  const { rm } = await import("node:fs/promises");
  await rm(join(root, "builds", previous, "main.js"));
  await assert.rejects(rollbackRelease({ root, hostConfig }), /no daemon/);
});

test("rollback refuses a build id that leaves the Aeon folder", async () => {
  const { root, hostConfig } = await layout();
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({ current: "0.2.0-bbbbbbb", previous: "../0.1.0-aaaaaaa" }),
  );
  await assert.rejects(rollbackRelease({ root, hostConfig }), /<version>-<sha>/);
});

test("aeon rollback --json reports the switch without touching another install", async () => {
  const { root, hostConfig, previous } = await layout();
  let written = "";
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    written += String(chunk);
    return true;
  };
  try {
    const code = await runRollback(true, { root, hostConfig });
    assert.equal(code, 0);
  } finally {
    process.stdout.write = write;
  }
  const parsed = JSON.parse(written);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.to, previous);
  assert.equal(parsed.entrypoint, join(root, "builds", previous, "main.js"));
});
