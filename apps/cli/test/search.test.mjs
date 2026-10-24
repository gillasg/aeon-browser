import assert from "node:assert/strict";
import test from "node:test";
import { searchAeon } from "../dist/search.js";

test("search reads chats through the catalog and filters saved answers", async () => {
  const calls = [];
  const client = {
    async command(operation, payload) {
      calls.push({ operation, payload });
      if (operation === "chat.list")
        return {
          chats: [
            {
              chatId: "00000000-0000-4000-8000-000000000001",
              title: "Lamp shopping",
              origin: "user",
              matchExcerpt: "found a lamp",
            },
          ],
        };
      if (operation === "management.get")
        return {
          snapshot: {
            pins: [
              {
                pinId: "00000000-0000-4000-8000-000000000002",
                title: "Lamp price",
                value: "₹2,499",
                source: "api",
              },
              {
                pinId: "00000000-0000-4000-8000-000000000003",
                title: "Flights",
                value: "₹8,000",
                source: "api",
              },
            ],
          },
        };
      throw new Error(`unexpected ${operation}`);
    },
  };

  const result = await searchAeon(
    client,
    "lamp",
    { origin: "user", since: "2026-10-01", until: "2026-10-02" },
    10,
  );

  assert.equal(result.query, "lamp");
  assert.deepEqual(
    result.chats.map((chat) => chat.title),
    ["Lamp shopping"],
  );
  assert.deepEqual(
    result.pins.map((pin) => pin.title),
    ["Lamp price"],
  );
  assert.deepEqual(calls[0], {
    operation: "chat.list",
    payload: {
      limit: 10,
      includeArchived: true,
      query: "lamp",
      origin: "user",
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-03T00:00:00.000Z",
    },
  });
  assert.deepEqual(calls[1], { operation: "management.get", payload: {} });
});
