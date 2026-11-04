import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostHandler } from "../packages/tools/dist/host.js";
import { actionCacheKey, locatePrompt } from "../packages/tools/dist/locate.js";

// page.observe / page.act: one small-model call picks elements, and a local cache replays an act
// that worked. The model and the cache only ever see %name% placeholders, never values.
const page = ['[12] textbox "Email"', '[13] button "Sign up"', '[14] link "Help"'].join("\n");
const context = { source: "chat", scope: "chat-1" };

function fakeModel(reply, seen = []) {
  return async () => ({
    complete: async (request) => {
      seen.push(request);
      return { content: [{ type: "toolCall", id: "1", name: "choose", arguments: reply }] };
    },
  });
}

test("locate returns the model's choice, capped, and sends placeholders only", async () => {
  const seen = [];
  const host = createHostHandler({
    dataDirectory: await mkdtemp(join(tmpdir(), "locate-")),
    model: fakeModel(
      {
        actions: [
          { id: "[12]", method: "fill", args: ["%email%"], description: "Email field" },
          { id: "13", method: "click", args: [], description: "Sign up" },
          { id: "14", method: "teleport", args: [], description: "bad method" },
        ],
        twoStep: true,
      },
      seen,
    ),
  });
  const act = await host(
    {
      locate: { instruction: "type the email", page, url: "https://a.test", variables: ["email"] },
    },
    context,
  );
  assert.deepEqual(act.actions, [
    { id: "12", method: "fill", args: ["%email%"], description: "Email field" },
  ]);
  assert.equal(act.twoStep, true);
  const prompt = seen[0].messages[0].content[0].text;
  assert.match(prompt, /%email%/);
  assert.match(prompt, /\[13\] button "Sign up"/);

  const observed = await host(
    { locate: { instruction: "every control", page, mode: "observe", limit: 5 } },
    context,
  );
  assert.equal(observed.actions.length, 2, "an unknown method is dropped");
  assert.equal(observed.twoStep, false, "observe never asks for a second look");
});

test("without a model, locate says plainly what to do instead", async () => {
  const host = createHostHandler({ dataDirectory: await mkdtemp(join(tmpdir(), "locate-")) });
  await assert.rejects(
    async () => host({ locate: { instruction: "click it", page } }, context),
    /NEEDS_MODEL/,
  );
});

test("the second look says what was done and that only the change is shown", () => {
  const prompt = locatePrompt({
    instruction: "pick Large",
    mode: "second",
    done: "Size menu",
    page,
  });
  assert.match(prompt, /Already done: Size menu/);
  assert.match(prompt, /changed/);
});

test("the action cache keeps steps by site and instruction, without values", async () => {
  const home = await mkdtemp(join(tmpdir(), "locate-"));
  const host = createHostHandler({ dataDirectory: home });
  const key = { site: "www.Shop.test", instruction: "Search  for %q%", variables: ["q"] };
  assert.deepEqual(await host({ actionCache: "get", ...key }, context), { steps: null });
  const step = { role: "searchbox", name: "Search", method: "fill", args: ["%q%"] };
  await host({ actionCache: "put", ...key, steps: [{ ...step, value: "secret" }] }, context);
  const hit = await host(
    { actionCache: "get", site: "shop.test", instruction: "search for %q%", variables: ["q"] },
    context,
  );
  assert.deepEqual(hit.steps, [{ ...step, description: "" }], "same key: case, www and spaces");
  assert.doesNotMatch(await readFile(join(home, "action-cache.json"), "utf8"), /secret/);
  assert.notEqual(
    actionCacheKey("shop.test", "search for %q%", ["q"]),
    actionCacheKey("shop.test", "search for %q%", []),
  );
  assert.deepEqual(await host({ actionCache: "drop", ...key }, context), { dropped: true });
  assert.deepEqual(await host({ actionCache: "get", ...key }, context), { steps: null });
  await rm(home, { recursive: true, force: true });
});
