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

test("home (the catalog page) may read and change every Settings section", () => {
  const home = { role: "ui", scope: { kind: "catalog" } };
  assert.equal(
    authorizeNativeUiScope(home, request("settings.blocked-sites", { action: "read" })),
    true,
  );
  assert.equal(
    authorizeNativeUiScope(home, request("settings.form-profile", { action: "read" })),
    true,
  );
  assert.equal(authorizeNativeUiScope(home, request("settings.outside-context", {})), true);
  assert.equal(
    authorizeNativeUiScope(scope, request("settings.form-profile", { action: "read" })),
    false,
  );
});
