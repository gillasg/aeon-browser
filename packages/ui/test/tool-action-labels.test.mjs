import assert from "node:assert/strict";
import test from "node:test";
import { describeToolAction } from "../dist/chat-activity-summary.js";

const cell = (code, state = "done") => ({ toolName: "browser_code", arguments: { code }, state });

test("browser_code steps use the engine label, and otherwise stay generic", () => {
  assert.equal(
    describeToolAction(cell("await browser.boosts.save({name: 'x'})")),
    "Worked in the page",
  );
  assert.equal(
    describeToolAction(
      cell("page = await browser.openTab('https://www.amazon.in/s?k=x')", "running"),
    ),
    "Working in the page",
  );
  assert.equal(
    describeToolAction(
      cell("await page.batch([{action: 'fill', target: {label: 'Email'}, value: 'a'}])"),
    ),
    "Worked in the page",
  );
  assert.equal(
    describeToolAction(cell("await page.getByRole('button').click()")),
    "Worked in the page",
  );
  assert.equal(describeToolAction(cell("return 1 + 1")), "Worked in the page");
  assert.equal(
    describeToolAction({
      ...cell("await page.click('#pay')", "running"),
      stepLabel: "Click “Place order”",
    }),
    "Click “Place order”",
  );
});
