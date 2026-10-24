import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { summarize } from "../dist/results.js";
import { runTasks } from "../dist/run.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const at = "2026-10-12T10:00:00.000Z";
const entry = (message) => ({
  entryId: Math.random().toString(),
  parentEntryId: null,
  category: "message",
  timestamp: at,
  message,
});

test("a finished chat yields its answer and a trace pairing each call with its result", () => {
  const result = summarize(
    "chat-1",
    "Find the price",
    {
      chat: { chatId: "chat-1", title: "Find the price" },
      runState: "idle",
      contextUsage: { tokens: 1200 },
      entries: [
        entry({ role: "user", content: [{ type: "text", text: "Find the price" }] }),
        entry({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "a",
              toolName: "browser_code",
              arguments: { code: "x" },
            },
          ],
        }),
        entry({
          role: "tool",
          toolCallId: "a",
          toolName: "browser_code",
          isError: true,
          content: [
            { type: "text", text: "steps:\n- openTab https://a.test/ -> tab 4\nerror: blocked" },
          ],
        }),
        entry({
          role: "assistant",
          content: [{ type: "text", text: "It costs ₹69,900." }],
          stopReason: "stop",
        }),
      ],
    },
    42_000,
    "finished",
  );
  assert.equal(result.status, "finished");
  assert.equal(result.answer, "It costs ₹69,900.");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolErrors, 1);
  assert.equal(result.tabsOpened, 1);
  assert.equal(result.seconds, 42);
  assert.equal(result.contextTokens, 1200);
  assert.match(result.trace[0].summary, /error: blocked/);
});

test("a chat that ended in an error is reported as failed with the error", () => {
  const result = summarize(
    "chat-2",
    "x",
    {
      chat: { chatId: "chat-2", title: "x" },
      runState: "idle",
      contextUsage: null,
      entries: [
        entry({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Model quota exceeded",
        }),
      ],
    },
    1000,
    "finished",
  );
  assert.equal(result.status, "failed");
  assert.equal(result.answer, "Model quota exceeded");
});

test("the MCP server lists its tools without a running Aeon", async () => {
  const replies = await mcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(replies[0].result.serverInfo.name, "aeon");
  assert.deepEqual(
    replies[1].result.tools.map((tool) => tool.name),
    [
      "aeon_run",
      "aeon_run_status",
      "aeon_result",
      "aeon_stop",
      "aeon_trace",
      "aeon_chats",
      "aeon_search",
      "aeon_context",
      "aeon_routine",
    ],
  );
});

test("the CLI says plainly when Aeon is not running", async () => {
  const home = await mkdtemp(join(tmpdir(), "aeon-cli-"));
  try {
    const { code, stderr } = await runCli(["chats"], { AEON_DATA_DIR: home });
    assert.equal(code, 1);
    assert.match(stderr, /Aeon is not running/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a quiet run submits the prompt through the daemon and opens no tab", async () => {
  const client = fakeClient();
  const [result] = await runTasks(client, ["Find the price"], {
    parallel: 1,
    quiet: true,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "finished");
  assert.deepEqual(client.opens, []);
  assert.deepEqual(client.submits, [
    {
      chatId: "chat-1",
      text: "Find the price",
      selection: { model: { provider: "aeon-fixture", id: "model-one" }, thinkingLevel: "low" },
    },
  ]);
  assert.equal(
    client.commands.some((command) => command.operation === "chat.create"),
    true,
  );
});

test("a run with a tab still submits directly, so a loading tab cannot hold it up", async () => {
  const client = fakeClient();
  const [result] = await runTasks(client, ["Open the page"], {
    parallel: 1,
    quiet: false,
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "finished");
  assert.deepEqual(client.opens, ["chat-1"]);
  assert.equal(client.submits.length, 1);
  assert.equal(client.submits[0].text, "Open the page");
});

function fakeClient() {
  const commands = [];
  const opens = [];
  const submits = [];
  let attention;
  return {
    commands,
    opens,
    submits,
    async command(operation, payload) {
      commands.push({ operation, payload });
      if (operation === "chat.model-catalog")
        return {
          catalog: {
            defaultModel: { provider: "aeon-fixture", id: "model-one" },
            models: [
              {
                provider: "aeon-fixture",
                id: "model-one",
                name: "Model One",
                defaultThinkingLevel: "low",
                thinkingLevels: ["low", "high"],
              },
            ],
          },
        };
      if (operation === "chat.create") return { chat: { chatId: "chat-1" } };
      if (operation === "chat.get")
        return {
          snapshot: {
            chat: { chatId: "chat-1", title: "A chat" },
            runState: "idle",
            contextUsage: null,
            entries: [],
            omittedEntryCount: 0,
          },
        };
      return {};
    },
    async openChat(chatId) {
      opens.push(chatId);
      return 1;
    },
    submit(chatId, text, selection) {
      submits.push({ chatId, text, selection });
      attention?.([{ chatId, working: true, completionId: null }]);
      setTimeout(() => attention?.([{ chatId, working: false, completionId: "completed" }]), 0);
      return Promise.resolve();
    },
    onAttention(listener) {
      attention = listener;
      return () => {
        attention = undefined;
      };
    },
  };
}

function mcp(messages) {
  return new Promise((resolve, reject) => {
    // An empty data folder, so an Aeon running on this machine does not add its tools.
    const child = spawn(process.execPath, [cli, "mcp"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, AEON_DATA_DIR: join(tmpdir(), "aeon-cli-mcp-" + process.pid) },
    });
    let buffer = "";
    const replies = [];
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (replies.length === messages.length) {
          child.kill();
          resolve(replies);
        }
      }
    });
    child.on("error", reject);
    for (const message of messages) child.stdin.write(JSON.stringify(message) + "\n");
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
