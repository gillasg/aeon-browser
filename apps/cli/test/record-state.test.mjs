// `graft record` state: one pointer file (recordings/current = {folder, out}), a second start
// refused while a take is live, stop that follows the pointer whatever --out says, a start that
// checks the daemon for its data dir, and tab takes that keep their frames when the tab closes and
// say when Chrome delivered fewer frames than asked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { startFakeDaemon } from "./fake-daemon.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const recordingApi = new URL(
  "../../../browser/packages/engine/dist/code-api-recording.js",
  import.meta.url,
);

function fakeFfmpeg(dir) {
  const file = join(dir, "fake-ffmpeg");
  writeFileSync(
    file,
    `#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.mp4) : > "$last"; exit 0 ;;
  *%06d.jpg)
    d=$(dirname "$last"); mkdir -p "$d"
    printf '\\377\\330\\377' > "$d/000001.jpg"
    trap 'exit 0' INT TERM
    while :; do sleep 1; done ;;
esac
exit 0
`,
  );
  chmodSync(file, 0o755);
  const probe = join(dir, "fake-ffprobe");
  writeFileSync(probe, "#!/bin/sh\necho 1280,800\n");
  chmodSync(probe, 0o755);
  return { GRAFT_FFMPEG: file, GRAFT_FFPROBE: probe };
}

async function graft(home, args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, GRAFT_DATA_DIR: join(home, "data"), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), "graft-record-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const pointer = (home) =>
  JSON.parse(readFileSync(join(home, "data", "recordings", "current"), "utf8"));

test(
  "one pointer, a refused second start, and a stop that follows the pointer",
  // The fake ffmpeg is a POSIX shell script; Windows cannot run it as a program.
  { skip: process.platform === "win32" ? "the fake ffmpeg is a /bin/sh script" : false },
  async (t) => {
    const home = await tempHome(t);
    const env = fakeFfmpeg(home);
    const folder = join(home, "take-one");
    const start = await graft(home, ["record", "start", "--screen", "--out", folder], env);
    assert.equal(start.code, 0, start.stderr);
    assert.deepEqual(pointer(home), { folder, out: folder });

    const again = await graft(home, ["record", "start", "--tabs", "--out", join(home, "two")], env);
    assert.notEqual(again.code, 0);
    assert.match(again.stderr, /RECORDING_RUNNING: stop it first \(graft record stop\)/);
    assert.deepEqual(pointer(home), { folder, out: folder }, "the live take keeps the pointer");

    const stop = await graft(
      home,
      ["record", "stop", "--out", join(home, "somewhere-else"), "--allow-stutter"],
      env,
    );
    assert.equal(stop.code, 0, stop.stderr);
    assert.ok(stop.stdout.includes(`Folder: ${folder}`), stop.stdout);
    assert.ok(existsSync(join(folder, "events.json")));
    assert.ok(!existsSync(join(home, "data", "recordings", "current")), "stop clears the pointer");
  },
);

test("start checks that a daemon answers for the data dir", async (t) => {
  const home = await tempHome(t);
  const folder = join(home, "x");
  const refused = await graft(home, ["record", "start", "--tabs", "--out", folder]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /DAEMON_NOT_RUNNING/);
  assert.ok(!existsSync(join(home, "data", "recordings", "current")));

  const daemon = await startFakeDaemon(join(home, "data"));
  t.after(() => daemon.close());
  const ok = await graft(home, ["record", "start", "--tabs", "--out", folder]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(pointer(home), { folder, out: folder });

  const again = await graft(home, ["record", "start", "--tabs", "--out", join(home, "two")]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /RECORDING_RUNNING: stop it first \(graft record stop\)/);
  assert.deepEqual(pointer(home), { folder, out: folder });

  const stop = await graft(home, ["record", "stop", "--out", join(home, "other")]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.ok(stop.stdout.includes(`Folder: ${folder}`), stop.stdout);
  assert.ok(!existsSync(join(home, "data", "recordings", "current")), "stop clears the pointer");
});

/** Runs page.recordTab against a fake page whose tab closes after `frames` frames. */
async function recordTab({ frames, fps, seconds = 1 }) {
  const { browserRecordingApi } = await import(recordingApi);
  const saved = {};
  let polls = 0;
  const __call = async (request) => {
    if (request.workspace) return (saved[request.name] = request.value);
    if (request.action === "subscribe") return { data: { subscriptionId: "s" } };
    if (request.action === "dispose") return {};
    polls++;
    if (polls > frames) throw new Error("TARGET_LOST: the tab closed");
    await new Promise((done) => setTimeout(done, 5));
    return {
      data: {
        events: [{ params: { data: "AA==", metadata: { timestamp: Date.now() / 1000 + polls } } }],
      },
    };
  };
  const browser = { page: () => ({ cdp: async () => ({}) }) };
  const __sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const factory = new Function(
    "__call",
    "browser",
    "__sleep",
    "__key",
    `${browserRecordingApi}; return __recordTab;`,
  );
  const record = factory(__call, browser, __sleep, (target) => String(target));
  const summary = await record(1, { fps, seconds, name: "take" });
  return { summary, saved };
}

test("a tab that closes mid-take keeps the frames captured before it closed", async () => {
  const { summary, saved } = await recordTab({ frames: 3, fps: 1, seconds: 5 });
  assert.equal(summary.frames, 3);
  assert.match(summary.lost, /^TARGET_LOST/);
  assert.ok(saved["take/frames.json"], "frames.json is still written");
  assert.ok(saved["take/frame-000003.jpg"]);
});

test("fpsAsked, fpsDelivered, and a warning when Chrome delivers under 80%", async () => {
  const { summary } = await recordTab({ frames: 4, fps: 30, seconds: 1 });
  assert.equal(summary.fpsAsked, 30);
  assert.equal(summary.fpsDelivered, summary.fps);
  assert.ok(summary.fpsDelivered < 24);
  assert.match(summary.warning, /Asked for 30 fps/);
});
