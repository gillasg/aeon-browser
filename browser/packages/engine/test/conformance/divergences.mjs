// Known divergences between what Aeon's engine does today and what the sweep expects. Each pin
// names one failing leaf exactly: {scenario, step, pointer} plus its kind ('Bug' for an engine
// bug to fix, 'Unsupported' for something the engine deliberately does not do), the behaviour
// the sweep expects and a note. A pin only tolerates that exact failure, and a pin that no
// longer fails is stale and fails the sweep, so a fix lands together with removing its pin.
// pointer "" is the step's own expectation; any other pointer is a leaf of its golden record.
// A race that fails on some runs only is pinned with `intermittent: true` and pointer "*": it
// covers that whole step and is never reported stale, so its fix needs repeated green runs.

export const TESTED_WITH = "Chrome for Testing 157.0.8103.78";

export const divergences = [
  {
    scenario: "app",
    step: "fill-covered-force",
    pointer: "",
    kind: "Bug",
    expected: "fill with {force: true} writes a covered text field",
    note: "force is ignored: the cover check still refuses the fill with TARGET_BLOCKED",
  },
  {
    scenario: "app",
    step: "click-covered-fast",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "a click on a covered element fails within its {timeout} (2 s here)",
    note: "the covered click can wait out the full actionability window (~6-10 s) before failing; timing-dependent, so on a fast idle host it fails in time and on a loaded one it does not",
  },
  {
    scenario: "app",
    step: "fill-remount",
    pointer: "",
    kind: "Bug",
    expected: "a field the page replaces on focus is re-resolved and written before the deadline",
    note: "fill types into the detached node and fails with INPUT_FAILED",
  },
  {
    scenario: "frames",
    step: "click-same-text",
    pointer: "",
    kind: "Bug",
    expected: "a text= locator reaches a button inside a same-origin iframe, as the snapshot does",
    note: "text locators search only the top document: TARGET_NOT_FOUND",
  },
  {
    scenario: "frames",
    step: "click-cross-text",
    pointer: "",
    kind: "Bug",
    expected: "a text= locator reaches a button inside a cross-origin (out-of-process) iframe",
    note: "text locators search only the top document: TARGET_NOT_FOUND",
  },
  {
    scenario: "hangs",
    step: "gate-pending-bounded",
    pointer: "",
    kind: "Bug",
    expected: "goto with {timeout: 1500} to a page that never answers returns within its timeout",
    note: "the navigation runs several seconds past its own timeout before answering",
  },
  {
    scenario: "visual",
    step: "screenshot-png",
    pointer: "",
    kind: "Bug",
    expected: "page.screenshot({format: 'png'}) saves a PNG",
    note: "the format option is ignored and a JPEG is saved",
  },

  {
    scenario: "network",
    step: "captured",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "capture lists every request the page made, matching the fixture's request log",
    note: "redirect hops, worker requests and the cross-origin frame's own fetch are missing; the frame document itself is captured only on some runs (out-of-process frame startup race)",
  },
  {
    scenario: "network",
    step: "cross-frame-first-request",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "the cross-origin iframe's first request is always captured",
    note: "captured only when the network session attaches before the frame starts",
  },
  {
    scenario: "frames",
    step: "snapshot",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "a snapshot of nested cross-origin frames always succeeds",
    note: "some runs fail with CHROME_ERROR: Maximum call stack size exceeded",
  },
  {
    scenario: "frames",
    step: "click-cross-ref",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "the cross-origin frame's ref from the snapshot clicks",
    note: "STALE_REF whenever the snapshot before it failed",
  },
  {
    scenario: "upload",
    step: "submit",
    pointer: "*",
    intermittent: true,
    kind: "Bug",
    expected: "a click that submits a form and loads the response reports outcome 'navigated'",
    note: "some runs report 'unchanged' because the outcome is read before the navigation commits",
  },

  {
    scenario: "network",
    step: "redirect-hops-match-log",
    pointer: "",
    kind: "Bug",
    expected: "capture records each redirect hop (/r/1 302, /r/2 302) the server saw",
    note: "only the final /landed response is listed; the hops are dropped",
  },
  {
    scenario: "network",
    step: "worker-request-captured",
    pointer: "",
    kind: "Bug",
    expected: "a dedicated worker's fetch is captured for its page",
    note: "worker requests never appear in page.network.list()",
  },
  {
    scenario: "network",
    step: "cross-frame-fetch-captured",
    pointer: "",
    kind: "Bug",
    expected: "a fetch made by a cross-origin (out-of-process) iframe is captured",
    note: "the frame's own fetch to /api/frame is missing although the server logged it",
  },
];
