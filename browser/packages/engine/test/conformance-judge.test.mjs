// Browser-free self-tests for the conformance sweep's judge: the normalizer scrubs only what
// varies between runs, a pinned divergence tolerates exactly its own failure, and a pin that no
// longer fails (a stale pin) fails the sweep.
import assert from "node:assert/strict";
import test from "node:test";
import { diffValues, normalize, scrubString } from "./conformance/normalize.mjs";
import { goldenDiff, judge, pinMatches } from "./conformance/run.mjs";
import { divergences } from "./conformance/divergences.mjs";
import { decodePng } from "./conformance/png.mjs";
import { solidPng } from "./conformance/sites.mjs";

const context = {
  primary: "http://127.0.0.1:4321",
  cross: "http://localhost:4321",
  files: ["/tmp/run-x"],
};

test("normalize scrubs origins, roots, times, bytes, ids and boundaries but keeps the rest", () => {
  const raw = {
    url: "http://127.0.0.1:4321/app",
    frame: "http://localhost:4321/frames/cross",
    file: "/tmp/run-x/downloads/report.txt",
    error: "TIMEOUT: no answer in 2500 ms on tab 99123 (127.0.0.1:4321/app)",
    ms: 812,
    size: 208,
    requests: [
      { id: 77, status: 201 },
      { id: 12, status: 302 },
      { id: 77, status: 201 },
    ],
    body: "------WebKitFormBoundaryAbC123\r\ncontent",
    status: 200,
  };
  assert.deepEqual(normalize(raw, context), {
    body: "<BOUNDARY>\r\ncontent",
    error: "TIMEOUT: no answer in <TIME> on tab <TAB> (PRIMARY/app)",
    file: "<FILES>/downloads/report.txt",
    frame: "CROSS/frames/cross",
    ms: "<TIME>",
    requests: [
      { id: "#1", status: 201 },
      { id: "#2", status: 302 },
      { id: "#1", status: 201 },
    ],
    size: "<BYTES>",
    status: 200,
    url: "PRIMARY/app",
  });
});

test("normalize rejects a zero byte count instead of hiding it", () => {
  assert.throws(() => normalize({ bytes: 0 }, context), /expected more than 0/);
});

test("snapshot text, refs and messages stay strict", () => {
  assert.equal(
    scrubString('[f2:e1] button "Cross" level 3', context),
    '[f2:e1] button "Cross" level 3',
  );
  assert.deepEqual(diffValues({ a: [1, "x"] }, { a: [1, "y"] }), [
    { pointer: "/a/1", expected: "x", actual: "y" },
  ]);
});

test("the PNG reader reads back the fixture's own image", () => {
  const image = decodePng(solidPng(4, 3, [10, 20, 30]));
  assert.deepEqual([image.width, image.height, image.pixel(3, 2)], [4, 3, [10, 20, 30]]);
});

const golden = {
  scenario: "s",
  steps: [
    { step: "a", kind: "ok", result: "fine" },
    { step: "b", kind: "ok", result: 1 },
  ],
};
const result = (steps, expectations = []) => ({
  scenario: "s",
  ms: 10,
  transcript: { scenario: "s", steps },
  expectations,
});

test("a run equal to its golden with no pins is clean", () => {
  const { problems } = judge({
    results: [result(golden.steps)],
    goldens: { s: golden },
    divergences: [],
  });
  assert.deepEqual(problems, []);
});

test("an unpinned golden difference fails, and the exact pin tolerates it", () => {
  const changed = [golden.steps[0], { step: "b", kind: "ok", result: 2 }];
  const unpinned = judge({ results: [result(changed)], goldens: { s: golden }, divergences: [] });
  assert.deepEqual(
    unpinned.problems.map((p) => [p.kind, p.step, p.pointer]),
    [["unpinned", "b", "/result"]],
  );
  const pin = { scenario: "s", step: "b", pointer: "/result", kind: "Bug", expected: 1, note: "" };
  assert.deepEqual(
    judge({ results: [result(changed)], goldens: { s: golden }, divergences: [pin] }).problems,
    [],
  );
  const wrongPointer = { ...pin, pointer: "/result/x" };
  const off = judge({
    results: [result(changed)],
    goldens: { s: golden },
    divergences: [wrongPointer],
  });
  assert.deepEqual(off.problems.map((p) => p.kind).sort(), ["stale-pin", "unpinned"]);
});

test("a stale pin, one whose failure no longer occurs, fails the sweep", () => {
  const pin = {
    scenario: "s",
    step: "a",
    pointer: "",
    kind: "Bug",
    expected: "x",
    note: "fixed now",
  };
  const { problems } = judge({
    results: [result(golden.steps)],
    goldens: { s: golden },
    divergences: [pin],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "stale-pin");
  assert.match(problems[0].message, /remove the pin/);
});

test("an expectation failure must be pinned, and its pin is not stale while it fails", () => {
  const failing = result(golden.steps, [
    { scenario: "s", step: "a", pointer: "", expected: "x", actual: "y" },
  ]);
  assert.equal(
    judge({ results: [failing], goldens: { s: golden }, divergences: [] }).problems[0].kind,
    "unpinned",
  );
  const pin = { scenario: "s", step: "a", pointer: "", kind: "Bug", expected: "x", note: "" };
  assert.deepEqual(
    judge({ results: [failing], goldens: { s: golden }, divergences: [pin] }).problems,
    [],
  );
});

test("pins for scenarios that did not run are not stale; intermittent pins never are", () => {
  const other = {
    scenario: "elsewhere",
    step: "a",
    pointer: "",
    kind: "Bug",
    expected: "",
    note: "",
  };
  const race = {
    scenario: "s",
    step: "a",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "",
    note: "",
  };
  assert.deepEqual(
    judge({ results: [result(golden.steps)], goldens: { s: golden }, divergences: [other, race] })
      .problems,
    [],
  );
  assert.equal(pinMatches(race, { scenario: "s", step: "a", pointer: "/result/3" }), true);
  assert.equal(
    pinMatches(
      { ...race, intermittent: false },
      { scenario: "s", step: "a", pointer: "/result/3" },
    ),
    false,
  );
});

test("missing, added and removed steps are differences", () => {
  assert.deepEqual(
    goldenDiff(golden, { steps: [golden.steps[0], { step: "c", kind: "ok", result: 0 }] }).map(
      (d) => [d.step, d.pointer],
    ),
    [
      ["c", "/step"],
      ["b", "/step"],
    ],
  );
  const { problems } = judge({ results: [result(golden.steps)], goldens: {}, divergences: [] });
  assert.equal(problems[0].kind, "golden");
});

test("every committed pin is well formed and unique", () => {
  const keys = new Set();
  for (const pin of divergences) {
    assert.ok(["Bug", "Unsupported"].includes(pin.kind), `${pin.scenario}/${pin.step} kind`);
    assert.equal(typeof pin.expected, "string");
    assert.equal(typeof pin.note, "string");
    assert.ok(
      pin.intermittent ? pin.pointer === "*" : pin.pointer !== "*",
      `${pin.scenario}/${pin.step} pointer`,
    );
    const key = `${pin.scenario}/${pin.step}/${pin.pointer}`;
    assert.ok(!keys.has(key), `duplicate pin ${key}`);
    keys.add(key);
  }
});
