// A recording browser's saved display and DPR fill in only what the caller did not set.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { displayLive, recordingEnv, savedBrowser } from "../dist/record-browsers.js";

const live = () => true;
const dead = () => false;

test("--display wins; the saved display fills in a missing DISPLAY when its socket is live", () => {
  const saved = { display: ":120", dpr: 2 };
  assert.deepEqual(recordingEnv(":7", saved, { DISPLAY: ":20" }, live), {
    DISPLAY: ":7",
    GRAFT_RECORDING_DPR: "2",
  });
  assert.deepEqual(recordingEnv(undefined, saved, {}, live), {
    DISPLAY: ":120",
    GRAFT_RECORDING_DPR: "2",
  });
  assert.deepEqual(recordingEnv(undefined, saved, { DISPLAY: ":20" }, live), {
    GRAFT_RECORDING_DPR: "2",
  });
  assert.deepEqual(recordingEnv(undefined, saved, { GRAFT_RECORDING_DPR: "3" }, dead), {});
  assert.deepEqual(recordingEnv(undefined, undefined, {}, live), {});
});

test("a local display is live by its X socket; a remote one is trusted", () => {
  const seen = [];
  assert.equal(
    displayLive(":120.0", (p) => (seen.push(p), true)),
    true,
  );
  assert.deepEqual(seen, ["/tmp/.X11-unix/X120"]);
  assert.equal(displayLive(":5", dead), false);
  assert.equal(displayLive("host:0", dead), true);
});

test("browsers.json is read per name and tolerates a missing or broken file", () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-browsers-"));
  const file = join(dir, "browsers.json");
  assert.equal(savedBrowser("recording", file), undefined);
  writeFileSync(file, "{oops");
  assert.equal(savedBrowser("recording", file), undefined);
  writeFileSync(file, JSON.stringify({ recording: { display: ":120", dpr: 2 } }));
  assert.deepEqual(savedBrowser("recording", file), { display: ":120", dpr: 2 });
  assert.equal(savedBrowser("other", file), undefined);
});
