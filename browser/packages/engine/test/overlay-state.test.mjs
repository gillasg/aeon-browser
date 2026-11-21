// Aeon's own overlay is not page state: the nodes under its hosts (the hand-off card and the orb,
// marked data-aeon-overlay, and the cursor painter's host, found by its expando) are left out of
// what bu.state reads. The page's own nodes stay in.
import assert from "node:assert/strict";
import test from "node:test";

// Backend ids: 40-44 an overlay host with a closed shadow root; 70-73 the cursor's host; 5 a page button.
const ASK = {
  backendNodeId: 40,
  children: [{ backendNodeId: 41, children: [{ backendNodeId: 44 }] }],
  shadowRoots: [{ backendNodeId: 42, children: [{ backendNodeId: 43 }] }],
};
const CURSOR = {
  backendNodeId: 70,
  shadowRoots: [
    { backendNodeId: 71, children: [{ backendNodeId: 72, children: [{ backendNodeId: 73 }] }] },
  ],
};

const state = { overlays: [40], cursor: true, failCursor: false };
globalThis.chrome = {
  debugger: {
    sendCommand: async (debuggee, method, params = {}) => {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("data-aeon-overlay"))
          return { result: { type: "object", subtype: "array", objectId: "overlays" } };
        if (params.expression.includes("__cursorSurface")) {
          return state.cursor
            ? { result: { type: "object", subtype: "node", objectId: "cursor" } }
            : { result: { type: "object", subtype: "null", value: null } };
        }
        return {};
      }
      if (method === "Runtime.getProperties") {
        const hosts = state.overlays.map((id, index) => ({
          name: String(index),
          value: { objectId: `host-${id}` },
        }));
        return { result: hosts };
      }
      if (method === "DOM.describeNode") {
        if (params.objectId?.startsWith("host-") && !params.depth)
          return { node: { backendNodeId: Number(params.objectId.slice(5)) } };
        if (params.backendNodeId === 40) return { node: ASK };
        if (params.objectId === "cursor") {
          if (state.failCursor) throw new Error("No node with given id found");
          return { node: CURSOR };
        }
        return { node: {} };
      }
      return {};
    },
  },
};

const { overlayBackendIds } = await import("../dist/native-browser-overlay.js");
const debuggee = { tabId: 7 };

test("the hand-off card and the cursor's host are overlay: their whole subtrees, shadow roots too", async () => {
  const ids = await overlayBackendIds(debuggee);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [40, 41, 42, 43, 44, 70, 71, 72, 73],
  );
  assert.equal(ids.has(5), false, "a page button was taken for overlay");
});

test("a page with no overlay has no overlay ids", async () => {
  state.overlays = [];
  state.cursor = false;
  const ids = await overlayBackendIds(debuggee);
  assert.equal(ids.size, 0);
  state.overlays = [40];
  state.cursor = true;
});

test("a failed read leaves the rest of the overlay out, and never throws", async () => {
  state.failCursor = true;
  const ids = await overlayBackendIds(debuggee);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [40, 41, 42, 43, 44],
  );
  state.failCursor = false;
});
