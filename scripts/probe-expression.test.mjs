import assert from "node:assert/strict";
import test from "node:test";
import { pageValue } from "./probe-browser-control-cft-browser.mjs";
import { toolEvidenceSummary, panelToolEvidenceSummary } from "./probe-slice8-e2e-helpers.mjs";
import { isSidePanelTarget } from "./probe-side-panel-targets.mjs";

test("CDP rejects an expression factory before sending a malformed request", async () => {
  let sent = false;
  await assert.rejects(
    pageValue(
      async () => {
        sent = true;
      },
      "session",
      toolEvidenceSummary,
    ),
    /CDP expression must be a nonempty string/,
  );
  assert.equal(sent, false);
});

test("full-chat and panel evidence factories produce executable CDP strings", async () => {
  for (const expression of [toolEvidenceSummary(), panelToolEvidenceSummary()]) {
    assert.equal(typeof expression, "string");
    new Function(`return ${expression}`);
    const value = await pageValue(
      async (method, params) => {
        assert.equal(method, "Runtime.evaluate");
        assert.equal(params.expression, expression);
        return { result: { value: { staleReference: true, ambiguousTarget: true } } };
      },
      "session",
      expression,
    );
    assert.equal(value.staleReference, true);
    assert.equal(value.ambiguousTarget, true);
  }
});

test("side-panel target matching ignores URL query and fragment", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  assert.equal(
    isSidePanelTarget(
      { url: `chrome-extension://${extensionId}/sidepanel.html?tab=1#panel` },
      extensionId,
    ),
    true,
  );
  assert.equal(
    isSidePanelTarget({ url: `chrome-extension://${extensionId}/chat.html` }, extensionId),
    false,
  );
  assert.equal(
    isSidePanelTarget({ url: "https://example.test/sidepanel.html" }, extensionId),
    false,
  );
});
