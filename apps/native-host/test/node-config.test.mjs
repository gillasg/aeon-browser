import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createSandbox, cleanup, writeConfig, EXTENSION_ID } from "./node-helpers.mjs";
import { loadConfig } from "../node/config.mjs";

const options = (sandbox) => ({ env: sandbox.env, platform: process.platform, home: sandbox.home });

test("native configuration retries partial writes without accepting broken installations", async () => {
  const sandbox = createSandbox();
  const config = writeConfig(sandbox);
  try {
    const loaded = await loadConfig(sandbox.config, options(sandbox));
    assert.equal(loaded.extensionId, EXTENSION_ID);
    assert.equal(loaded.daemonEntrypoint, config.daemonEntrypoint);

    writeFileSync(sandbox.config, "");
    const writer = new Promise((done) =>
      setTimeout(() => {
        writeFileSync(sandbox.config, JSON.stringify(config));
        done();
      }, 150),
    );
    const recovered = await loadConfig(sandbox.config, options(sandbox));
    await writer;
    assert.equal(recovered.extensionId, EXTENSION_ID);
  } finally {
    await cleanup(sandbox);
  }
});

test("native configuration rejects broken or unexpected shapes", async () => {
  const sandbox = createSandbox();
  writeConfig(sandbox);
  try {
    writeFileSync(sandbox.config, "{}");
    await assert.rejects(loadConfig(sandbox.config, options(sandbox)), /invalid path or ID/);

    writeFileSync(sandbox.config, JSON.stringify({ ...writeConfig(sandbox), extra: "no" }));
    await assert.rejects(loadConfig(sandbox.config, options(sandbox)), /Unknown config key/);

    writeFileSync(
      sandbox.config,
      JSON.stringify({ ...writeConfig(sandbox), extensionId: "z".repeat(32) }),
    );
    await assert.rejects(loadConfig(sandbox.config, options(sandbox)), /invalid extension ID/);

    writeFileSync(
      sandbox.config,
      JSON.stringify({
        ...writeConfig(sandbox),
        nodeExecutable: join(sandbox.root, "missing-node"),
      }),
    );
    await assert.rejects(
      loadConfig(sandbox.config, options(sandbox)),
      /Node executable is missing/,
    );

    writeFileSync(
      sandbox.config,
      JSON.stringify({
        ...writeConfig(sandbox),
        daemonEntrypoint: join(sandbox.root, "missing.js"),
      }),
    );
    await assert.rejects(
      loadConfig(sandbox.config, options(sandbox)),
      /configured native host file is missing/,
    );

    writeFileSync(
      sandbox.config,
      JSON.stringify({ ...writeConfig(sandbox), dataDirectory: join(sandbox.root, "outside") }),
    );
    await assert.rejects(loadConfig(sandbox.config, options(sandbox)), /must live under/);
  } finally {
    await cleanup(sandbox);
  }
});

test("a build directory launches main.js and release fields survive", async () => {
  const sandbox = createSandbox();
  try {
    const build = join(sandbox.app, "builds", "0.1.0-abc1234");
    mkdirSync(build, { recursive: true });
    const nested = join(build, "main.js");
    writeFileSync(nested, "fixture");
    writeConfig(sandbox, { daemonEntrypoint: build });
    writeFileSync(
      sandbox.config,
      JSON.stringify({
        ...writeConfig(sandbox, { daemonEntrypoint: build }),
        current: "0.1.0-abc1234",
        previous: "0.1.0-def5678",
        channel: "stable",
      }),
    );
    const loaded = await loadConfig(sandbox.config, options(sandbox));
    assert.equal(loaded.daemonEntrypoint, nested);
    assert.equal(loaded.current, "0.1.0-abc1234");
    assert.equal(loaded.previous, "0.1.0-def5678");
    assert.equal(loaded.channel, "stable");
  } finally {
    await cleanup(sandbox);
  }
});

test("a data directory chosen by GRAFT_DATA_DIR is accepted by the service", async () => {
  const sandbox = createSandbox();
  try {
    const custom = join(sandbox.root, "graft-data");
    sandbox.env.GRAFT_DATA_DIR = custom;
    writeConfig(sandbox, { dataDirectory: custom });
    const loaded = await loadConfig(sandbox.config, options(sandbox));
    assert.equal(loaded.dataDirectory, custom);

    writeConfig(sandbox, { dataDirectory: join(sandbox.root, "elsewhere") });
    await assert.rejects(loadConfig(sandbox.config, options(sandbox)), /must live under/);
  } finally {
    await cleanup(sandbox);
  }
});
