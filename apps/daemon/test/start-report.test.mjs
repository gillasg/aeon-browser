import assert from "node:assert/strict";
import test from "node:test";
import { managedFailureLine } from "../src/start-report.ts";

test("a failed managed start names its cause on one supervisor line", () => {
  assert.equal(
    managedFailureLine("Refusing /tmp/graft: it is owned by uid 65534.\nnext"),
    "GRAFT_DAEMON_FAILED Refusing /tmp/graft: it is owned by uid 65534. next\n",
  );
});
