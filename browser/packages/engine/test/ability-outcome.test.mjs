// A way that drifted can still answer with {unverified}. That result is not an error, so the
// error path never names its repair: the site.run projection must give it a heal/edit next step.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserSitesApi } from "../dist/code-api-sites.js";

function loadSite(runAnswer) {
  const logs = [];
  const calls = [];
  const context = vm.createContext({
    console: { log: (...parts) => logs.push(parts.join(" ")) },
    __call: async (request) => {
      calls.push(request);
      return runAnswer(request);
    },
    URL,
  });
  vm.runInContext(browserSitesApi, context);
  return { site: vm.runInContext("site", context), logs, calls };
}

test("a non-throwing unverified result names the repair call", async () => {
  const answer = {
    result: { items: [] },
    via: "api",
    tried: [],
    unverified: [{ via: "api", reason: "the recorded shape changed" }],
  };
  const { site, logs } = loadSite(() => answer);
  const outcome = await site.run("feed", {}, { site: "notes.example" });
  assert.deepEqual(outcome.unverified, answer.unverified, "the result is kept, not thrown away");
  assert.match(outcome.next, /site_mapper\(\{action:"heal",site:"notes\.example",repair:true\}/);
  assert.match(outcome.next, /site_mapper\(\{action:"edit",site:"notes\.example"/);
  assert.ok(
    logs.some((line) => line.startsWith('Next: site_mapper({action:"heal"')),
    "the next step is printed for the agent to see",
  );
});

test("a clean result has no repair next step", async () => {
  const { site, logs } = loadSite(() => ({ result: { items: [1] }, via: "api", tried: [] }));
  const outcome = await site.run("feed", {}, { site: "notes.example" });
  assert.equal(outcome.next, undefined);
  assert.equal(
    logs.some((line) => line.startsWith("Next:")),
    false,
  );
});
