import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { summarize } from "../dist/results.js";

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
    ["aeon_run", "aeon_run_status", "aeon_result", "aeon_trace", "aeon_chats"],
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

function mcp(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
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
