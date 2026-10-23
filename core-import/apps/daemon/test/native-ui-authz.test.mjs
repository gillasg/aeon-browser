import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DaemonUiRequestSchema } from "@aeon/protocol";
import { authorizeNativeUiScope } from "../dist/native-ui-authz.js";

const chatId = randomUUID();
const scope = { role: "ui", scope: { kind: "chat", chatId } };
const request = (operation, payload = {}) =>
  DaemonUiRequestSchema.parse({ kind: "command", requestId: randomUUID(), operation, payload });

test("a Chat page may open the model sign-in page and read the model catalog", () => {
  assert.equal(authorizeNativeUiScope(scope, request("chat.model-catalog")), true);
  assert.equal(authorizeNativeUiScope(scope, request("chat.model-login")), true);
});

test("a Chat page still cannot touch another Chat or start a different one", () => {
  assert.equal(authorizeNativeUiScope(scope, request("chat.get", { chatId })), true);
  assert.equal(authorizeNativeUiScope(scope, request("chat.get", { chatId: randomUUID() })), false);
  assert.equal(authorizeNativeUiScope(scope, request("chat.list", { limit: 10 })), false);
  assert.equal(authorizeNativeUiScope(scope, request("chat.create", { title: "New" })), false);
});
