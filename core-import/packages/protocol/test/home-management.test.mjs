import assert from "node:assert/strict";
import test from "node:test";
import { DaemonUiRequestSchema, DaemonUiResponseSchema } from "../dist/index.js";

test("home routine cards use a narrow catalog-scoped projection", () => {
  const request = {
    kind: "command",
    requestId: "dc92e26f-b0b1-4d47-a6e5-64f36440c2ba",
    operation: "management.home",
    payload: {},
  };
  assert.equal(DaemonUiRequestSchema.parse(request).operation, "management.home");
  assert.equal(
    DaemonUiRequestSchema.safeParse({ ...request, payload: { chatId: "not-needed" } }).success,
    false,
  );
  const card = {
    routineId: "dba04e2b-7f59-4a1a-848c-098413417db8",
    chatId: "1c8e73dc-f996-4aac-94ae-198773512ab3",
    chatTitle: "Research",
    title: "Morning summary",
    nextDueAt: "2026-09-30T08:00:00.000Z",
    enabled: true,
  };
  const response = {
    kind: "command.completed",
    requestId: request.requestId,
    operation: "management.home",
    result: { kind: "management.home", snapshot: { routines: [card] } },
  };
  assert.equal(
    DaemonUiResponseSchema.parse(response).result.snapshot.routines[0].title,
    card.title,
  );
  const privateCard = { ...card, instruction: "private prompt" };
  const privateResponse = {
    ...response,
    result: { ...response.result, snapshot: { routines: [privateCard] } },
  };
  assert.equal(DaemonUiResponseSchema.safeParse(privateResponse).success, false);
});
