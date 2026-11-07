import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";
import {
  BATCH_NUDGE,
  cellBehaviour,
  forgetBatchStreak,
  noteBrowserCell,
  STREAK_GAP_MS,
} from "../dist/batch-nudge.js";

// A live nudge, not a tip after the run: the third cell in a row that did one quick step (or
// only read) tells the agent to put the next steps in one cell, and every third after that. A
// multi-step cell or a minute's pause starts the count again, and an error never carries it.

const read = { action: { op: "observe" } };
const click = { action: { op: "click" } };
const fill = { action: { op: "fill" } };
const handoff = { action: { op: "handoff" } };

test("the third tiny cell in a row is nudged, and every third after", () => {
  forgetBatchStreak("chat-a");
  const at = 1_000_000;
  const nudged = (offset) => noteBrowserCell("chat-a", cellBehaviour([click]), at + offset);
  assert.equal(nudged(0), undefined);
  assert.equal(nudged(1000), undefined);
  assert.equal(nudged(2000), BATCH_NUDGE);
  assert.equal(nudged(3000), undefined);
  assert.equal(nudged(4000), undefined);
  assert.equal(nudged(5000), BATCH_NUDGE);
});

test("cells that only read count toward the run", () => {
  forgetBatchStreak("chat-b");
  assert.equal(noteBrowserCell("chat-b", cellBehaviour([read])), undefined);
  assert.equal(noteBrowserCell("chat-b", cellBehaviour([read, read])), undefined);
  assert.equal(noteBrowserCell("chat-b", cellBehaviour([read])), BATCH_NUDGE);
});

test("a cell with several steps starts the count again", () => {
  forgetBatchStreak("chat-c");
  noteBrowserCell("chat-c", cellBehaviour([click]));
  noteBrowserCell("chat-c", cellBehaviour([click]));
  assert.equal(noteBrowserCell("chat-c", cellBehaviour([click, fill, click])), undefined);
  assert.equal(noteBrowserCell("chat-c", cellBehaviour([click])), undefined);
  assert.equal(noteBrowserCell("chat-c", cellBehaviour([click])), undefined);
  assert.equal(noteBrowserCell("chat-c", cellBehaviour([click])), BATCH_NUDGE);
});

test("a hand-off is never tiny and ends the run", () => {
  forgetBatchStreak("chat-d");
  noteBrowserCell("chat-d", cellBehaviour([click]));
  noteBrowserCell("chat-d", cellBehaviour([click]));
  assert.equal(noteBrowserCell("chat-d", cellBehaviour([handoff])), undefined);
  assert.equal(noteBrowserCell("chat-d", cellBehaviour([click])), undefined);
  assert.equal(noteBrowserCell("chat-d", cellBehaviour([click])), undefined);
  assert.equal(noteBrowserCell("chat-d", cellBehaviour([click])), BATCH_NUDGE);
});

test("a cell with no browser work neither counts nor breaks the run", () => {
  forgetBatchStreak("chat-e");
  noteBrowserCell("chat-e", cellBehaviour([click]));
  noteBrowserCell("chat-e", cellBehaviour([click]));
  assert.equal(noteBrowserCell("chat-e", cellBehaviour([])), undefined);
  assert.equal(noteBrowserCell("chat-e", cellBehaviour([click])), BATCH_NUDGE);
});

test("a pause over a minute starts a new run", () => {
  forgetBatchStreak("chat-f");
  const at = 1_000_000;
  noteBrowserCell("chat-f", cellBehaviour([click]), at);
  noteBrowserCell("chat-f", cellBehaviour([click]), at + 1000);
  // The agent comes back later: this is the first cell of a new run.
  const later = at + STREAK_GAP_MS + 5000;
  assert.equal(noteBrowserCell("chat-f", cellBehaviour([click]), later), undefined);
  assert.equal(noteBrowserCell("chat-f", cellBehaviour([click]), later + 1000), undefined);
  assert.equal(noteBrowserCell("chat-f", cellBehaviour([click]), later + 2000), BATCH_NUDGE);
});

test("chats keep separate runs", () => {
  forgetBatchStreak("chat-g");
  forgetBatchStreak("chat-h");
  noteBrowserCell("chat-g", cellBehaviour([click]));
  noteBrowserCell("chat-h", cellBehaviour([click]));
  noteBrowserCell("chat-g", cellBehaviour([click]));
  noteBrowserCell("chat-h", cellBehaviour([click]));
  assert.equal(noteBrowserCell("chat-g", cellBehaviour([click])), BATCH_NUDGE);
  assert.equal(noteBrowserCell("chat-h", cellBehaviour([click])), BATCH_NUDGE);
});

test("a cell's hint reaches the model on the third cell, and never on an error", async () => {
  const chatId = "chat-result-nudge";
  forgetBatchStreak(chatId);
  const tool = createBrowserCodeTool(chatId, async () =>
    JSON.stringify({
      output: "",
      steps: [
        {
          index: 0,
          action: { op: "click", target: { tabId: 41 }, element: { backendNodeId: 648 } },
          disposition: "completed",
          result: { kind: "action", outcome: "changed" },
        },
      ],
    }),
  );
  const run = () => tool.execute("call", { code: "await page.click(648)" }, undefined, undefined);
  assert.doesNotMatch((await run()).content[0].text, /hint:/);
  assert.doesNotMatch((await run()).content[0].text, /hint:/);
  const third = await run();
  assert.match(third.content[0].text, /hint: Three cells in a row did one quick step each/);
  // The nudge is the last line, after the steps and output the model reads.
  assert.ok(third.content[0].text.trimEnd().endsWith(BATCH_NUDGE));

  // A failed cell is skipped: the streak is where it was, and the error carries no hint.
  const failing = createBrowserCodeTool(chatId, async () =>
    JSON.stringify({ output: "", error: "CODE_ERROR: boom", steps: [] }),
  );
  const failed = await failing.execute("call", { code: "throw Error('boom')" });
  assert.doesNotMatch(failed.content[0].text, /Three cells in a row/);
  const fourth = await tool.execute("call", { code: "await page.click(648)" });
  assert.doesNotMatch(fourth.content[0].text, /hint:/, "the failed cell neither counted nor reset");
  const fifth = await tool.execute("call", { code: "await page.click(648)" });
  assert.doesNotMatch(fifth.content[0].text, /hint:/);
  const sixth = await tool.execute("call", { code: "await page.click(648)" });
  assert.match(sixth.content[0].text, /hint: Three cells in a row/);
});
