import assert from "node:assert/strict";
import { isIP } from "node:net";
import test from "node:test";
import { dnsAnswers } from "../apps/bridge/dist/dns-answers.js";

test("dns answers are addresses, never an echoed name", async () => {
  const mapped = "::ffff:a9fe:a9fe";
  assert.equal(isIP(mapped), 6);
  assert.equal(isIP("deadbeef"), 0);
  assert.equal(isIP("cafe"), 0);
  assert.deepEqual(await dnsAnswers(mapped, async () => ["should-not-run"]), [mapped]);
  assert.deepEqual(await dnsAnswers("[::ffff:7f00:1]", async () => ["should-not-run"]), [
    "::ffff:7f00:1",
  ]);
  let asked = "";
  assert.deepEqual(
    await dnsAnswers("deadbeef", async (host) => {
      asked = host;
      return ["1.2.3.4"];
    }),
    ["1.2.3.4"],
  );
  assert.equal(asked, "deadbeef");
  assert.deepEqual(await dnsAnswers("cafe", async () => ["9.9.9.9", "not-an-address"]), [
    "9.9.9.9",
  ]);
});
