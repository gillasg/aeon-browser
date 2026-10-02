import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionUiBridge } from "../dist/extension-ui-bridge.js";

test("extension UI bridge projects and resolves native Pi dialogs", async () => {
  let context;
  let mode;
  const session = {
    extensionRunner: {
      getUIContext: () => ({}),
      setUIContext: (value, nextMode) => {
        context = value;
        mode = nextMode;
      },
    },
  };
  const bridge = new ExtensionUiBridge(session);
  const events = [];
  bridge.subscribe((event) => events.push(event));
  assert.equal(mode, "rpc");

  const selecting = context.select("Choose", ["one", "two"], { timeout: 10_000 });
  const selectDialog = bridge.snapshot().dialogs[0];
  assert.equal(selectDialog.kind, "select");
  assert.equal(bridge.respond(selectDialog.requestId, "other"), false);
  assert.equal(bridge.respond(selectDialog.requestId, "two"), true);
  assert.equal(await selecting, "two");

  const confirming = context.confirm("Proceed?", "Continue this operation?");
  const confirmDialog = bridge.snapshot().dialogs[0];
  assert.equal(bridge.respond(confirmDialog.requestId, true), true);
  assert.equal(await confirming, true);

  const editing = context.editor("Edit", "starting text");
  const editDialog = bridge.snapshot().dialogs[0];
  assert.equal(editDialog.kind, "editor");
  assert.equal(editDialog.prefill, "starting text");
  assert.equal(bridge.respond(editDialog.requestId, "updated text"), true);
  assert.equal(await editing, "updated text");

  context.notify("Extension notice", "warning");
  assert.equal(bridge.snapshot().notices[0].message, "Extension notice");
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "extension-ui-request",
      "extension-ui-resolved",
      "extension-ui-request",
      "extension-ui-resolved",
      "extension-ui-request",
      "extension-ui-resolved",
      "extension-ui-notice",
    ],
  );
  bridge.close();
});
