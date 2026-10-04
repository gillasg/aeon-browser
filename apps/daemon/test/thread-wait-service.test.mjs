import assert from "node:assert/strict";
import test from "node:test";
import { asChatId } from "@pippin/domain";
import { ThreadWaitService } from "../dist/thread-wait-service.js";

const firstChat = asChatId("c1900cbf-d3cc-49d8-aab0-8a5e6ff5c1f3");
const secondChat = asChatId("2a591b50-24ec-45bb-a771-20c535e68e2f");
const thirdChat = asChatId("bec65501-1621-4868-bd1d-23d3e77301e9");
const firstDelivery = "40a51d43-172a-4d82-b465-b85e9089c6a1";
const secondDelivery = "3ab04ba7-79cf-468e-a7ef-dcb25447911e";

test("wait resolves only the exact sender, recipient, and delivery identity", async () => {
  const records = new Map([
    [
      firstDelivery,
      {
        deliveryId: firstDelivery,
        senderChatId: firstChat,
        recipientChatId: secondChat,
        state: "completed",
      },
    ],
  ]);
  const wait = makeWaitService(records);
  const result = JSON.parse(
    await wait.wait(firstChat, {
      deliveries: [{ threadId: secondChat, deliveryId: firstDelivery }],
      timeoutMs: 0,
    }),
  );
  assert.equal(result.state, "completed");
  assert.equal(result.deliveries[0].deliveryId, firstDelivery);
  await assert.rejects(
    wait.wait(firstChat, {
      deliveries: [{ threadId: thirdChat, deliveryId: firstDelivery }],
      timeoutMs: 0,
    }),
    /exact thread/,
  );
});

test("wait reports timeout for nonterminal delivery and detects transient wait cycles", async () => {
  const records = new Map([
    [
      firstDelivery,
      {
        deliveryId: firstDelivery,
        senderChatId: firstChat,
        recipientChatId: secondChat,
        state: "running",
      },
    ],
    [
      secondDelivery,
      {
        deliveryId: secondDelivery,
        senderChatId: secondChat,
        recipientChatId: firstChat,
        state: "running",
      },
    ],
  ]);
  const wait = makeWaitService(records);
  const pendingWait = wait.wait(firstChat, {
    deliveries: [{ threadId: secondChat, deliveryId: firstDelivery }],
    timeoutMs: 100,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    wait.wait(secondChat, {
      deliveries: [{ threadId: firstChat, deliveryId: secondDelivery }],
      timeoutMs: 100,
    }),
    /coordination cycle/,
  );
  assert.equal(JSON.parse(await pendingWait).state, "timeout");
});

function makeWaitService(records) {
  const store = { getThreadDelivery: (deliveryId) => records.get(deliveryId) };
  const chats = {
    getChatView: async () => ({
      cursor: { epoch: "c095d1c9-c3bf-416c-b80e-2df546604c4b", revision: 1 },
    }),
  };
  return new ThreadWaitService(chats, store);
}
