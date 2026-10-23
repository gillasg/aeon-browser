import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DaemonUiRequestSchema, PageGrantScopeSchema } from "@aeon/protocol";
import { authorizeNativeUiScope } from "../dist/native-ui-authz.js";

test("management has a separate grant without transcript or browser authority", () => {
  const management = { role: "ui", scope: PageGrantScopeSchema.parse({ kind: "management" }) };
  const catalog = { role: "ui", scope: { kind: "catalog" } };
  const chatId = randomUUID();
  const request = (operation, payload = {}) =>
    DaemonUiRequestSchema.parse({ kind: "command", requestId: randomUUID(), operation, payload });
  assert.equal(authorizeNativeUiScope(management, request("management.get")), true);
  assert.equal(authorizeNativeUiScope(management, request("management.home")), true);
  assert.equal(authorizeNativeUiScope(catalog, request("management.get")), false);
  assert.equal(authorizeNativeUiScope(management, request("chat.get", { chatId })), false);
  assert.equal(
    authorizeNativeUiScope(management, request("chat.submit", { chatId, text: "never submitted" })),
    false,
  );
  const image = request("chat.image", { chatId, toolCallId: "capture", index: 0 });
  assert.equal(authorizeNativeUiScope(management, image), false);
  assert.equal(authorizeNativeUiScope(catalog, image), false);
  assert.equal(
    authorizeNativeUiScope({ role: "ui", scope: { kind: "chat", chatId } }, image),
    true,
  );
  assert.equal(
    authorizeNativeUiScope({ role: "ui", scope: { kind: "chat", chatId: randomUUID() } }, image),
    false,
  );
});
