import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("panel caption follows only the selected same-origin Chat and disconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pippin-panel-title-"));
  const globals = installDomFixture();
  try {
    const outfile = join(directory, "title.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/panel-frame-title.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const { observePanelFrameTitle } = await import(pathToFileURL(outfile).href);
    const root = new globalThis.EventTarget();
    const titles = [];
    const close = observePanelFrameTitle(
      root,
      () => "selected",
      (id, title) => titles.push([id, title]),
    );
    const doc = {
      head: {},
      URL: "chrome-extension://pippin/chat.html?chatId=selected",
      title: "Yahoo · Pippin",
    };
    const frame = new globalThis.HTMLIFrameElement();
    Object.assign(frame, { id: "chat-frame", contentDocument: doc });
    const event = new globalThis.Event("load");
    Object.defineProperty(event, "target", { value: frame });
    root.dispatchEvent(event);
    assert.deepEqual(titles, [["selected", "Yahoo"]]);
    doc.title = "Renamed · Pippin";
    globals.observer.callback();
    assert.deepEqual(titles.at(-1), ["selected", "Renamed"]);
    doc.URL = "chrome-extension://pippin/chat.html?chatId=other";
    globals.observer.callback();
    doc.URL = "https://example.com/chat.html?chatId=selected";
    globals.observer.callback();
    assert.equal(titles.length, 2);
    close();
    assert.equal(globals.observer.disconnected, true);
  } finally {
    globals.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

function installDomFixture() {
  const saved = Object.fromEntries(
    ["HTMLIFrameElement", "MutationObserver", "location"].map((key) => [key, globalThis[key]]),
  );
  const state = { observer: undefined, restore: () => Object.assign(globalThis, saved) };
  globalThis.HTMLIFrameElement = class {};
  globalThis.location = { origin: new URL("chrome-extension://pippin/chat.html").origin };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      state.observer = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  return state;
}
