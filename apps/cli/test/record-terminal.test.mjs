// Terminal casts land in events.json and survive record stop.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { alignCast, attachTerminal, terminalCast } from "../dist/record-terminal.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function graft(home, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, GRAFT_DATA_DIR: join(home, "data") },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("a terminal cast is timestamped, ordered, and aligned to the clip clock", () => {
  const cast = terminalCast("graft tool", 5_000, [
    { at: 5_040, kind: "out", text: "hello-term\n" },
    { at: 5_010, kind: "err", text: "warn\n" },
  ]);
  assert.equal(cast.events[0].kind, "in");
  assert.equal(cast.events[0].text, "graft tool");
  assert.deepEqual(
    cast.events.map((event) => event.t),
    [0, 40, 40],
  );
  const aligned = alignCast(cast, 4_000);
  assert.deepEqual(
    aligned.events.map((event) => event.t),
    [1000, 1040, 1040],
  );
  assert.equal(aligned.events[1].text, "hello-term\n");
  assert.equal(aligned.events[2].kind, "err");
  assert.equal(aligned.events[2].text, "warn\n");
  const bare = attachTerminal(undefined, cast);
  assert.equal(bare.terminal.command, "graft tool");
  assert.equal(bare.version, 1);
});

test("graft record terminal writes the command and stop keeps it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "graft-term-"));
  const daemon = await startFakeDaemon(join(home, "data"));
  t.after(() => daemon.close());
  try {
    const folder = join(home, "demo");
    const start = await graft(home, ["record", "start", "--tabs", "--out", folder]);
    assert.equal(start.code, 0, start.stderr);
    const command = `node -e "console.log('hello-term')"`;
    const recorded = await graft(home, ["record", "terminal", "--out", folder, "--run", command]);
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.match(recorded.stdout, /Recorded the terminal/);
    const during = JSON.parse(readFileSync(join(folder, "events.json"), "utf8"));
    assert.equal(during.terminal.command, command);
    assert.equal(during.terminal.version, 1);
    assert.ok(
      during.terminal.events.some(
        (event) => event.kind === "out" && event.text.includes("hello-term"),
      ),
    );
    let last = -1;
    for (const event of during.terminal.events) {
      assert.ok(event.t >= last);
      last = event.t;
    }
    const stopped = await graft(home, ["record", "stop", "--out", folder]);
    assert.equal(stopped.code, 0, stopped.stderr);
    const events = JSON.parse(readFileSync(join(folder, "events.json"), "utf8"));
    assert.equal(events.clip.source, "tabs");
    assert.equal(events.terminal.command, command);
    assert.ok(events.terminal.events.some((event) => event.text.includes("hello-term")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
