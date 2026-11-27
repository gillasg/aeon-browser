import assert from "node:assert/strict";
import test from "node:test";
import { RewindSchema } from "@graft/protocol";
import { siteScriptRewind } from "../dist/site-script-rewind.js";

const script = (history) => ({
  scriptId: "0b2f2c64-6f1b-4a58-bb9a-5b1c8b5f0d11",
  name: "Hide ads",
  revision: 3,
  history,
});

test("a change that left an earlier revision can be taken back to it", () => {
  const rewind = siteScriptRewind(script([{ revision: 2 }]), "update");
  assert.deepEqual(rewind, {
    kind: "site-script-undo",
    scriptId: "0b2f2c64-6f1b-4a58-bb9a-5b1c8b5f0d11",
    revision: 3,
    label: "Undo change to Hide ads",
  });
  assert.ok(RewindSchema.safeParse(rewind).success);
});

test("a first revision, an undo and a delete have nothing to go back to", () => {
  assert.equal(siteScriptRewind(script([]), "update"), undefined);
  assert.equal(siteScriptRewind(script([{ revision: 2 }]), "undo"), undefined);
  assert.equal(siteScriptRewind(script([{ revision: 2 }]), "delete"), undefined);
});
