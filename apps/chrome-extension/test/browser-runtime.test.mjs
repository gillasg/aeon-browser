import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { browserFixture } from "./browser-fixture-helper.mjs";
test(
  "runtime helpers operate against real Chrome",
  {
    skip:
      process.platform !== "win32" ||
      !existsSync(
        resolve(".slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe"),
      ),
  },
  async (t) => {
    const fixture = await browserFixture();
    const { api } = fixture;
    api.bindBrowserSession(1, "runtime-test");
    await api.withBrowserDebugger(1, async () => {});
    const target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabId: 1,
      tabIncarnation: randomUUID(),
    };
    try {
      await fixture.setPage(
        `<select aria-label="Country"><option value="us">United States</option><option value="ca">Canada</option></select><input type="date" aria-label="Date"><button id="expand" aria-expanded="false">Expand</button><div id="late"></div><div style="opacity:0">Fake success</div>`,
      );
      for (const [name, run] of cases) await t.test(name, () => run({ ...fixture, target }));
    } finally {
      await api.releaseBrowserSessions();
      await fixture.close();
    }
  },
);

const cases = [
  [
    "typing follows an editable combobox focus replacement",
    async ({ api, debuggee, evaluate }) => {
      await evaluate(
        `document.body.insertAdjacentHTML('beforeend','<input id="original" role="combobox" aria-label="Original"><input id="replacement" aria-label="Replacement">'); document.querySelector('#original').onfocus=()=>document.querySelector('#replacement').focus()`,
      );
      const node = (await api.getAxTree(debuggee)).find((node) => node.name?.value === "Original");
      await api.fillNode(debuggee, node.backendDOMNodeId, "Focus moved correctly");
      assert.equal(await api.isFocusedInput(debuggee), true);
      assert.equal(
        await evaluate("document.querySelector('#replacement').value"),
        "Focus moved correctly",
      );
      await evaluate(
        "document.querySelector('#original').remove();document.querySelector('#replacement').remove()",
      );
    },
  ],
  [
    "same-origin iframe targets include their frame offset",
    async ({ api, debuggee, evaluate }) => {
      await evaluate(
        `document.body.insertAdjacentHTML('beforeend', '<iframe id="frame" style="position:absolute;left:80px;top:150px;width:300px;height:150px"></iframe>'); document.querySelector('#frame').srcdoc='<button onclick="parent.frameClicked=true">Inside frame</button>'`,
      );
      await evaluate("new Promise(r=>setTimeout(r,100))");
      const node = (await api.getAxTree(debuggee)).find(
        (node) => node.name?.value === "Inside frame" && node.role?.value === "button",
      );
      assert.ok(node);
      const point = await api.actionablePoint(debuggee, node.backendDOMNodeId);
      assert.ok(point.x > 80 && point.y > 150);
      await api.clickAt(debuggee, point.x, point.y);
      assert.equal(await evaluate("window.frameClicked"), true);
    },
  ],
  [
    "native select and date values are set and invalid dates restore the prior value",
    async ({ api, debuggee, evaluate }) => {
      const nodes = await api.getAxTree(debuggee);
      const select = nodes.find((node) => node.name?.value === "Country");
      const date = nodes.find((node) => node.name?.value === "Date");
      await api.fillNode(debuggee, select.backendDOMNodeId, "Canada");
      assert.equal(await evaluate("document.querySelector('select').value"), "ca");
      await api.fillNode(debuggee, date.backendDOMNodeId, "2026-10-05");
      await assert.rejects(
        api.fillNode(debuggee, date.backendDOMNodeId, "bad date"),
        /INPUT_FAILED/,
      );
      assert.equal(await evaluate("document.querySelector('input').value"), "2026-10-05");
    },
  ],
  [
    "compact observations expose backend ids and expanded state; hidden success is excluded",
    async ({ api, debuggee, target }) => {
      const state = api.createSemanticNodes(await api.getAxTree(debuggee));
      const expand = state.nodes.find((node) => node.name === "Expand");
      assert.ok(expand.backendNodeId > 0);
      assert.equal(expand.expanded, false);
      const text = await api.visiblePageText(debuggee);
      assert.ok(!text.includes("Fake success"));
      const filtered = api.createSemanticNodes(
        api.filterVisibleTextNodes(await api.getAxTree(debuggee), text),
      );
      assert.ok(!filtered.nodes.some((node) => node.name.includes("Fake success")));
      const ref = await api.resolveElement(
        debuggee,
        { kind: "backend", backendNodeId: expand.backendNodeId, documentEpoch: 1 },
        target,
        new Map(),
        new Map(),
        1,
      );
      assert.equal(ref.name, "Expand");
      await assert.rejects(
        api.resolveElement(
          debuggee,
          { kind: "backend", backendNodeId: expand.backendNodeId, documentEpoch: 0 },
          target,
          new Map(),
          new Map(),
          1,
        ),
        /STALE_REF/,
      );
    },
  ],
  [
    "settling observes dynamic mutations and ignores continuous style animation",
    async ({ api, debuggee, evaluate }) => {
      const before = await api.primeBrowserSettle(debuggee);
      await evaluate(
        "document.querySelector('#late').textContent='Changed'; window.animation=setInterval(()=>document.querySelector('#late').style.opacity=Math.random()>.5?'0.8':'1',10)",
      );
      const settled = await api.settleBrowserPage(debuggee, 800);
      await evaluate("clearInterval(window.animation)");
      assert.equal(settled.why, "quiet");
      assert.equal(api.pageOutcome(before, settled.probe), "changed");
      assert.ok(settled.ms < 800);
    },
  ],
  [
    "page evaluation, raw CDP and explicit conditions use the selected page",
    async ({ api, debuggee, evaluate, target }) => {
      const request = (step) => ({ step: { target, ...step } });
      const result = await api.executePageCode(
        debuggee,
        request({
          op: "evaluate",
          expression: "document.querySelector('#expand').textContent",
        }),
        async () => {},
      );
      assert.equal(result.value, "Expand");
      const raw = await api.executePageCode(
        debuggee,
        request({
          op: "cdp",
          method: "Runtime.evaluate",
          params: { expression: "6*7", returnByValue: true },
        }),
        async () => {},
      );
      assert.equal(raw.value.result.value, 42);
      await evaluate("setTimeout(()=>document.querySelector('#late').textContent='Ready',120)");
      assert.equal(
        (
          await api.executePageCode(
            debuggee,
            request({
              op: "waitFor",
              expression: "document.querySelector('#late').textContent==='Ready'",
              timeoutMs: 1000,
            }),
            async () => {},
          )
        ).found,
        true,
      );
    },
  ],
  [
    "native JavaScript dialogs are accepted automatically and recorded",
    async ({ evaluate }) => {
      assert.equal(await evaluate("confirm('Proceed with fixture?')"), true);
      assert.equal(await evaluate("prompt('Name','Aeon')"), "Aeon");
    },
  ],
];
