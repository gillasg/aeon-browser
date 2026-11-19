import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ext = fileURLToPath(new URL("../src/", import.meta.url));
const engine = fileURLToPath(new URL("../../../browser/packages/engine/src/", import.meta.url));

// Eval runs leave one chat tab per task: Core opens a chat tab for each `aeon run`, and the
// harness stops the chat but never has a tab id for that view. If Aeon does not track it, no
// cleanup path can close it and the background pages pile up.

test("chat tabs opened for a run are registered with the agent tab tracker", async () => {
  const source = await readFile(join(ext, "native-worker-open-chat.ts"), "utf8");
  assert.match(source, /trackAgentTab/, "Core-opened chat tabs must be tracked");
  assert.match(
    source,
    /trackAgentTab\(created\.id, chatId/,
    "the newly created tab must be registered to its chat",
  );
});

test("the tracker has an idle sweep that closes untouched agent tabs", async () => {
  const source = await readFile(join(engine, "native-browser-tab-cleanup.ts"), "utf8");
  assert.match(source, /DEFAULT_IDLE_MINUTES/, "there is an idle deadline");
  assert.match(source, /cleanupAgentTabs/, "there is a sweep for stale agent tabs");
  assert.match(source, /chrome\.alarms\.onAlarm/, "the sweep runs on a timer");
  assert.match(source, /keepSeen/, "a tab the user looked at is kept");
});
