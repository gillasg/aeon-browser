import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  avfoundationScreenIndex,
  captureArgs,
  gdigrabInput,
  macScreenDevice,
  windowsChromeTitle,
} from "../dist/record-capture.js";
import { tabClips } from "../dist/record-events.js";
import { saveTabTakes, takeExtension } from "../dist/record-takes.js";

function fakeBrowser(takes) {
  const calls = [];
  const run = async (code) => {
    const request = JSON.parse(/__call\((.*)\)$/.exec(code)[1]);
    calls.push(request);
    const take = takes[request.tabId];
    if (!take) throw new Error("INVALID_INPUT: no take for that tab");
    if (request.takes === "stop") return { stopped: take.stopped };
    if (request.takes === "read") {
      const bytes = take.data.subarray(request.offset, request.offset + 4);
      return { base64: bytes.toString("base64") };
    }
    return { dropped: true };
  };
  return { run, calls };
}

test("stop --tabs copies each recorded take into takes/ with its real metadata", async () => {
  const folder = await mkdtemp(join(tmpdir(), "graft-takes-"));
  try {
    const data = Buffer.from("0123456789");
    const { run, calls } = fakeBrowser({
      7: {
        data,
        stopped: {
          bytes: data.length,
          mimeType: "video/mp4",
          ms: 2500.4,
          firstFrameAt: 1_000_500,
          width: 1280,
          height: 720,
          frames: { received: 80, drawn: 75 },
        },
      },
    });
    const takes = await saveTabTakes(run, folder, [7, 9]);
    assert.deepEqual([...takes.keys()], [7]);
    assert.deepEqual(takes.get(7), {
      file: "takes/7.mp4",
      width: 1280,
      height: 720,
      startedAt: 1_000_500,
      durationMs: 2500,
      frames: 75,
    });
    assert.equal(readFileSync(join(folder, "takes/7.mp4"), "utf8"), "0123456789");
    assert.ok(calls.some((call) => call.takes === "drop" && call.tabId === 7));
    const recording = {
      file: "takes/",
      source: "tabs",
      width: 0,
      height: 0,
      fps: 30,
      startedAt: 1_000_000,
      durationMs: 0,
      frames: 0,
    };
    const clips = tabClips([], recording, [7, 9], takes);
    assert.equal(clips[0].file, "takes/7.mp4");
    assert.equal(clips[0].width, 1280);
    assert.equal(clips[0].startedAt, 1_000_500);
    // A tab without a take keeps the recording's clock.
    assert.equal(clips[1].file, "takes/9.webm");
    assert.equal(clips[1].startedAt, 1_000_000);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a take that cannot be read whole is not left half-written", async () => {
  const folder = await mkdtemp(join(tmpdir(), "graft-takes-"));
  try {
    const { run } = fakeBrowser({
      3: { data: Buffer.from("abc"), stopped: { bytes: 10, mimeType: "video/webm" } },
    });
    const takes = await saveTabTakes(run, folder, [3]);
    assert.equal(takes.size, 0);
    assert.equal(existsSync(join(folder, "takes/3.webm")), false);
    assert.equal(takeExtension("video/webm;codecs=vp9"), "webm");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("gdigrab uses desktop or an exact title=, never window_exe", () => {
  assert.equal(gdigrabInput("screen", "x - Google Chrome"), "desktop");
  assert.equal(gdigrabInput("window", "Inbox - Google Chrome"), "title=Inbox - Google Chrome");
  assert.equal(gdigrabInput("window", undefined), "desktop");
  assert.equal(
    windowsChromeTitle({ GRAFT_CHROME_TITLE: " Docs - Google Chrome " }),
    "Docs - Google Chrome",
  );
  const state = {
    version: 1,
    source: "window",
    folder: "/r",
    fps: 30,
    startedAt: 0,
    ffmpeg: "ffmpeg",
    frames: 0,
  };
  const args = captureArgs({ ...state, input: "title=Inbox - Google Chrome" }, "/r", "win32");
  assert.equal(args[args.indexOf("-i") + 1], "title=Inbox - Google Chrome");
  assert.ok(args.includes("gdigrab"));
  assert.ok(!args.join(" ").includes("window_exe"));
  const screen = captureArgs({ ...state, source: "screen" }, "/r", "win32");
  assert.equal(screen[screen.indexOf("-i") + 1], "desktop");
});

test("avfoundation finds the screen device or honors GRAFT_MAC_SCREEN_DEVICE", () => {
  const listing = [
    "[AVFoundation indev @ 0x1] AVFoundation video devices:",
    "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera",
    "[AVFoundation indev @ 0x1] [2] Capture screen 0",
  ].join("\n");
  assert.equal(avfoundationScreenIndex(listing), "2");
  assert.equal(avfoundationScreenIndex("[0] FaceTime HD Camera"), undefined);
  assert.equal(macScreenDevice("ffmpeg", { GRAFT_MAC_SCREEN_DEVICE: "3" }), "3:none");
  assert.equal(macScreenDevice("ffmpeg", { GRAFT_MAC_SCREEN_DEVICE: "4:0" }), "4:0");
  const state = {
    version: 1,
    source: "screen",
    folder: "/r",
    fps: 30,
    startedAt: 0,
    ffmpeg: "ffmpeg",
    frames: 0,
    input: "2:none",
  };
  const args = captureArgs(state, "/r", "darwin");
  assert.equal(args[args.indexOf("-i") + 1], "2:none");
});
