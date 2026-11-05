import assert from "node:assert/strict";
import test from "node:test";
import { withChoice } from "../dist/signin.js";

test("setting one browser's password manager keeps the main one and the other browsers", () => {
  const config = { provider: "proton", browsers: { work: { provider: "proton" } } };
  assert.deepEqual(withChoice(config, { provider: "bitwarden", bitwardenSession: "s" }, "eval"), {
    provider: "proton",
    browsers: {
      work: { provider: "proton" },
      eval: { provider: "bitwarden", bitwardenSession: "s" },
    },
  });
  // The main choice replaces only the top level.
  assert.deepEqual(withChoice(config, { provider: "bitwarden" }), {
    provider: "bitwarden",
    browsers: { work: { provider: "proton" } },
  });
});
