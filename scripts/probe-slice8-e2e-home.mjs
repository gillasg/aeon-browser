import assert from "node:assert/strict";
import { join } from "node:path";
import { chooseHomeEffort, chooseHomeModel, openHomePicker } from "./probe-slice8-e2e-helpers.mjs";
import { askFromNewTab } from "./probe-slice8-e2e-ask.mjs";
import { pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";
import { captureScreenshot } from "./probe-slice8-e2e-screenshots.mjs";

export async function captureHomeAndAsk(send, sessionId, root, setStage, recordEvidence) {
  await connectHome(send, sessionId, setStage, recordEvidence);
  const screenshots = await selectHomeModelAndEffort(
    send,
    sessionId,
    root,
    setStage,
    recordEvidence,
  );
  setStage("home Ask prompt readiness");
  const initialSelection = {
    ...screenshots.selectedModel,
    thinkingLevel: screenshots.effortSelection.selected,
  };
  const initialAsk = await askFromNewTab(send, sessionId, initialSelection, setStage);
  assert.equal(initialAsk.submitted, true);
  assert.equal(initialAsk.model, initialSelection.label);
  assert.equal(initialAsk.effort, initialSelection.thinkingLevel);
  return { ...screenshots, initialSelection, submittedAt: initialAsk.submittedAt };
}

async function connectHome(send, sessionId, setStage, recordEvidence) {
  let checkpoint;
  setStage("home connection checkpoint");
  await waitForHomeState(
    send,
    sessionId,
    recordEvidence,
    "connection",
    { connectionLabel: "Connected" },
    (state) => state.connectionLabel === "Connected",
    "New Tab did not connect",
  );
  setStage("home model catalog checkpoint");
  checkpoint = await waitForHomeState(
    send,
    sessionId,
    recordEvidence,
    "catalog",
    {
      modelPickerExists: true,
      modelCountAtLeast: 1,
      modelPickerLabelNot: "Pi model unavailable",
    },
    (state) =>
      state.modelPickerExists &&
      state.modelCount > 0 &&
      state.modelPickerLabel !== "Pi model unavailable",
    "Pi model catalog did not load on New Tab",
  );
  setStage("home surface contract checkpoint");
  const expected = {
    modeControlCount: 0,
    searchPermission: false,
    queryExists: true,
    queryPlaceholder: "Ask Pippin anything",
  };
  const actual = {
    modeControlCount: checkpoint.modeControlCount,
    searchPermission: checkpoint.searchPermission,
    queryExists: checkpoint.queryExists,
    queryPlaceholder: checkpoint.queryPlaceholder,
  };
  const passed = Object.keys(expected).every((key) => actual[key] === expected[key]);
  recordEvidence("surfaceContract", { expected, actual, passed });
  if (!passed) throw new Error("HOME_SURFACE_CONTRACT_MISMATCH");
}

async function waitForHomeState(
  send,
  sessionId,
  recordEvidence,
  key,
  expected,
  predicate,
  message,
) {
  let latest = {};
  try {
    await waitUntil(
      async () => {
        latest = await readHomeCheckpoint(send, sessionId);
        recordEvidence(key, latest);
        return latest;
      },
      predicate,
      30_000,
      message,
    );
    recordEvidence(`${key}Assertion`, { expected, actual: latest, passed: true });
  } catch {
    recordEvidence(`${key}Assertion`, { expected, actual: latest, passed: false });
    throw new Error(message);
  }
  return latest;
}

async function readHomeCheckpoint(send, sessionId) {
  return pageValue(
    send,
    sessionId,
    `(() => {
      const picker=document.getElementById("home-model-picker");
      const modelDetails=picker?.closest("details");
      const options=[...(modelDetails?.querySelectorAll('button[role="option"]')??[])];
      const manifest=globalThis.chrome?.runtime?.getManifest?.()??{};
      const query=document.getElementById("home-query");
      const connection=document.getElementById("home-connection");
      return {
        connectionLabel:connection?.textContent?.trim()??null,
        connectionState:connection?.dataset?.state??null,
        connectionError:document.getElementById("home-error")?.textContent?.trim()??null,
        modelPickerExists:Boolean(picker),
        modelPickerLabel:picker?.firstElementChild?.textContent?.trim()??null,
        modelCount:options.length,
        providerModelIds:options.slice(0,60).map((option)=>({provider:option.closest(".pi-picker-group")?.getAttribute("aria-label")??null,id:option.getAttribute("data-model-id")??null})),
        modeControlCount:document.querySelectorAll(".home-start [id^='mode-']").length,
        searchPermission:[...(manifest.permissions??[]),...(manifest.optional_permissions??[])].includes("search"),
        queryExists:Boolean(query),
        queryPlaceholder:query?.getAttribute("placeholder")??null,
        homeErrorVisible:Boolean(document.getElementById("home-error"))
      };
    })()`,
  );
}

async function selectHomeModelAndEffort(send, sessionId, root, setStage, recordEvidence) {
  const homeScreenshot = join(root, "artifacts", "slice8-new-tab-home.png");
  await captureScreenshot(send, sessionId, homeScreenshot);
  setStage("home model picker checkpoint");
  const modelOptions = await openHomePicker(send, sessionId, "home-model-picker");
  const modelPickerScreenshot = join(root, "artifacts", "slice8-new-tab-model-picker.png");
  await captureScreenshot(send, sessionId, modelPickerScreenshot);
  const selectedModel = await selectExpectedModel(send, sessionId, modelOptions, recordEvidence);
  const { effortPickerScreenshot, selection } = await selectExpectedEffort(
    send,
    sessionId,
    root,
    setStage,
    recordEvidence,
  );
  return {
    homeScreenshot,
    modelPickerScreenshot,
    effortPickerScreenshot,
    selectedModel,
    effortSelection: selection,
  };
}

async function selectExpectedModel(send, sessionId, options, recordEvidence) {
  const hasExpectedModel = options.some(
    (option) => option.provider === "openai-codex" && option.id === "gpt-6-luna",
  );
  const visibleOptions = options.slice(0, 60).map(({ provider, id }) => ({ provider, id }));
  recordEvidence("modelPickerAssertion", {
    expected: { provider: "openai-codex", id: "gpt-6-luna" },
    actual: visibleOptions,
    passed: hasExpectedModel,
  });
  recordEvidence("modelPickerOptions", visibleOptions);
  if (!hasExpectedModel)
    throw new Error("The Pi model catalog did not expose the expected Codex Luna option");
  const alternateModel = options.find(
    (option) => option.provider === "openai-codex" && option.id !== "gpt-6-luna",
  );
  if (alternateModel) {
    const alternateSelection = await chooseHomeModel(
      send,
      sessionId,
      alternateModel.provider,
      alternateModel.id,
    );
    recordEvidence("alternateModelSelection", alternateSelection);
  }
  const selected = await chooseHomeModel(send, sessionId, "openai-codex", "gpt-6-luna");
  recordEvidence("selectedModel", selected);
  recordEvidence("selectedModelAssertion", {
    expected: { provider: "openai-codex", id: "gpt-6-luna" },
    actual: selected,
    passed: selected.provider === "openai-codex" && selected.id === "gpt-6-luna",
  });
  return selected;
}

async function selectExpectedEffort(send, sessionId, root, setStage, recordEvidence) {
  setStage("home effort picker checkpoint");
  const options = await openHomePicker(send, sessionId, "home-thinking-picker");
  const actual = options.slice(0, 40).map((option) => option.text);
  const supportsLow = options.some((option) => option.text.toLowerCase() === "low");
  recordEvidence("effortPickerAssertion", {
    expected: { effort: "low" },
    actual,
    passed: supportsLow,
  });
  recordEvidence("effortOptions", actual);
  if (!supportsLow)
    throw new Error("The selected Pi model does not expose the expected low effort option");
  const screenshot = join(root, "artifacts", "slice8-new-tab-effort-picker.png");
  await captureScreenshot(send, sessionId, screenshot);
  const selection = await chooseHomeEffort(send, sessionId, "low");
  const passed = selection.selected === "low";
  recordEvidence("selectedEffortAssertion", {
    expected: "low",
    actual: selection.selected,
    passed,
  });
  if (!passed) throw new Error("The selected effort did not persist");
  recordEvidence("selectedEffort", selection.selected);
  return { effortPickerScreenshot: screenshot, selection };
}
