import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AuthHelloSchema,
  BrowserInventoryDeltaMessageSchema,
  BrowserInventoryFullSchema,
  DaemonUiRequestSchema,
  NativeBootstrapResponseSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "@aeon/protocol";
import { BrowserInventoryRegistry } from "../dist/browser-inventory-registry.js";
import { GrantAuthority } from "../dist/grant-authority.js";
import { authorizeNativeUiScope } from "../dist/native-ui-authz.js";

const origin = "chrome-extension://npcdopokfkpfmepknhoecppgdgmkmihh";
const clientInstanceId = "091b9308-1ee9-420e-b71f-a564a5a27701";
const browserRunId = "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8";
const chatId = "968c135b-a48f-4f5e-9223-dff7f9a10a07";
const otherChatId = "005cfe90-b334-4b04-bb8e-e50b091f2fe5";

test("bootstrap endpoints require an explicit bounded loopback port and fixed path", () => {
  const response = (endpoint) => ({
    kind: "native.bootstrap.result",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ok: true,
    endpoint,
    connectionGrant: "A".repeat(43),
    expiresAt: Date.now() + 5000,
    daemonProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
  });
  assert.equal(
    NativeBootstrapResponseSchema.safeParse(response("ws://127.0.0.1:49152/aeon/v1")).success,
    true,
  );
  for (const endpoint of [
    "ws://127.0.0.1/aeon/v1",
    "ws://127.0.0.1:0/aeon/v1",
    "ws://127.0.0.1:65536/aeon/v1",
    "ws://user@127.0.0.1:49152/aeon/v1",
    "ws://127.0.0.1:49152/aeon/v1?grant=secret",
    "ws://localhost:49152/aeon/v1",
  ])
    assert.equal(
      NativeBootstrapResponseSchema.safeParse(response(endpoint)).success,
      false,
      endpoint,
    );
});

test("executor grants expire, bind identity, reject role substitution, and cannot replay", () => {
  let now = 1_000;
  const grants = new GrantAuthority(origin, () => now);
  const issued = grants.issueExecutor(clientInstanceId, browserRunId);
  const hello = (token, overrides = {}) =>
    AuthHelloSchema.parse({
      kind: "auth.hello",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      role: "extension-executor",
      clientInstanceId,
      browserRunId,
      connectionGrant: token,
      ...overrides,
    });

  assert.equal(
    grants.consume(origin, hello(issued.token, { browserRunId: otherChatId })).ok,
    false,
  );
  assert.equal(
    grants.consume(origin, hello(issued.token)).ok,
    false,
    "a failed attempt consumes the token",
  );

  const roleGrant = grants.issueExecutor(clientInstanceId, browserRunId);
  const wrongRole = hello(roleGrant.token, { role: "ui", pageInstanceId: randomUUID() });
  assert.deepEqual(grants.consume(origin, wrongRole), { ok: false, code: "ROLE_NOT_ALLOWED" });

  const expired = grants.issueExecutor(clientInstanceId, browserRunId);
  now += 15_001;
  assert.deepEqual(grants.consume(origin, hello(expired.token)), {
    ok: false,
    code: "GRANT_EXPIRED",
  });
});

test("page grants bind page incarnation and enforce exact Chat versus catalog operations", () => {
  const grants = new GrantAuthority(origin);
  const executorGrant = grants.issueExecutor(clientInstanceId, browserRunId);
  const executorHello = AuthHelloSchema.parse({
    kind: "auth.hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role: "extension-executor",
    clientInstanceId,
    browserRunId,
    connectionGrant: executorGrant.token,
  });
  const executor = grants.consume(origin, executorHello);
  assert.equal(executor.ok, true);
  if (!executor.ok) return;
  const pageInstanceId = randomUUID();
  const issued = grants.issuePage(executor.context, pageInstanceId, { kind: "chat", chatId });
  assert.ok(issued);
  if (!issued) return;
  const uiHello = AuthHelloSchema.parse({
    kind: "auth.hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role: "ui",
    clientInstanceId,
    browserRunId,
    pageInstanceId,
    connectionGrant: issued.token,
  });
  const consumed = grants.consume(origin, uiHello);
  assert.equal(consumed.ok, true);
  assert.deepEqual(grants.consume(origin, uiHello), { ok: false, code: "AUTHENTICATION_FAILED" });
  if (!consumed.ok) return;

  const subscribe = (id) =>
    DaemonUiRequestSchema.parse({
      kind: "chat.subscribe",
      requestId: randomUUID(),
      chatId: id,
    });
  assert.equal(authorizeNativeUiScope(consumed.context, subscribe(chatId)), true);
  assert.equal(authorizeNativeUiScope(consumed.context, subscribe(otherChatId)), false);
  const create = DaemonUiRequestSchema.parse({
    kind: "command",
    requestId: randomUUID(),
    operation: "chat.create",
    payload: {},
  });
  const modelCatalog = DaemonUiRequestSchema.parse({
    kind: "command",
    requestId: randomUUID(),
    operation: "chat.model-catalog",
    payload: {},
  });
  assert.equal(authorizeNativeUiScope(consumed.context, create), false);

  const catalog = { ...consumed.context, scope: { kind: "catalog" } };
  assert.equal(authorizeNativeUiScope(catalog, create), true);
  assert.equal(authorizeNativeUiScope(catalog, modelCatalog), true);
  assert.equal(authorizeNativeUiScope(catalog, subscribe(chatId)), false);
});

test("catalog grants allow only the narrow home routine projection", () => {
  const catalog = { role: "ui", scope: { kind: "catalog" } };
  const request = (operation) =>
    DaemonUiRequestSchema.parse({
      kind: "command",
      requestId: randomUUID(),
      operation,
      payload: {},
    });
  assert.equal(authorizeNativeUiScope(catalog, request("management.home")), true);
  assert.equal(authorizeNativeUiScope(catalog, request("management.get")), false);
});

test("New Tab Ask reads Pi models on the catalog grant, then hands prompt to exact Chat grant", () => {
  const requestId = randomUUID();
  const create = DaemonUiRequestSchema.parse({
    kind: "command",
    requestId: randomUUID(),
    operation: "chat.create",
    payload: {},
  });
  const submit = DaemonUiRequestSchema.parse({
    kind: "command",
    requestId,
    operation: "chat.submit",
    payload: { chatId, text: "synthetic scope check" },
  });
  const modelCatalog = DaemonUiRequestSchema.parse({
    kind: "command",
    requestId: randomUUID(),
    operation: "chat.model-catalog",
    payload: {},
  });
  const catalog = { role: "ui", scope: { kind: "catalog" } };
  const exactChat = { role: "ui", scope: { kind: "chat", chatId } };
  const differentChat = { role: "ui", scope: { kind: "chat", chatId: otherChatId } };

  assert.equal(authorizeNativeUiScope(catalog, create), true);
  assert.equal(authorizeNativeUiScope(catalog, modelCatalog), true);
  assert.equal(authorizeNativeUiScope(catalog, submit), false);
  assert.equal(authorizeNativeUiScope(exactChat, submit), true);
  assert.equal(authorizeNativeUiScope(differentChat, submit), false);
});

test("inventory generations replace atomically and deltas preserve navigation identity", () => {
  const { registry, full, tab, target } = inventoryFixture();
  assert.ok(registry.applyFull(full));
  assert.equal(
    registry.applyFull({ ...full, generation: 2, tabs: [{ ...tab, windowId: 8 }] }),
    undefined,
  );
  assert.equal(registry.get(clientInstanceId).generation, 1);
  const navigated = { ...tab, url: "https://example.test/two", title: "Two", documentEpoch: 1 };
  assert.deepEqual(registry.applyDelta(tabUpsert(2, navigated)), {
    applied: false,
    expectedSequence: 1,
  });
  assert.deepEqual(registry.applyDelta(tabUpsert(1, navigated)), {
    applied: true,
    expectedSequence: 2,
  });
  assert.deepEqual(registry.get(clientInstanceId).tabs[0].target, target);
  assert.equal(registry.get(clientInstanceId).tabs[0].documentEpoch, 1);
});

test("a replaced tab gets a new incarnation that stale removal cannot close", () => {
  const { registry, full, tab, target } = inventoryFixture();
  registry.applyFull(full);
  const replacement = { ...target, tabIncarnation: "b1d79142-c8cc-480a-8c38-7e1485f05ab0" };
  assert.ok(
    registry.applyFull({ ...full, generation: 2, tabs: [{ ...tab, target: replacement }] }),
  );
  const removal = BrowserInventoryDeltaMessageSchema.parse({
    kind: "browser.inventory.delta",
    clientInstanceId,
    browserRunId,
    generation: 2,
    sequence: 1,
    delta: { kind: "tab.remove", target },
  });
  assert.deepEqual(registry.applyDelta(removal), { applied: true, expectedSequence: 2 });
  assert.deepEqual(registry.get(clientInstanceId).tabs[0].target, replacement);
});

test("a new browser run invalidates inventory deltas from the previous run", () => {
  const registry = new BrowserInventoryRegistry();
  const nextRun = "92fc23dd-37ba-48b3-9719-bb2ec0cdb9de";
  const current = BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    clientInstanceId,
    browserRunId: nextRun,
    generation: 1,
    windows: [],
    tabs: [],
  });
  assert.ok(registry.applyFull(current));
  const stale = BrowserInventoryDeltaMessageSchema.parse({
    kind: "browser.inventory.delta",
    clientInstanceId,
    browserRunId,
    generation: 3,
    sequence: 1,
    delta: { kind: "window.remove", windowId: 4 },
  });
  assert.equal(registry.applyDelta(stale), undefined);
  assert.equal(registry.get(clientInstanceId).browserRunId, nextRun);
});

function inventoryFixture() {
  const registry = new BrowserInventoryRegistry();
  const target = {
    clientInstanceId,
    browserRunId,
    tabId: 19,
    tabIncarnation: "a1759117-6a6e-407e-b43d-e6100d9ffbd3",
  };
  const tab = {
    target,
    windowId: 4,
    index: 0,
    url: "https://example.test/one",
    title: "One",
    status: "complete",
    active: true,
    pinned: false,
    groupId: -1,
    documentEpoch: 0,
  };
  const full = BrowserInventoryFullSchema.parse({
    kind: "browser.inventory.full",
    clientInstanceId,
    browserRunId,
    generation: 1,
    windows: [{ windowId: 4, focused: true, state: "normal", type: "normal" }],
    tabs: [tab],
  });
  return { registry, full, tab, target };
}

function tabUpsert(sequence, tab) {
  return BrowserInventoryDeltaMessageSchema.parse({
    kind: "browser.inventory.delta",
    clientInstanceId,
    browserRunId,
    generation: 1,
    sequence,
    delta: { kind: "tab.upsert", tab },
  });
}
