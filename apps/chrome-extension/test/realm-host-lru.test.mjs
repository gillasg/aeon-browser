import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A chat's REPL realm must outlive its run (variables persist across turns), but it must not
// outlive the session: one realm per chat forever pins the local process's memory and CPU.
// This is the invariant for the bounded, idle-evicted working set.

const engine = new URL("../../../browser/packages/engine/", import.meta.url);
const text = await readFile(new URL("src/code-realm-host.ts", engine), "utf8");
const { RealmHost } = await import(new URL("dist/code-realm-host.js", engine).href);

test("realms are LRU-capped and idle-evicted, never one per chat forever", () => {
  assert.match(text, /MAX_REALMS\s*=\s*\d+/, "a cap on live realms");
  assert.match(text, /MAX_JOB_REALMS\s*=\s*\d+/, "a cap on job realms");
  assert.match(text, /REALM_IDLE_MS\s*=\s*\d+/, "an idle age for a realm");
  assert.match(text, /sweepRealms/, "a sweep that evicts");
});

const quietLink = { event: async () => ({}) };

test("after N chats the realm count stays bounded; a chat with a cell in flight is kept", async () => {
  const host = new RealmHost(quietLink);
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    await host.handle({ kind: "cell", chatId: `chat-${i}`, cellId: `c-${i}`, code: "1" });
    host.sweepRealms(now + i);
  }
  assert.ok(host.realmCount() <= 4, `12 chats left ${host.realmCount()} realms (cap is 4)`);
  // Job realms get their own cap: a run that abandons jobs must not pin one realm per job.
  const jobs = new RealmHost(quietLink);
  for (let i = 0; i < 6; i++) {
    jobs.handle({ kind: "job", jobId: `j-${i}`, chatId: "job-chat", spec: { items: [] } });
    await new Promise((done) => setTimeout(done, 30));
    jobs.sweepRealms(now + i);
  }
  assert.ok(jobs.realmCount() <= 2, `6 jobs left ${jobs.realmCount()} realms`);
  jobs.stopSweep();
  // A cell still pending keeps its chat's realm even well past the idle age.
  const pending = host.handle({
    kind: "cell",
    chatId: "pending-chat",
    cellId: "pending",
    code: "await new Promise(() => {})",
  });
  host.sweepRealms(now + 1_000_000);
  assert.ok(host.realmCount() >= 1, "the pending chat's realm was evicted while its cell ran");
  host.handle({ kind: "reset", chatId: "pending-chat" });
  assert.match(String((await pending).error), /RUN_RESET|TIMEOUT/);
  host.stopSweep();
});
