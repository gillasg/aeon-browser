import assert from "node:assert/strict";
import test from "node:test";
import {
  chromeSavingFor,
  matchChromeSaving,
} from "../packages/engine/dist/native-browser-chrome-saving.js";
import {
  rememberVaultCandidate,
  vaultCandidate,
} from "../packages/engine/dist/native-browser-vault.js";

test("a profile on a password manager turns Chrome's save offer off; none leaves the user's own", () => {
  assert.equal(chromeSavingFor("bitwarden"), "off");
  assert.equal(chromeSavingFor("proton"), "off");
  assert.equal(chromeSavingFor(null), "user");
  assert.equal(chromeSavingFor(undefined), "user");
});

test("matching asks the manager once, then sets Chrome's password saving", async () => {
  const calls = [];
  globalThis.chrome = {
    ...globalThis.chrome,
    privacy: {
      services: {
        passwordSavingEnabled: {
          set: async (value) => calls.push(["set", value]),
          clear: async () => calls.push(["clear"]),
        },
      },
    },
  };
  const asks = [];
  const ask = async (request) => {
    asks.push(request);
    return { provider: "bitwarden" };
  };
  await matchChromeSaving(ask, "https://x.com/i/flow/signup");
  await matchChromeSaving(ask, "https://x.com/i/flow/signup");
  assert.deepEqual(asks, [{ credential: "manager", url: "https://x.com/i/flow/signup" }]);
  assert.deepEqual(calls, [["set", { value: false }]]);
});

test("a login saved from a password-only screen keeps no username it never saw", () => {
  rememberVaultCandidate(
    77,
    {
      url: "https://x.com/i/flow/signup",
      site: "x.com",
      hasPassword: true,
      password: "pw",
      username: "",
      signup: true,
    },
    "agent",
  );
  assert.equal(vaultCandidate(77).username, "");
});
