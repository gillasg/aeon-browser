import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";

const target = {
  clientInstanceId: "8ab3251b-027a-46ee-9234-473eb32fe6c2",
  browserRunId: "90ca6c9f-1e95-44ba-8bb4-705cec61e5e8",
  tabId: 41,
  tabIncarnation: "fc62115c-286f-47c7-a018-1ef92f81e8a1",
};

async function runCell(cell) {
  const tool = createBrowserCodeTool("chat-1", async () => JSON.stringify(cell));
  return tool.execute("call-1", { code: "x" }, undefined, undefined);
}

test("the model gets one line per step and the cell output, not the raw envelope", async () => {
  const result = await runCell({
    output: "Shop page",
    steps: [
      {
        index: 0,
        action: {
          op: "openTab",
          clientInstanceId: target.clientInstanceId,
          url: "https://a.test/",
        },
        disposition: "completed",
        result: { kind: "tab", tab: { target, url: "https://a.test/" } },
      },
      {
        index: 1,
        action: { op: "click", target, element: { kind: "backend", backendNodeId: 648 } },
        disposition: "failed",
        code: "TARGET_HIDDEN",
      },
      {
        result: {
          kind: "screenshot",
          screenshotId: "s",
          dataBase64: "AQID",
          mimeType: "image/png",
        },
      },
    ],
  });
  const text = result.content[0].text;
  assert.equal(
    text,
    "steps:\n- openTab https://a.test/ -> tab 41\n- click tab 41 648 FAILED TARGET_HIDDEN\noutput:\nShop page",
  );
  assert.doesNotMatch(text, /tabIncarnation|operationId/);
  assert.deepEqual(result.content[1], { type: "image", data: "AQID", mimeType: "image/png" });
});

test("errors and offline signals stay visible to the model", async () => {
  const failed = await runCell({ output: "", error: "p.title is not a function", steps: [] });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /error: p\.title is not a function/);
  assert.match(failed.content[0].text, /await help\(\) lists what browser code can do/);
  // A hint from the runtime's real API replaces the pointer.
  const hinted = await runCell({
    output: "",
    error: "page.playwright.click is not a function\nHint: there is no page.playwright",
    steps: [],
  });
  assert.match(hinted.content[0].text, /Hint: there is no page\.playwright/);
  assert.doesNotMatch(hinted.content[0].text, /await help\(\)/);
  const offline = await createBrowserCodeTool("chat-1").execute("c", { code: "x" });
  assert.match(offline.content[0].text, /BROWSER_OFFLINE/);
});
