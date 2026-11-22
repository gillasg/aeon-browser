import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebsearchTool,
  EXA_MCP_URL,
  exaRequest,
  exaUrl,
  NO_RESULTS,
  parseExaResponse,
  websearch,
  websearchDescription,
} from "../dist/websearch-tool.js";
import { createChatTools } from "../dist/chat-tools.js";

const rpc = (text) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });

function mockFetch(body, init = {}) {
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({ url, request, body: JSON.parse(request.body) });
    return new globalThis.Response(body, { status: 200, ...init });
  };
  return { fetcher, calls };
}

test("parses a JSON body and an SSE stream", () => {
  assert.equal(parseExaResponse(rpc("hello")), "hello");
  const sse = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"from sse"}]}}\n\n`;
  assert.equal(parseExaResponse(sse), "from sse");
  assert.equal(parseExaResponse("event: ping\ndata: not json\n"), undefined);
  assert.equal(parseExaResponse(""), undefined);
  assert.throws(() => parseExaResponse(JSON.stringify({ error: { message: "bad" } })), /bad/);
});

test("sends OpenCode's request with defaults and optional parameters", async () => {
  const { fetcher, calls } = mockFetch(rpc("results"));
  assert.equal(await websearch({ query: "q" }, { fetch: fetcher }), "results");
  assert.deepEqual(calls[0].body.params, {
    name: "web_search_exa",
    arguments: { query: "q", type: "auto", numResults: 8, livecrawl: "fallback" },
  });
  assert.equal(calls[0].body.method, "tools/call");
  assert.equal(calls[0].request.headers.accept, "application/json, text/event-stream");
  const custom = exaRequest({
    query: "q",
    numResults: 3,
    livecrawl: "preferred",
    type: "deep",
    contextMaxCharacters: 500,
  });
  assert.deepEqual(custom.params.arguments, {
    query: "q",
    type: "deep",
    numResults: 3,
    livecrawl: "preferred",
    contextMaxCharacters: 500,
  });
});

test("EXA_API_KEY is optional", () => {
  assert.equal(exaUrl(""), EXA_MCP_URL);
  assert.equal(exaUrl("k1"), `${EXA_MCP_URL}?exaApiKey=k1`);
});

test("empty results say so; HTTP errors are named", async () => {
  const empty = mockFetch(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
  assert.equal(await websearch({ query: "q" }, { fetch: empty.fetcher }), NO_RESULTS);
  for (const [status, pattern] of [
    [429, /rate limited/],
    [401, /authentication/],
    [500, /HTTP 500/],
  ]) {
    const { fetcher } = mockFetch("nope", { status });
    await assert.rejects(websearch({ query: "q" }, { fetch: fetcher }), pattern);
  }
});

function hangingFetch() {
  return (_url, request) =>
    new Promise((_resolve, reject) => {
      if (request.signal.aborted) return reject(request.signal.reason);
      // AbortSignal.timeout uses an unref'd timer in Node, so keep the loop alive like a real socket.
      const keepAlive = globalThis.setTimeout(() => undefined, 5_000);
      request.signal.addEventListener(
        "abort",
        () => {
          globalThis.clearTimeout(keepAlive);
          reject(request.signal.reason);
        },
        { once: true },
      );
    });
}

test("times out and respects the run's abort signal", async () => {
  await assert.rejects(
    websearch({ query: "q" }, { fetch: hangingFetch(), timeoutMs: 20 }),
    /timed out/,
  );
  const controller = new globalThis.AbortController();
  const pending = websearch({ query: "q" }, { fetch: hangingFetch(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /stopped/);
});

test("the tool returns text, errors as isError, and bounds big results", async () => {
  const tool = createWebsearchTool(undefined, mockFetch(rpc("short")).fetcher);
  assert.equal(tool.name, "websearch");
  assert.match(tool.description, new RegExp(`current year is ${new Date().getFullYear()}`));
  const ok = await tool.execute("c1", { query: "q" }, undefined, undefined);
  assert.equal(ok.content[0].text, "short");
  const failing = createWebsearchTool(undefined, mockFetch("x", { status: 429 }).fetcher);
  const bad = await failing.execute("c2", { query: "q" }, undefined, undefined);
  assert.equal(bad.isError, true);
  const big = createWebsearchTool(undefined, mockFetch(rpc("a".repeat(20_000))).fetcher);
  const bounded = await big.execute("c3", { query: "q" }, undefined, undefined);
  assert.ok(bounded.content[0].text.length < 20_000);
  assert.match(websearchDescription(2030), /AI news 2030", NOT "AI news 2029"/);
});

test("websearch is registered as a built-in chat tool", () => {
  const names = createChatTools({
    chatId: "c",
    workingDirectory: "/tmp",
    sessionDirectory: "/tmp/sessions",
    completion: {},
  }).map((tool) => tool.name);
  assert.ok(names.includes("websearch"), names.join(", "));
});
