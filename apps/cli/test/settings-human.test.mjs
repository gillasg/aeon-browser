import assert from "node:assert/strict";
import test from "node:test";
import { settingsCommand } from "../dist/settings.js";

test("graft settings can turn human-like input on for a stealth run", async () => {
  const seen = [];
  const client = {
    settings: async (set) => {
      seen.push(set);
      return [{ humanLikeInput: set?.humanLikeInput === true }];
    },
  };
  const code = await settingsCommand(client, ["set", "humanLikeInput=true"]);
  assert.equal(code, 0);
  assert.deepEqual(seen, [{ humanLikeInput: true }]);
});

test("graft settings leaves human-like input off when set false", async () => {
  const seen = [];
  const client = {
    settings: async (set) => {
      seen.push(set);
      return [{ humanLikeInput: false }];
    },
  };
  const code = await settingsCommand(client, ["set", "humanLikeInput=false"]);
  assert.equal(code, 0);
  assert.deepEqual(seen, [{ humanLikeInput: false }]);
});
