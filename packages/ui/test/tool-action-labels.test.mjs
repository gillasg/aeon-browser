import assert from "node:assert/strict";
import test from "node:test";
import { describeToolAction } from "../dist/chat-activity-summary.js";

const cell = (code, state = "done") => ({ toolName: "browser_code", arguments: { code }, state });

test("browser_code steps are named by what the code does, not 'Use browser'", () => {
  assert.equal(
    describeToolAction(cell("await browser.boosts.save({name: 'x'})")),
    "Saved a site boost",
  );
  assert.equal(
    describeToolAction(
      cell("page = await browser.openTab('https://www.amazon.in/s?k=x')", "running"),
    ),
    "Opening amazon.in",
  );
  assert.equal(
    describeToolAction(
      cell("await page.batch([{action: 'fill', target: {label: 'Email'}, value: 'a'}])"),
    ),
    "Filled in the form",
  );
  assert.equal(
    describeToolAction(cell("await page.getByRole('button').click()")),
    "Worked in the page",
  );
  assert.equal(describeToolAction(cell("return 1 + 1")), "Working in the page");
});
