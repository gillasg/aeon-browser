import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserFixture } from "./browser-fixture-helper.mjs";
test(
  "browser layer handles real dynamic inputs, duplicate controls and stale geometry",
  {
    skip:
      process.platform !== "win32" ||
      !existsSync(
        resolvePath(".slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe"),
      ),
  },
  async (t) => {
    const fixture = await browserFixture();
    const target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabId: 1,
      tabIncarnation: randomUUID(),
    };
    const resolve = (element) =>
      fixture.api.resolveElement(fixture.debuggee, element, target, new Map(), new Map());
    const context = { ...fixture, target, resolve };
    try {
      await fixture.setPage(
        `<form id="search"><label for="q">Search videos</label><input id="q" role="combobox" placeholder="Search YouTube"><button type="submit">Search</button></form><div id="results"></div><button style="display:none">Ask</button><button id="ask">Ask</button><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();setTimeout(()=>document.querySelector('#results').textContent='Marie Antoinette · recommended books',100)};</script>`,
      );
      for (const [name, run] of cases) await t.test(name, () => run(context));
    } finally {
      await fixture.api.releaseBrowserSessions();
      await fixture.close();
    }
  },
);
const cases = [
  [
    "useful controls survive large generic and text trees",
    async (context) => {
      const { api } = context;
      const generic = Array.from({ length: 250 }, (_, i) => ({
        backendDOMNodeId: i + 1,
        role: { value: "generic" },
        name: { value: "" },
      }));
      const text = Array.from({ length: 250 }, (_, i) => ({
        backendDOMNodeId: i + 300,
        role: { value: "StaticText" },
        name: { value: `Text ${i}` },
      }));
      const input = {
        backendDOMNodeId: 999,
        role: { value: "combobox" },
        name: { value: "Search" },
      };
      const snapshot = api.createSemanticNodes([...generic, ...text, input]);
      assert.equal(snapshot.nodes.length, 180);
      assert.ok(snapshot.nodes.some((node) => node.role === "combobox" && node.name === "Search"));
      assert.ok(snapshot.truncated);
      const focused = api.createSemanticNodes([...generic, ...text, input], { query: "Search" });
      assert.equal(focused.nodes.length, 1);
      assert.equal(focused.truncated, false);
      const links = text.map((node) => ({ ...node, role: { value: "link" } }));
      const ask = {
        ...input,
        backendDOMNodeId: 1001,
        role: { value: "button" },
        name: { value: "Ask" },
      };
      const crowded = api.createSemanticNodes([...links, input, ask]);
      assert.ok(crowded.nodes.some((node) => node.name === "Ask"));
      assert.ok(crowded.nodes.some((node) => node.role === "combobox"));
    },
  ],
  [
    "combobox fill is verified and Enter submits a dynamic form",
    async (context) => {
      const { api, debuggee, evaluate, resolve } = context;
      const input = await resolve({ kind: "locator", role: "combobox", name: "Search videos" });
      await api.actionablePoint(debuggee, input.backendNodeId, true);
      await api.fillNode(debuggee, input.backendNodeId, "Marie Antoinette");
      assert.equal(await evaluate("document.querySelector('#q').value"), "Marie Antoinette");
      await api.pressKey(debuggee, "Enter");
      await evaluate("new Promise(r=>setTimeout(r,200))");
      assert.match(
        await evaluate("document.querySelector('#results').innerText"),
        /recommended books/,
      );
    },
  ],
  [
    "only the visible duplicate Ask control is selected",
    async (context) => {
      const { evaluate, resolve } = context;
      const ask = await resolve({ kind: "locator", role: "button", name: "Ask" });
      const css = await resolve({ kind: "query", by: "css", value: "#ask" });
      assert.equal(ask.backendNodeId, css.backendNodeId);
      await evaluate("document.body.insertAdjacentHTML('beforeend','<button>Ask</button>')");
      await assert.rejects(
        resolve({ kind: "locator", role: "button", name: "Ask" }),
        /AMBIGUOUS_TARGET/,
      );
    },
  ],
  [
    "label, placeholder and scoped CSS target the actual input",
    async (context) => {
      const { resolve } = context;
      const ids = await Promise.all([
        resolve({ kind: "query", by: "label", value: "Search videos" }),
        resolve({ kind: "query", by: "placeholder", value: "Search YouTube" }),
        resolve({ kind: "query", by: "css", value: "input", scope: "#search" }),
      ]);
      assert.equal(ids[0].backendNodeId, ids[1].backendNodeId);
      assert.equal(ids[0].backendNodeId, ids[2].backendNodeId);
      await assert.rejects(
        resolve({ kind: "locator", role: "textbox", name: "Search videos" }),
        /TARGET_NOT_FOUND/,
      );
    },
  ],
  [
    "open shadow DOM is searchable and fillable",
    async (context) => {
      const { api, debuggee, evaluate, resolve } = context;
      await evaluate(`const host=document.createElement('section');host.id='shadow';document.body.append(host);
        host.attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow search">'`);
      const input = await resolve({ kind: "query", by: "label", value: "Shadow search" });
      await api.actionablePoint(debuggee, input.backendNodeId, true);
      await api.fillNode(debuggee, input.backendNodeId, "Shadow text");
      assert.equal(
        await evaluate("document.querySelector('#shadow').shadowRoot.querySelector('input').value"),
        "Shadow text",
      );
    },
  ],
  [
    "disabled, readonly and obstructed controls fail before input dispatch",
    async (context) => {
      const { api, debuggee, evaluate, commands, resolve } = context;
      await evaluate("document.querySelector('#q').disabled=true");
      const input = await resolve({ kind: "query", by: "css", value: "#q" });
      const before = commands.filter((command) => command.startsWith("Input.")).length;
      await assert.rejects(
        api.actionablePoint(debuggee, input.backendNodeId, true),
        /TARGET_DISABLED/,
      );
      await evaluate(
        "document.querySelector('#q').disabled=false;document.querySelector('#q').readOnly=true",
      );
      await assert.rejects(
        api.actionablePoint(debuggee, input.backendNodeId, true),
        /NOT_EDITABLE/,
      );
      await evaluate(
        "document.querySelector('#q').readOnly=false;document.body.insertAdjacentHTML('beforeend','<div id=overlay style=\"position:fixed;inset:0;z-index:1000;background:black\"></div>')",
      );
      await assert.rejects(
        api.actionablePoint(debuggee, input.backendNodeId, true),
        /TARGET_BLOCKED/,
      );
      assert.equal(commands.filter((command) => command.startsWith("Input.")).length, before);
      await evaluate("document.querySelector('#overlay').remove()");
    },
  ],
  [
    "screenshots remain usable after six seconds but reject changed layout and documents",
    async (context) => {
      const { api, debuggee, evaluate, commands, target, resolve } = context;
      api.bindBrowserSession(1, randomUUID());
      const request = {
        step: { op: "observe", target, kind: "screenshot" },
        expectedDocumentEpoch: 1,
      };
      const shot = await api.captureScreenshot(
        request,
        { url: "https://example.test" },
        async () => {},
      );
      const oldNow = Date.now;
      Date.now = () => shot.capturedAt + 6500;
      try {
        assert.equal(api.screenshotPoint(shot.screenshotId, target, 1).capturedAt, shot.capturedAt);
      } finally {
        Date.now = oldNow;
      }
      await assert.rejects(
        Promise.resolve().then(() => api.screenshotPoint(shot.screenshotId, target, 2)),
        /STALE_REF/,
      );
      const ask = await resolve({ kind: "query", by: "css", value: "#ask" });
      const point = await api.actionablePoint(debuggee, ask.backendNodeId);
      const step = {
        op: "click",
        target,
        element: {
          kind: "point",
          screenshotId: shot.screenshotId,
          x: point.x / shot.viewport.width,
          y: point.y / shot.viewport.height,
        },
      };
      await evaluate("document.querySelector('#ask').style.marginLeft='180px'");
      const before = commands.filter((command) => command.startsWith("Input.")).length;
      await assert.rejects(
        api.clickScreenshotPoint(debuggee, { step, expectedDocumentEpoch: 1 }),
        /STALE_REF/,
      );
      assert.equal(commands.filter((command) => command.startsWith("Input.")).length, before);
      Date.now = () => shot.capturedAt + 61_000;
      try {
        assert.throws(() => api.screenshotPoint(shot.screenshotId, target, 1), /STALE_REF/);
      } finally {
        Date.now = oldNow;
      }
    },
  ],
  [
    "a normal locator miss does not detach the session",
    async (context) => {
      const { api } = context;
      await api.withBrowserDebugger(1, async () => {});
      await assert.rejects(
        api.withBrowserDebugger(1, async () => {
          throw Error("TARGET_NOT_FOUND");
        }),
        /TARGET_NOT_FOUND/,
      );
      await api.withBrowserDebugger(1, async () => {});
    },
  ],
];
