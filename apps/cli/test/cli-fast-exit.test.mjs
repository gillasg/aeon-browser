// `graft --help` prints from the help the build wrote, without loading the command line, and
// matches what the full command line prints. `graft status` exits as soon as it has answered,
// even when the browser is too busy to list hand-off tabs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { WebSocketServer } from "ws";
import { writeFileSync } from "node:fs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const main = fileURLToPath(new URL("../dist/cli-main.js", import.meta.url));

async function timed(file, args, env = process.env) {
  const started = Date.now();
  const { stdout } = await run(process.execPath, [file, ...args], { env, timeout: 120_000 });
  return { stdout, ms: Date.now() - started };
}

test("help prints fast and the same as the full command line", { timeout: 300_000 }, async () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["repl", "--help"],
    ["tabs", "--help"],
    ["help", "record"],
  ]) {
    const fast = await timed(cli, args);
    const full = await timed(main, args[0] === "-h" ? ["--help"] : args);
    assert.equal(fast.stdout, full.stdout, args.join(" "));
    assert.ok(fast.ms < 1_500, `${args.join(" ")} took ${fast.ms} ms`);
  }
  const short = await timed(cli, ["tabs", "-h"]);
  assert.match(short.stdout, /^Usage: graft tabs/);
});

test("graft status exits promptly when the browser never answers the tab listing", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "graft-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((done) => server.once("listening", done));
  t.after(() => new Promise((done) => server.close(done)));
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "core.hello") socket.send(JSON.stringify({ kind: "core.ready" }));
      if (message.kind === "core.settings")
        socket.send(
          JSON.stringify({
            kind: "core.settings.result",
            requestId: message.requestId,
            browsers: [{}],
          }),
        );
      // core.browser.run is never answered: a Chrome stuck on another cell.
    }),
  );
  writeFileSync(
    join(home, "core-connection.json"),
    JSON.stringify({ endpoint: `ws://127.0.0.1:${server.address().port}`, token: "t" }),
  );
  const result = await timed(cli, ["status"], { ...process.env, GRAFT_DATA_DIR: home });
  assert.match(result.stdout, /Graft is running; 1 browser\(s\) connected\./);
  assert.ok(result.ms < 2_500, `status took ${result.ms} ms`);
});
