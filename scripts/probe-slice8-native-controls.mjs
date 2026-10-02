import assert from "node:assert/strict";
import { exerciseBranchAndStop } from "./probe-native-ui-actions.mjs";
import { exerciseManagement } from "./probe-native-management.mjs";
import {
  attachPage,
  installPageCommand,
  pageValue,
  waitUntil,
} from "./probe-browser-control-cft-browser.mjs";

export async function exerciseNativeControls({ send, sessionId, panelSessionId, chatId }) {
  const original = await readView(send, sessionId, chatId);
  const messages = original.entries.filter((entry) => entry.message);
  const user = messages.find((entry) => entry.message.role === "user");
  const leaf = original.entries.at(-1);
  assert.ok(user && leaf, "Native transcript entries are unavailable");
  const expected = user.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const fullTab = await editAndRestore(
    send,
    sessionId,
    sessionId,
    chatId,
    user,
    leaf,
    expected,
    false,
  );
  const panel = await editAndRestore(
    send,
    sessionId,
    panelSessionId,
    chatId,
    user,
    leaf,
    expected,
    true,
  );
  await verifyNativeFork(send, sessionId, chatId, leaf, messages);
  const restored = await readView(send, sessionId, chatId);
  assert.equal(restored.entries.length, original.entries.length);
  const assistant = messages.findLast(
    (entry) =>
      entry.message.role === "assistant" &&
      entry.message.content.some((block) => block.type === "text" && block.text.trim().length > 0),
  );
  assert.ok(assistant, "No native assistant entry is available for branch acceptance");
  const uiActions = await exerciseBranchAndStop(send, sessionId, chatId, assistant.entryId);
  const management = await exerciseManagement(send, sessionId);
  return { fullTab, panel, forkCreated: true, sourcePreserved: true, uiActions, management };
}

async function editAndRestore(
  send,
  commandSession,
  uiSession,
  chatId,
  user,
  leaf,
  expected,
  panel,
) {
  const documentExpression = panel
    ? 'document.querySelector("#chat-frame").contentDocument'
    : "document";
  await pageValue(
    send,
    uiSession,
    `(() => {
    const doc=${documentExpression};
    const row=doc.querySelector('[data-pi-entry-id="${user.entryId}"]');
    const button=row?.querySelector('[aria-label="Edit message"]');
    if (!button || button.disabled) throw new Error("Edit action unavailable");
    button.click(); return true;
  })()`,
  );
  await waitUntil(
    () =>
      pageValue(
        send,
        uiSession,
        `(() => {
    const doc=${documentExpression};
    return doc.querySelector('#composer textarea')?.value ?? null;
  })()`,
      ),
    (draft) => draft === expected,
    30_000,
    "Native edit did not restore the composer draft",
  );
  const edited = await readView(send, commandSession, chatId);
  assert.equal(
    edited.entries.some((entry) => entry.entryId === leaf.entryId),
    false,
    "Edit did not navigate away from the previous response",
  );
  const navigation = await command(send, commandSession, chatId, "chat.navigate-tree", {
    entryId: leaf.entryId,
  });
  assert.equal(
    navigation.result?.cancelled,
    false,
    `Native navigation failed: ${navigation.kind} / ${navigation.result?.kind ?? navigation.code}`,
  );
  assert.equal(
    navigation.result?.entryId,
    leaf.entryId,
    "Native navigation chose a different entry",
  );
  return { draftRestored: true, noAutomaticSend: true, treeRestored: true };
}

async function command(send, sessionId, chatId, operation, payload = {}) {
  return pageValue(
    send,
    sessionId,
    `window.__pippinCommand({kind:"chat",chatId:${JSON.stringify(chatId)}},${JSON.stringify(operation)},${JSON.stringify({ chatId, ...payload })})`,
    60_000,
    "Native transcript command",
  );
}

async function readView(send, sessionId, chatId) {
  const reply = await command(send, sessionId, chatId, "chat.get");
  assert.equal(reply.kind, "command.completed", `Native transcript read failed: ${reply.code}`);
  assert.ok(reply.result?.snapshot);
  return reply.result.snapshot;
}

async function verifyNativeFork(send, sessionId, chatId, leaf, messages) {
  const fork = await command(send, sessionId, chatId, "chat.fork-message", {
    entryId: leaf.entryId,
  });
  assert.equal(
    fork.result?.status,
    "ready",
    `Native fork failed: ${fork.kind} / ${fork.result?.kind ?? fork.code} / ${fork.message ?? ""}`,
  );
  assert.ok(fork.result.targetChatId && fork.result.targetChatId !== chatId);
  const url = await pageValue(send, sessionId, "location.href");
  const branchUrl = new URL(url);
  branchUrl.searchParams.set("chatId", fork.result.targetChatId);
  const branchPage = await attachPage(send, branchUrl.href);
  let branch;
  try {
    await waitUntil(
      () => pageValue(send, branchPage.sessionId, "document.readyState"),
      (state) => state === "complete",
      15_000,
      "Fork page did not load",
    );
    await installPageCommand(send, branchPage.sessionId);
    branch = await readView(send, branchPage.sessionId, fork.result.targetChatId);
  } finally {
    await send("Target.closeTarget", { targetId: branchPage.targetId });
  }
  assert.equal(
    branch.entries.filter((entry) => entry.message?.role === "user").length,
    messages.filter((entry) => entry.message.role === "user").length,
  );
}
