import assert from "node:assert/strict";
import test from "node:test";
import { browserSpeedApi } from "../packages/engine/dist/code-api-speed.js";

// The speed tips read what cells did (sites touched, steps, time), so they fire on the same
// facts every time: two sites worked one after another, or five tiny cells in a row. Each shows
// once; a cell that works several sites at once means the work is already parallel.

function realm() {
  return new Function(
    browserSpeedApi + "\nreturn {__speedBegin, __speedNote, __speedEnd, __speedTip};",
  )();
}

function cell(api, urls, { actions = 2 } = {}) {
  api.__speedBegin();
  for (const [index, url] of urls.entries()) api.__speedNote(url, index < actions);
  api.__speedEnd();
  return api.__speedTip();
}

test("two sites worked one after another get the parallel tip, once", () => {
  const api = realm();
  assert.equal(cell(api, ["https://www.alpha.test/a", "https://alpha.test/b"]), "");
  assert.equal(cell(api, ["https://alpha.test/c", "https://alpha.test/d"]), "");
  assert.equal(cell(api, ["https://beta.test/a", "https://beta.test/b"]), "");
  const tip = cell(api, ["https://beta.test/c", "https://beta.test/d"]);
  assert.match(tip, /^alpha\.test and beta\.test were worked one after another \(4 cells/);
  assert.match(tip, /help\('parallel'\)/);
  assert.equal(cell(api, ["https://gamma.test/a", "https://gamma.test/b"]), "");
  assert.equal(cell(api, ["https://gamma.test/c", "https://gamma.test/d"]), "", "shown once");
});

test("a cell across several sites at once resets the serial count", () => {
  const api = realm();
  cell(api, ["https://alpha.test/a", "https://alpha.test/b"]);
  cell(api, ["https://alpha.test/c", "https://alpha.test/d"]);
  cell(api, ["https://alpha.test/e", "https://beta.test/a"]);
  cell(api, ["https://beta.test/b", "https://beta.test/c"]);
  assert.equal(cell(api, ["https://beta.test/d", "https://beta.test/e"]), "");
});

test("one quick visit to a site (a search page) does not count as working it", () => {
  const api = realm();
  cell(api, ["https://search.test/q", "https://search.test/r"]);
  cell(api, ["https://alpha.test/a", "https://alpha.test/b"]);
  cell(api, ["https://alpha.test/c", "https://alpha.test/d"]);
  assert.equal(cell(api, ["https://beta.test/a", "https://beta.test/b"]), "");
});

test("five tiny cells in a row get the batching tip; cells with no steps do not count", () => {
  const api = realm();
  for (let index = 0; index < 4; index++)
    assert.equal(cell(api, ["https://alpha.test/" + index], { actions: 1 }), "");
  api.__speedBegin();
  api.__speedEnd();
  assert.equal(api.__speedTip(), "", "a cell with no steps (help, maths) breaks the run");
  for (let index = 0; index < 4; index++)
    cell(api, ["https://alpha.test/" + index], { actions: 1 });
  assert.match(
    cell(api, ["https://alpha.test/x"], { actions: 1 }),
    /^the last 5 cells each did one quick step/,
  );
});

test("non-web pages and bad URLs are ignored", () => {
  const api = realm();
  api.__speedBegin();
  api.__speedNote("chrome://extensions", true);
  api.__speedNote("not a url", true);
  api.__speedNote(undefined, false);
  api.__speedEnd();
  assert.equal(api.__speedTip(), "");
});
