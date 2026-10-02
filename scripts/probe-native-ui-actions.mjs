import assert from "node:assert/strict";
import { installPageCommand, pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";

export async function exerciseBranchAndStop(send, sourceSessionId, sourceChatId, entryId) {
  const target = await openBranch(send, sourceSessionId, entryId);
  const branchId = new URL(target.url).searchParams.get("chatId");
  assert.ok(branchId && branchId !== sourceChatId);
  const attached = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  try {
    await waitUntil(
      () =>
        pageValue(
          send,
          attached.sessionId,
          'document.getElementById("connection-state")?.dataset.state',
        ),
      (state) => state === "connected",
      30_000,
      "Branch tab did not connect",
    );
    await installPageCommand(send, attached.sessionId);
    const view = await request(send, attached.sessionId, branchId, "chat.get");
    assert.ok(
      view.result?.snapshot.entries.some((entry) => entry.entryId === entryId),
      "Branch did not retain the selected native Pi entry",
    );
    await exerciseStop(send, attached.sessionId, branchId);
    assert.equal(
      await pageValue(send, sourceSessionId, "new URL(location.href).searchParams.get('chatId')"),
      sourceChatId,
    );
    return {
      branchButtonOpenedNativeFork: true,
      sourceTabPreserved: true,
      stopSettledActivePiRun: true,
    };
  } finally {
    await send("Target.closeTarget", { targetId: target.targetId });
  }
}

function request(send, sessionId, chatId, operation) {
  return pageValue(
    send,
    sessionId,
    `window.__pippinCommand({kind:"chat",chatId:${JSON.stringify(chatId)}},${JSON.stringify(operation)},{chatId:${JSON.stringify(chatId)}})`,
    60_000,
    "Native UI action evidence",
  );
}

async function openBranch(send, sourceSessionId, entryId) {
  const before = new Set(
    (await send("Target.getTargets")).targetInfos.map((target) => target.targetId),
  );
  await waitUntil(
    () =>
      pageValue(
        send,
        sourceSessionId,
        `(() => {const button=document.querySelector('[data-pi-entry-id="${entryId}"]')?.querySelector('[aria-label="Branch from response"]');return Boolean(button && !button.disabled);})()`,
      ),
    Boolean,
    30_000,
    "Restored native response did not expose its Branch action",
  );
  await pageValue(
    send,
    sourceSessionId,
    `(() => {
    const row=document.querySelector('[data-pi-entry-id="${entryId}"]');
    const button=row?.querySelector('[aria-label="Branch from response"]');
    if(!button || button.disabled) throw new Error("Branch action unavailable");
    button.click(); return true;
  })()`,
  );
  let target;
  await waitUntil(
    async () => {
      target = (await send("Target.getTargets")).targetInfos.find(
        (candidate) =>
          !before.has(candidate.targetId) &&
          candidate.type === "page" &&
          candidate.url.includes("/chat.html?"),
      );
      return target;
    },
    Boolean,
    45_000,
    "Branch button did not open a new Chat tab",
  );
  return target;
}

async function exerciseStop(send, sessionId, chatId) {
  await pageValue(
    send,
    sessionId,
    `(() => {
      const input=document.querySelector('#composer textarea');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(input,'Write an extensive explanation of graph algorithms, at least 10000 words. This is a cancellation test.');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#composer').requestSubmit(); return true;
    })()`,
  );
  await waitUntil(
    async () => {
      const controls = await request(send, sessionId, chatId, "chat.controls");
      return controls.result?.controls?.active;
    },
    Boolean,
    30_000,
    "Pi did not enter an active run for Stop acceptance",
  );
  await pageValue(
    send,
    sessionId,
    `(() => {const button=document.getElementById('stop'); if(!button || button.disabled) throw new Error('Stop unavailable'); button.click(); return true;})()`,
  );
  await waitUntil(
    async () => {
      const controls = await request(send, sessionId, chatId, "chat.controls");
      return controls.result?.controls?.active;
    },
    (active) => active === false,
    45_000,
    "Stop did not settle the native Pi run",
  );
}
