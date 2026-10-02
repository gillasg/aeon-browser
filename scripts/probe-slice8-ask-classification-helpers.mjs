import { existsSync } from "node:fs";
import { delay } from "./probe-browser-control-cft-browser.mjs";
import { stopChild } from "./mv3-probe-helpers.mjs";
import { hasPippinProcess } from "./probe-browser-control-cft-helpers.mjs";

export function isTerminalCheckpoint(checkpoint) {
  return Boolean(
    checkpoint.ui.answerMatched ||
    checkpoint.ui.messageErrorPresent ||
    settledSubmit(checkpoint.events) ||
    terminalAssistant(checkpoint.pi.entries),
  );
}

export function classifyBoundary(checkpoint) {
  return (
    classifyHandoff(checkpoint.events) ??
    classifySubmit(checkpoint.events) ??
    classifyUiAndPi(checkpoint)
  );
}

export async function cleanupProbe(connection, chrome, nativeSetup) {
  const errors = [];
  const browserExitCode = await closeBrowser(connection, chrome, errors);
  const cleanupState = await cleanupNativeSetup(nativeSetup, errors);
  const incomplete =
    errors.length > 0 ||
    cleanupState.tempDirectoriesRemain ||
    cleanupState.databaseRemains ||
    cleanupState.pippinProcessRemains;
  return {
    status: incomplete ? "incomplete" : "complete",
    errors,
    ...cleanupState,
    browserExitCode,
  };
}

function settledSubmit(events) {
  return events.some(
    (event) =>
      event.operation === "chat.submit" &&
      ["command.settled", "command.failed"].includes(event.kind),
  );
}

function terminalAssistant(entries = []) {
  return entries.some(
    (entry) =>
      entry.role === "assistant" && ["stop", "error", "aborted"].includes(entry.stopReason),
  );
}

function classifyHandoff(events) {
  const open = events.find(
    (event) => event.kind === "pippin.native.open-chat" && event.direction === "receive",
  );
  if (open && !open.ok) return "open_chat_failed";
  const take = events.find(
    (event) => event.kind === "pippin.native.take-initial-submit" && event.direction === "receive",
  );
  if (!take) return "staged_prompt_take_not_observed";
  if (!take.ok) return "staged_prompt_take_failed";
  return undefined;
}

function classifySubmit(events) {
  if (
    events.some(
      (event) =>
        ["chat.model", "chat.thinking"].includes(event.operation) &&
        event.kind === "command.failed",
    )
  )
    return "initial_selection_failed";
  if (
    events.some(
      (event) =>
        event.operation === "chat.submit" &&
        (event.kind === "command.failed" ||
          (event.kind === "command.settled" && event.state === "failed")),
    )
  )
    return "chat_submit_failed";
  return undefined;
}

function classifyUiAndPi(checkpoint) {
  return classifyUi(checkpoint.ui) ?? classifyPi(checkpoint.pi, checkpoint.ui);
}

function classifyUi(ui) {
  if (ui.messageErrorPresent)
    return `visible_message_error:${ui.messageErrorClasses?.at(-1) ?? "unknown"}`;
  return undefined;
}

function classifyPi(pi, ui) {
  const latestAssistant = pi.entries?.filter((entry) => entry.role === "assistant").at(-1);
  if (latestAssistant?.stopReason === "error")
    return `assistant_error:${latestAssistant.errorClass ?? "unknown"}`;
  if (pi.active || pi.runState === "running-unconfirmed") return "response_still_running";
  if (pi.runState === "idle" && ui.userRows > 0 && ui.assistantRows === 0)
    return "idle_without_assistant";
  return pi.readable === false ? "pi_state_unavailable" : "no_answer_unclassified";
}

async function closeBrowser(connection, chrome, errors) {
  if (connection?.socket.readyState === WebSocket.OPEN) {
    if (!(await requestBrowserClose(connection))) errors.push("browser_close_unconfirmed");
    connection.socket.close();
  }
  if (chrome && chrome.exitCode === null) await stopBrowserProcess(chrome, errors);
  return chrome?.exitCode ?? null;
}

async function requestBrowserClose(connection) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), 5000);
  });
  try {
    return await Promise.race([connection.send("Browser.close").then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function stopBrowserProcess(chrome, errors) {
  await Promise.race([
    new Promise((resolveExit) => chrome.once("exit", resolveExit)),
    delay(10_000),
  ]);
  if (chrome.exitCode !== null) return;
  try {
    await stopChild(chrome);
  } catch {
    errors.push("browser_process_stop_failed");
  }
}

async function cleanupNativeSetup(nativeSetup, errors) {
  try {
    await nativeSetup.cleanup();
  } catch {
    errors.push("native_setup_cleanup_failed");
  }
  let pippinProcessRemains = false;
  try {
    pippinProcessRemains = await hasPippinProcess();
  } catch {
    errors.push("process_cleanup_check_failed");
  }
  const tempDirectoriesRemain = [
    nativeSetup.profilePath,
    nativeSetup.extensionRoot,
    nativeSetup.hostRoot,
  ]
    .filter(Boolean)
    .some((path) => existsSync(path));
  const databaseRemains = Boolean(
    nativeSetup.appDataDirectory && existsSync(nativeSetup.appDataDirectory),
  );
  return { tempDirectoriesRemain, databaseRemains, pippinProcessRemains };
}
