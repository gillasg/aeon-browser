import assert from "node:assert/strict";
import test from "node:test";
import { projectMessage } from "../dist/pi-message-projection.js";

test("Pi nested tool records project bounded arguments and outcomes without result bodies", () => {
  const projected = projectMessage({
    role: "toolResult",
    toolCallId: "outer-call",
    toolName: "codemode",
    isError: false,
    content: [{ type: "text", text: "script finished" }],
    nestedCalls: {
      complete: false,
      calls: [
        {
          id: "outer-call/1",
          name: "mcp__docs__search",
          arguments: { query: "reference" },
          status: "ok",
          durationMs: 23,
        },
        {
          id: "outer-call/2",
          name: "mcp__docs__read",
          argumentsBytes: 9000,
          status: "error",
          error: "x".repeat(800),
        },
      ],
    },
  });

  assert.equal(projected.role, "tool");
  assert.deepEqual(projected.nestedCalls, {
    complete: false,
    calls: [
      {
        id: "outer-call/1",
        name: "mcp__docs__search",
        arguments: { query: "reference" },
        status: "ok",
        durationMs: 23,
      },
      {
        id: "outer-call/2",
        name: "mcp__docs__read",
        argumentsBytes: 9000,
        status: "error",
        error: "x".repeat(500),
      },
    ],
  });
  assert.equal("result" in projected.nestedCalls.calls[0], false);
});

test("Pi nested records mark omitted and malformed children incomplete", () => {
  const calls = Array.from({ length: 257 }, (_, index) => ({
    id: `outer/${index}`,
    name: "read",
    status: "ok",
  }));
  calls[10] = { id: "", name: "", status: "bad" };
  const projected = projectMessage({
    role: "toolResult",
    toolCallId: "outer",
    toolName: "codemode",
    isError: false,
    content: [],
    nestedCalls: { complete: true, calls },
  });
  assert.equal(projected.nestedCalls?.calls.length, 255);
  assert.equal(projected.nestedCalls?.complete, false);
});
