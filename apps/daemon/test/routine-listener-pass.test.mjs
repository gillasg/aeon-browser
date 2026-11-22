import assert from "node:assert/strict";
import test from "node:test";
import { listenerPass } from "../dist/routine-listeners.js";

// A watcher made with both a "use listen" check and a listen filter: the live pass needs an open
// tab of the page. Once that tab was closed it stayed idle, the timer skips "use listen" checks,
// and the check never ran again.

const listening = '"use listen";\nconst p = await browser.openTab(url); return false;';
const idle = async () => ({ met: false, idle: true });

test("an idle live pass runs a listening check on its own", async () => {
  let ran = 0;
  const plain = async () => (ran++, { met: true, value: { open: true } });
  const result = await listenerPass({ check: listening, listen: { url: "/i8/" } }, idle, plain);
  assert.equal(ran, 1);
  assert.deepEqual(result, { met: true, value: { open: true } });
});

test("a live pass that heard something, or a plain live check, keeps the live result", async () => {
  let ran = 0;
  const plain = async () => (ran++, { met: true });
  const heard = async () => ({ met: true, value: 1 });
  assert.deepEqual(
    await listenerPass({ check: listening, listen: { url: "/i8/" } }, heard, plain),
    { met: true, value: 1 },
  );
  const plainCheck = { check: "return false", listen: { url: "/i8/" } };
  assert.deepEqual(await listenerPass(plainCheck, idle, plain), { met: false, idle: true });
  assert.equal(ran, 0);
  await listenerPass({ check: listening, listen: null }, idle, plain);
  assert.equal(ran, 1);
});
