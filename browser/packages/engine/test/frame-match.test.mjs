// page.frame() and page.batch {frame} pick one frame: an exact frameKey/frameId from
// page.frames() first, about:srcdoc frames by 'srcdoc', and duplicate-URL frames kept apart.
import assert from "node:assert/strict";
import test from "node:test";
import { browserCapabilityApi } from "../dist/code-api-hooks.js";

const start = browserCapabilityApi.indexOf("function __matchFrame(");
const end = browserCapabilityApi.indexOf("\nfunction ", start + 1);
const matchFrame = new Function(
  `${browserCapabilityApi.slice(start, end)}\nreturn __matchFrame;`,
)();

const frame = (frameId, url, name) => ({ frameId, frameKey: `${frameId}:L${frameId}`, url, name });
const list = [
  frame("main", "https://app.test/"),
  frame("A", "https://sandbox.test/run", "preview"),
  frame("B", "https://sandbox.test/run"),
  frame("C", "about:srcdoc"),
];

test("an exact frameKey or frameId from page.frames() wins over a URL match", () => {
  assert.equal(matchFrame(list, "B:LB").frameId, "B");
  assert.equal(matchFrame(list, "B").frameId, "B");
  assert.equal(matchFrame(list, { frameKey: "B:LB" }).frameId, "B");
  assert.equal(matchFrame(list, { frameId: "B" }).frameId, "B");
  assert.equal(matchFrame(list, list[2]).frameId, "B");
  assert.equal(matchFrame(list, { frameId: "gone" }), undefined);
});

test("duplicate URLs: the substring keeps the first, an index picks among them", () => {
  assert.equal(matchFrame(list, "sandbox.test").frameId, "A");
  assert.equal(matchFrame(list, { url: "sandbox.test", index: 1 }).frameId, "B");
});

test("about:srcdoc frames are addressable, and two are named as ambiguous", () => {
  assert.equal(matchFrame(list, "srcdoc").frameId, "C");
  assert.equal(matchFrame(list, "about:srcdoc").frameId, "C");
  const two = [...list, frame("D", "about:srcdoc")];
  assert.throws(
    () => matchFrame(two, "srcdoc"),
    /FRAME_AMBIGUOUS: 2 about:srcdoc frames.*C:LC, D:LD/,
  );
  assert.equal(matchFrame(two, { url: "about:srcdoc", index: 1 }).frameId, "D");
  assert.equal(matchFrame(two, "D:LD").frameId, "D");
});

test("index, name and url matching stay as they were", () => {
  assert.equal(matchFrame(list, 0).frameId, "main");
  assert.equal(matchFrame(list, 3).frameId, "C");
  assert.equal(matchFrame(list, "preview").frameId, "A");
  assert.equal(matchFrame(list, { name: "preview" }).frameId, "A");
  assert.equal(matchFrame(list, { url: "app.test" }).frameId, "main");
  assert.equal(matchFrame(list, { index: 2 }).frameId, "B");
  assert.equal(matchFrame(list, { url: "nowhere", index: 1 }).frameId, "A");
  assert.equal(matchFrame(list, "nowhere"), undefined);
});
