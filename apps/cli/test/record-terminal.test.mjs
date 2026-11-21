// Terminal casts land in events.json and survive record stop. The kit's line picker is the pane.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { alignCast, attachTerminal, terminalCast } from "../dist/record-terminal.js";
import { terminalFrame, terminalLines } from "../../../templates/video/src/terminal.ts";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function aeon(home, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, AEON_DATA_DIR: join(home, "data") },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("a terminal cast is timestamped, ordered, and aligned to the clip clock", () => {
  const cast = terminalCast("aeon tool", 5_000, [
    { at: 5_040, kind: "out", text: "hello-term\n" },
    { at: 5_010, kind: "err", text: "warn\n" },
  ]);
  assert.equal(cast.events[0].kind, "in");
  assert.equal(cast.events[0].text, "aeon tool");
  assert.deepEqual(
    cast.events.map((event) => event.t),
    [0, 40, 40],
  );
  const aligned = alignCast(cast, 4_000);
  assert.deepEqual(
    aligned.events.map((event) => event.t),
    [1000, 1040, 1040],
  );
  const lines = terminalLines(aligned, 1040);
  assert.equal(lines[0].text, "$ aeon tool");
  assert.equal(lines[1].text, "hello-term");
  assert.equal(lines[2].kind, "err");
  const wide = terminalFrame(1920, 1080, true);
  assert.ok(wide.term.x >= wide.chrome.w);
  assert.ok(wide.term.w > 0);
  const tall = terminalFrame(1080, 1920, true);
  assert.ok(tall.term.y >= tall.chrome.h);
  const bare = attachTerminal(undefined, cast);
  assert.equal(bare.terminal.command, "aeon tool");
  assert.equal(bare.version, 1);
});

test("aeon record terminal writes the command and stop keeps it", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-term-"));
  try {
    const folder = join(home, "demo");
    const start = await aeon(home, ["record", "start", "--tabs", "--out", folder]);
    assert.equal(start.code, 0, start.stderr);
    const command = `node -e "console.log('hello-term')"`;
    const recorded = await aeon(home, ["record", "terminal", "--out", folder, "--run", command]);
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
    const stopped = await aeon(home, ["record", "stop", "--out", folder]);
    assert.equal(stopped.code, 0, stopped.stderr);
    const events = JSON.parse(readFileSync(join(folder, "events.json"), "utf8"));
    assert.equal(events.clip.source, "tabs");
    assert.equal(events.terminal.command, command);
    assert.ok(events.terminal.events.some((event) => event.text.includes("hello-term")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
