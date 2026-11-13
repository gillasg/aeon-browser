// A fixture that allows the first 5 calls as the pacer's burst, then 429s when more than 2 of
// the later calls arrive in any 1s. The burst itself is exempt: it happens in the first
// milliseconds, so counting it in a later window would reject the burst the pacer promises.
// 200 paced rows must see zero 429s. Not run by the implementer.
import assert from "node:assert/strict";
import test from "node:test";
import { exportPaced, resetPace, setPaceJitter } from "../packages/site-mapper/dist/pace.js";

const BURST = 5;

test("a 200-row export at the pace gets zero 429s", async () => {
  resetPace();
  setPaceJitter(() => 1);
  const seen = [];
  let limited = 0;
  const rows = Array.from({ length: 200 }, (_, index) => index);
  const result = await exportPaced("fixture.test", rows, async () => {
    const at = Date.now();
    seen.push(at);
    if (seen.length > BURST) {
      const recent = seen.slice(BURST).filter((time) => at - time < 1000);
      if (recent.length > 2) {
        limited += 1;
        throw Object.assign(new Error("429"), { status: 429 });
      }
    }
    return at;
  });
  assert.equal(limited, 0);
  assert.equal(result.rows.length, 200);
  assert.match(result.note, /\[pace\] 200 calls/);
});
