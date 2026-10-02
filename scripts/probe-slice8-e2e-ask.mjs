import { pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";

export async function askFromNewTab(
  send,
  sessionId,
  expectedSelection = null,
  setStage = () => {},
) {
  await waitForModelCatalog(send, sessionId);
  setStage("home Ask selected controls checkpoint");
  const selection = await readHomeSelection(send, sessionId, expectedSelection);
  setStage("home Ask input commit checkpoint");
  await commitAskInput(send, sessionId);
  setStage("Ask submit");
  const submittedAt = Date.now();
  await pageValue(
    send,
    sessionId,
    `document.getElementById("home-form").requestSubmit(); true`,
    30_000,
    "Submit Ask",
    [PROMPT],
  );
  return { submitted: true, model: selection.model, effort: selection.effort, submittedAt };
}

const PROMPT = "Reply with the exact words: Slice 8 Pi is ready.";

async function waitForModelCatalog(send, sessionId) {
  await waitUntil(
    () =>
      pageValue(
        send,
        sessionId,
        `document.getElementById("home-model-picker")?.firstElementChild?.textContent?.trim()`,
      ),
    (label) => Boolean(label) && label !== "Pi model unavailable",
    30_000,
    "Pi model catalog did not load before Ask",
  );
}

async function readHomeSelection(send, sessionId, expectedSelection) {
  return pageValue(
    send,
    sessionId,
    `(() => { const model=document.getElementById("home-model-picker")?.firstElementChild?.textContent?.trim()??""; const effort=document.getElementById("home-thinking-picker")?.firstElementChild?.textContent?.trim().toLowerCase()??""; if (!model || !effort) throw new Error("HOME_SELECTION_MISSING"); if (${JSON.stringify(expectedSelection)} && (model!==${JSON.stringify(expectedSelection?.label)} || effort!==${JSON.stringify(expectedSelection?.thinkingLevel)})) throw new Error("HOME_SELECTION_MISMATCH"); if (document.querySelector(".home-start [id^='mode-']")) throw new Error("HOME_HAS_SEARCH_MODE"); return {model,effort}; })()`,
    30_000,
    "Verify model and effort before Ask",
  );
}

async function commitAskInput(send, sessionId) {
  await pageValue(
    send,
    sessionId,
    `(() => { const field=document.getElementById("home-query"); if (!(field instanceof HTMLInputElement)) throw new Error("HOME_QUERY_MISSING"); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(field,${JSON.stringify(PROMPT)}); field.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`,
    30_000,
    "Set Ask input value",
    [PROMPT],
  );
  await waitUntil(
    () =>
      pageValue(
        send,
        sessionId,
        `(() => { const field=document.getElementById("home-query"); const button=document.querySelector("#home-form button[type=submit]"); return {value:field?.value??"",disabled:button?.disabled??true}; })()`,
        30_000,
        "Wait for Ask input state",
        [PROMPT],
      ),
    (state) => state.value === PROMPT && state.disabled === false,
    5_000,
    "Ask input value did not commit before submit",
  );
}
