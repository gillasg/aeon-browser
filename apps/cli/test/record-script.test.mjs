// `aeon record mark|wait|run` helpers, --no-mouse, the fast encode, and marks merged at stop.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  captureArgs,
  ENCODE_OUTPUT,
  ENCODE_QUALITY,
  FRAME_FORMAT,
} from "../dist/record-capture.js";
import {
  ACTIVE,
  boundsOf,
  chatFinished,
  clampBox,
  frameOf,
  markOf,
  parseBox,
  until,
  windowBoxOf,
  withMarkCues,
} from "../dist/record-script.js";
import { aeonCommands } from "../dist/commands.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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
    i=1; while [ $i -le 3 ]; do printf '\\377\\330\\377\\340\\000\\020JFIF\\000\\001\\001\\000\\000\\001\\000\\001\\000\\000' > "$d/$(printf '%06d' $i).jpg"; i=$((i+1)); done
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
  return { ffmpeg: file, ffprobe: probe };
}

test("--no-mouse keeps the OS pointer out of every platform's capture", () => {
  const state = {
    version: 1,
    source: "screen",
    folder: "/r",
    fps: 30,
    startedAt: 1,
    ffmpeg: "f",
    frames: 0,
    geometry: { x: 0, y: 0, w: 1280, h: 720 },
    display: ":1",
  };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(after(captureArgs(state, "/r", "linux"), "-draw_mouse"), "1");
  assert.equal(after(captureArgs({ ...state, noMouse: true }, "/r", "linux"), "-draw_mouse"), "0");
  assert.equal(after(captureArgs({ ...state, noMouse: true }, "/r", "win32"), "-draw_mouse"), "0");
  assert.equal(
    after(captureArgs({ ...state, noMouse: true }, "/r", "darwin"), "-capture_cursor"),
    "0",
  );
});

test("the clip encodes with the fast preset at crf 16 from 4:2:0 frames", () => {
  assert.deepEqual(ENCODE_QUALITY, ["-preset", "superfast", "-crf", "18", "-threads", "0"]);
  assert.deepEqual(ENCODE_OUTPUT, ["-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
  assert.deepEqual(FRAME_FORMAT, ["-pix_fmt", "yuvj420p", "-q:v", "2"]);
  const state = {
    version: 1,
    source: "screen",
    folder: "/r",
    fps: 30,
    startedAt: 1,
    ffmpeg: "f",
    frames: 0,
    geometry: { x: 0, y: 0, w: 8, h: 8 },
    display: ":1",
  };
  for (const platform of ["linux", "darwin", "win32"])
    assert.ok(
      captureArgs(state, "/r", platform).join(" ").includes("-pix_fmt yuvj420p -q:v 2"),
      platform,
    );
});

test("a page box becomes clip pixels: toolbar and borders added, then scaled by DPR", () => {
  const box = { x: 10, y: 20, width: 100, height: 40 };
  assert.deepEqual(windowBoxOf(box, { dpr: 3, top: 87, side: 0 }), {
    x: 30,
    y: 321,
    width: 300,
    height: 120,
  });
  assert.deepEqual(windowBoxOf(box, { dpr: 0, top: -5, side: 2 }), {
    x: 12,
    y: 20,
    width: 100,
    height: 40,
  });
});

test("boxes are cut to the viewport; fully offscreen ones are null", () => {
  assert.deepEqual(clampBox({ x: -10, y: 600, width: 100, height: 400 }, 1280, 633), {
    x: 0,
    y: 600,
    width: 90,
    height: 33,
  });
  assert.equal(clampBox({ x: 0, y: 700, width: 50, height: 50 }, 1280, 633), null);
  assert.equal(clampBox({ x: 1300, y: 0, width: 50, height: 50 }, 1280, 633), null);
});

test("the frame falls back to the captured window when outerHeight is 0 (Xvfb/openbox)", () => {
  const page = { dpr: 2, innerWidth: 1280, innerHeight: 633, outerWidth: 0, outerHeight: 0 };
  assert.deepEqual(frameOf(page, { w: 2560, h: 1440 }), { dpr: 2, top: 87, side: 0 });
  assert.deepEqual(frameOf(page), { dpr: 2, top: 0, side: 0 });
  const real = { dpr: 1, innerWidth: 1270, innerHeight: 600, outerWidth: 1280, outerHeight: 690 };
  assert.deepEqual(frameOf(real, { w: 9999, h: 9999 }), { dpr: 1, top: 90, side: 5 });
  const bounds = boundsOf(
    { box: { x: 10, y: 600, width: 20, height: 100 }, ...page },
    {
      w: 2560,
      h: 1440,
    },
  );
  assert.deepEqual(markOf("m", 5, { bounds }).windowBox, { x: 20, y: 1374, width: 40, height: 66 });
});

test("the tab on camera is the active one, Aeon pages and about:blank included", async () => {
  const pick = (tabs) =>
    new Function("browser", `return (async () => { ${ACTIVE} return tab.id; })();`)({
      tabs: async () => tabs,
    });
  assert.equal(
    await pick([
      { id: 1, url: "https://a.test/", active: false },
      { id: 2, url: "chrome-extension://x/home.html", active: true },
    ]),
    2,
  );
  assert.equal(await pick([{ id: 3, url: "about:blank", active: false }]), 3);
  await assert.rejects(pick([]), /No tab is open/);
});

test("marks carry name, time, label, boxes and a cue; bad input is refused plainly", () => {
  assert.deepEqual(parseBox("1, 2, 30, 40"), { x: 1, y: 2, width: 30, height: 40 });
  assert.throws(() => parseBox("1,2,3"), /x,y,w,h/);
  assert.throws(() => parseBox("1,2,0,4"), /x,y,w,h/);
  const bounds = { box: { x: 1, y: 2, width: 3, height: 4 }, dpr: 2, top: 80, side: 0 };
  assert.deepEqual(markOf("send", 1234.6, { label: "Send", cue: "trigger", bounds }), {
    name: "send",
    t: 1235,
    label: "Send",
    box: bounds.box,
    windowBox: { x: 2, y: 164, width: 6, height: 8 },
    cue: "trigger",
  });
  assert.deepEqual(markOf("hero", -5, { box: { x: 0, y: 0, width: 9, height: 9 } }), {
    name: "hero",
    t: 0,
    windowBox: { x: 0, y: 0, width: 9, height: 9 },
  });
  assert.throws(() => markOf("x", 1, { cue: "boom" }), /--cue/);
  assert.deepEqual(
    withMarkCues(
      [{ t: 50, kind: "key" }],
      [
        { name: "a", t: 10, cue: "arrive" },
        { name: "b", t: 99 },
      ],
    ),
    [
      { t: 10, kind: "arrive" },
      { t: 50, kind: "key" },
    ],
  );
});

test("a chat is finished only once it stopped working with a completion, or after working", () => {
  assert.equal(chatFinished(undefined, true), false);
  assert.equal(chatFinished({ chatId: "c", working: true, completionId: "x" }, true), false);
  // Ready but never run: not finished (the old status === "ready" check said it was).
  assert.equal(chatFinished({ chatId: "c", working: false, completionId: null }, false), false);
  assert.equal(chatFinished({ chatId: "c", working: false, completionId: null }, true), true);
  assert.equal(chatFinished({ chatId: "c", working: false, completionId: "x" }, false), true);
});

test("until polls a real condition and times out with what it waited for", async () => {
  let calls = 0;
  await until(async () => ++calls >= 3, 2_000, "three", 5);
  assert.equal(calls, 3);
  await assert.rejects(
    until(async () => false, 30, "#never", 5),
    /#never/,
  );
  await assert.rejects(
    until(
      async () => {
        throw new Error("x");
      },
      20,
      "a throw",
      5,
    ),
    /a throw/,
  );
});

test("record help documents mark, wait, run, --no-mouse and --browser", () => {
  const help = aeonCommands({}).find((command) => command.name === "record").help;
  for (const word of [
    "record mark",
    "record wait",
    "record run",
    "--no-mouse",
    "--browser",
    "--cue",
  ])
    assert.ok(help.includes(word), word);
});

test(
  "record start --no-mouse, mark and stop merge marks and their cues into events.json",
  { skip: process.platform === "win32" ? "the fake ffmpeg is a /bin/sh script" : false },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "aeon-record-mark-"));
    try {
      const { ffmpeg, ffprobe } = fakeFfmpeg(home);
      const folder = join(home, "rec");
      const env = {
        ...process.env,
        AEON_DATA_DIR: join(home, "data"),
        AEON_FFMPEG: ffmpeg,
        AEON_FFPROBE: ffprobe,
      };
      const aeon = (args) => run(process.execPath, [cli, ...args], { env });
      await aeon(["record", "start", "--screen", "--no-mouse", "--out", folder]);
      const state = JSON.parse(readFileSync(join(folder, ".recording.json"), "utf8"));
      assert.equal(state.noMouse, true);
      const marked = await aeon([
        "record",
        "mark",
        "hero",
        "--box",
        "0,0,640,360",
        "--cue",
        "shutter",
        "--label",
        "Hero",
        "--out",
        folder,
      ]);
      assert.match(marked.stdout, /Marked hero at/);
      await aeon(["record", "mark", "end", "--out", folder]);
      await aeon(["record", "stop", "--out", folder]);
      const events = JSON.parse(readFileSync(join(folder, "events.json"), "utf8"));
      assert.deepEqual(
        events.marks.map((m) => m.name),
        ["hero", "end"],
      );
      assert.deepEqual(events.marks[0].windowBox, { x: 0, y: 0, width: 640, height: 360 });
      assert.equal(events.marks[0].label, "Hero");
      assert.ok(events.marks[1].t >= events.marks[0].t);
      assert.deepEqual(events.soundCues, [{ t: events.marks[0].t, kind: "shutter" }]);
      await assert.rejects(
        aeon(["record", "mark", "late", "--out", folder]),
        /No active recording/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
