// record stop: a stuttering take fails by default; --allow-stutter keeps it with a warning.
import assert from "node:assert/strict";
import test from "node:test";
import { stutterVerdict } from "../dist/record-truth.js";

const smooth = { frames: 1000, dropped: 1, dup: 2 };
const choppy = { frames: 1000, dropped: 30, dup: 10 };

test("a smooth take passes either way", () => {
  assert.deepEqual(stutterVerdict(smooth, false), { code: 0 });
  assert.deepEqual(stutterVerdict(smooth, true), { code: 0 });
});

test("a stuttering take is refused by default", () => {
  const verdict = stutterVerdict(choppy, false);
  assert.equal(verdict.code, 1);
  assert.match(verdict.message, /refused/);
});

test("--allow-stutter keeps the take and still reports the numbers", () => {
  const verdict = stutterVerdict(choppy, true);
  assert.equal(verdict.code, 0);
  assert.match(verdict.message, /^Warning: ffmpeg dropped 30 and duplicated 10 of 1000/);
  assert.match(verdict.message, /--allow-stutter/);
});
