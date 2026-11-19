import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

// A chat's REPL realm must outlive its run (variables persist across turns), but it must not
// outlive the session: one iframe per chat forever pins the offscreen document's memory and CPU.
// This is the invariant for the bounded, idle-evicted working set.

const source = fileURLToPath(
  new URL("../../../browser/packages/engine/src/code-offscreen.ts", import.meta.url),
);
const text = await readFile(source, "utf8");

test("realms are LRU-capped and idle-evicted, never one per chat forever", () => {
  assert.match(text, /MAX_REALMS\s*=\s*\d+/, "a cap on live realms");
  assert.match(text, /MAX_JOB_REALMS\s*=\s*\d+/, "a cap on job realms");
  assert.match(text, /REALM_IDLE_MS\s*=\s*\d+/, "an idle age for a realm");
  assert.match(text, /sweepRealms/, "a sweep that evicts");
});

function stubDom(listeners) {
  const frames = [];
  globalThis.window = {
    addEventListener: (name, fn) => {
      if (name === "message") listeners.window = fn;
    },
  };
  globalThis.document = {
    createElement: () => {
      const frame = {
        src: "",
        contentWindow: { postMessage: () => undefined },
        addEventListener: () => undefined,
        remove() {
          this.removed = true;
        },
      };
      frames.push(frame);
      return frame;
    },
    body: { append: () => undefined },
  };
  globalThis.chrome = {
    runtime: {
      id: "aeon-test",
      sendMessage: async () => ({}),
      onMessage: { addListener: (fn) => (listeners.runtime = fn) },
    },
  };
  return frames;
}

function api(listeners, frames, module) {
  const send = (message) => listeners.runtime(message, { id: "aeon-test" }, () => undefined);
  const done = (cellId) =>
    listeners.window({ data: { kind: "done", cellId }, source: frames.at(-1).contentWindow });
  return {
    module,
    frames,
    cell: (chatId, cellId) =>
      send({ target: "aeon-code-offscreen", kind: "cell", chatId, cellId, code: "" }),
    job: (jobId, chatId) =>
      send({ target: "aeon-code-offscreen", kind: "job", jobId, chatId, code: "" }),
    done,
    jobDone: done,
  };
}

async function loadOffscreen() {
  const directory = await mkdtemp(join(tmpdir(), "aeon-offscreen-"));
  const outfile = join(directory, "offscreen.mjs");
  await build({ entryPoints: [source], outfile, bundle: true, platform: "node", format: "esm" });
  const listeners = {};
  const frames = stubDom(listeners);
  const module = await import(pathToFileURL(outfile).href);
  await rm(directory, { recursive: true, force: true });
  return api(listeners, frames, module);
}

test("after N chats the realm count stays bounded; a chat with a cell in flight is kept", async () => {
  const { module, frames, cell, done } = await loadOffscreen();
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    cell(`chat-${i}`, `c-${i}`);
    done(`c-${i}`);
    module.sweepRealms(now + i);
  }
  assert.ok(module.realmCount() <= 4, `40 chats left ${module.realmCount()} realms (cap is 4)`);
  // Job realms get their own cap: a run that abandons jobs must not pin one iframe per job.
  const jobs = await loadOffscreen();
  for (let i = 0; i < 12; i++) {
    jobs.job(`j-${i}`, "job-chat");
    jobs.jobDone(`j-${i}`);
    jobs.module.sweepRealms(now + i);
  }
  assert.ok(jobs.module.realmCount() <= 2, `12 jobs left ${jobs.module.realmCount()} realms`);
  jobs.module.stopSweep();
  // A cell still pending keeps its chat's realm even well past the idle age.
  cell("pending-chat", "pending");
  module.sweepRealms(now + 1_000_000);
  assert.ok(
    frames.some((frame) => !frame.removed),
    "the pending chat's realm was evicted while its cell ran",
  );
  module.stopSweep();
});
