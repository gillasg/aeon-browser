/* global AbortController */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraftClient } from "../dist/client.js";
import { doctorChecks } from "../dist/doctor-checks.js";
import { DaemonHost } from "../dist/host.js";
import {
  DECLINED,
  SamplingBridge,
  fromSamplingResult,
  readSamplingCapabilities,
  readUseClientModel,
  setSamplingBridge,
  toSamplingMessages,
  writeUseClientModel,
} from "../dist/mcp-sampling.js";
import { SUPPORTED_PROTOCOL_VERSION } from "@graft/protocol";

const context = () => ({
  systemPrompt: "do the task",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [{ name: "read", description: "read a page", parameters: { type: "object" } }],
});

/** A GraftClient whose socket is a fake daemon, so no WebSocket or daemon is needed. */
function fakeClient(daemonReply) {
  const client = Object.create(GraftClient.prototype);
  client.waiting = new Map();
  client.sent = [];
  client.socket = {
    send(raw) {
      const request = JSON.parse(raw);
      client.sent.push(request);
      if (daemonReply) daemonReply(request, (message) => client.receive(message));
    },
  };
  return client;
}

function samplingBridge({ sampling = true, tools = true } = {}) {
  const bridge = new SamplingBridge();
  const caps = { capabilities: sampling ? { sampling: tools ? { tools: {} } : {} } : {} };
  bridge.learnCapabilities(caps);
  bridge.setUseClientModel(true);
  return bridge;
}

test("sampling capability is read from the client's initialize capabilities", () => {
  assert.deepEqual(readSamplingCapabilities({}), { sampling: false, tools: false });
  assert.deepEqual(readSamplingCapabilities({ capabilities: { roots: {} } }), {
    sampling: false,
    tools: false,
  });
  assert.deepEqual(readSamplingCapabilities({ capabilities: { sampling: {} } }), {
    sampling: true,
    tools: false,
  });
  assert.deepEqual(readSamplingCapabilities({ capabilities: { sampling: { tools: {} } } }), {
    sampling: true,
    tools: true,
  });
  assert.deepEqual(readSamplingCapabilities({ _meta: { sampling: { tools: {} } } }), {
    sampling: true,
    tools: true,
  });
});

test("messages become sampling text, and tool results keep their output", () => {
  const messages = toSamplingMessages([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: "body" }] },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: { type: "text", text: "hi" } },
    { role: "assistant", content: { type: "text", text: "ok" } },
    { role: "user", content: { type: "text", text: "Tool read result: body" } },
  ]);
});

test("sampling tool_use maps back to a Graft tool call", () => {
  const result = fromSamplingResult({
    content: [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "c1", name: "read", input: { url: "https://example.test" } },
    ],
  });
  assert.deepEqual(result.content[0], { type: "text", text: "thinking" });
  assert.deepEqual(result.content[1], {
    type: "toolCall",
    id: "c1",
    name: "read",
    arguments: { url: "https://example.test" },
  });
});

test("a fake MCP client that supports sampling answers a model call", async () => {
  const bridge = samplingBridge({ tools: true });
  let request;
  bridge.setSender((value) => {
    request = value;
    bridge.receive(value.id, {
      result: { content: [{ type: "text", text: "the answer" }], stopReason: "endTurn" },
    });
  });
  setSamplingBridge(bridge);
  const client = fakeClient();
  try {
    const reply = await client.modelComplete(context());
    assert.equal(reply.message.content[0].text, "the answer");
    assert.equal(reply.message.stopReason, "endTurn");
    assert.equal(client.sent.length, 0, "the call went to the agent, not the Graft daemon");
    assert.equal(request.method, "sampling/createMessage");
    assert.equal(request.params.maxTokens > 0, true);
    assert.equal(request.params.tools.length, 1, "tools are offered when the agent supports them");
  } finally {
    setSamplingBridge(undefined);
  }
});

test("without sampling, a model call gets the normal sign-in error", async () => {
  setSamplingBridge(undefined);
  const client = fakeClient((request, reply) => {
    reply({
      kind: "core.model.result",
      requestId: request.requestId,
      error: 'No AI model is connected. Sign in from the model picker ("Add or manage models…").',
    });
  });
  const host = new DaemonHost();
  host.connect = async () => client;
  await assert.rejects(() => host.model().complete(context()), /Sign in/);
  assert.equal(client.sent[0].kind, "core.model.complete", "a normal client uses Graft's model");
});

test("a client refusal becomes a clear Graft error", async () => {
  const bridge = samplingBridge();
  bridge.setSender((request) =>
    bridge.receive(request.id, { error: { code: -32000, message: "user said no" } }),
  );
  setSamplingBridge(bridge);
  const client = fakeClient();
  try {
    await assert.rejects(
      () => client.modelComplete(context()),
      (error) => {
        assert.equal(error.message, DECLINED);
        return true;
      },
    );
  } finally {
    setSamplingBridge(undefined);
  }
});

test("cancellation mid-sampling stops the call and writes no answer", async () => {
  const bridge = samplingBridge();
  let id;
  bridge.setSender((request) => (id = request.id));
  setSamplingBridge(bridge);
  const controller = new AbortController();
  try {
    const pending = bridge.complete(context(), 60_000, controller.signal);
    assert.equal(bridge.hasPending(id), true);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(bridge.hasPending(id), false);
    assert.equal(
      bridge.receive(id, { result: { content: [] } }),
      false,
      "a late answer is ignored",
    );
  } finally {
    setSamplingBridge(undefined);
  }
});

test("a notifications/cancelled for the sampling id stops that call", async () => {
  const bridge = samplingBridge();
  let id;
  bridge.setSender((request) => (id = request.id));
  const pending = bridge.complete(context(), 60_000);
  assert.equal(bridge.abort(id), true);
  await assert.rejects(pending, /cancelled/);
});

test("tools are omitted when the agent cannot use them in sampling", async () => {
  const bridge = samplingBridge({ tools: false });
  let request;
  bridge.setSender((value) => {
    request = value;
    bridge.receive(value.id, { result: { content: [{ type: "text", text: "plain" }] } });
  });
  setSamplingBridge(bridge);
  try {
    const reply = await fakeClient().modelComplete(context());
    assert.equal(reply.message.content[0].text, "plain");
    assert.equal(request.params.tools, undefined);
  } finally {
    setSamplingBridge(undefined);
  }
});

test("mcpUseClientModel is stored in Graft's data folder and can be overridden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graft-sampling-"));
  const env = { GRAFT_DATA_DIR: dir };
  try {
    assert.equal(await readUseClientModel(env), false);
    await writeUseClientModel(true, env);
    assert.equal(await readUseClientModel(env), true);
    assert.equal(await readUseClientModel({ ...env, GRAFT_MCP_USE_CLIENT_MODEL: "1" }), true);
    await writeUseClientModel(false, env);
    assert.equal(await readUseClientModel(env), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor names the agent's model when that is how Graft works", () => {
  const facts = {
    daemon: {
      ok: true,
      extension: true,
      engine: true,
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    },
    chromeCommandLines: [],
    modelSignedIn: false,
    loginTask: true,
    dirs: [],
  };
  const byName = (list) => Object.fromEntries(list.map((check) => [check.name, check]));
  const normal = byName(doctorChecks(facts)).model;
  assert.equal(normal.status, "fail");
  const sampled = byName(doctorChecks({ ...facts, mcpUsesClientModel: true })).model;
  assert.equal(sampled.status, "ok");
  assert.match(sampled.detail, /uses your agent's model through MCP/);
});
