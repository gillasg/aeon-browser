// Chrome's own "Sign in with Google" dialog (FedCM) is browser UI, not page content: the agent can
// neither see nor click it, so sign-ups through "Continue with Google" stalled at it. Through the
// DevTools FedCm domain Aeon answers it the way a person would:
// - after the agent clicked in the tab (it asked for this sign-in) and one account is offered,
//   pick that account; with several, leave it open and tell the agent which call picks one;
// - a dialog the page opened by itself (One Tap) is dismissed: no site is signed into unasked.
import { send } from "./cdp/send.js";
import { onEngineInstall } from "./native-engine-install.js";

const ASKED_WITHIN_MS = 15_000;
const clickedAt = new Map<number, number>();
const notes = new Map<number, string>();

interface FedCmAccount {
  email?: string;
  name?: string;
}
interface DialogShown {
  dialogId: string;
  dialogType: string;
  accounts?: FedCmAccount[];
  title?: string;
}

const fedcmOn = new Set<number>();
const fedcmWanted = new Set<number>();
const fedcmFlight = new Map<number, Promise<void>>();

/** The agent clicked or pressed in this tab: a sign-in dialog that follows is one it asked for. */
export function noteAgentClick(tabId: number): void {
  clickedAt.set(tabId, Date.now());
  fedcmWanted.add(tabId);
}

/** True once FedCm.enable has resolved for this tab. */
export function fedcmEnabled(tabId: number): boolean {
  return fedcmOn.has(tabId);
}

/**
 * Enables FedCM after the debugger is attached. A failure leaves the tab unmarked so the next
 * action retries. Detach clears the flag (`forgetFedCm`).
 */
export function ensureFedCm(tabId: number): Promise<void> {
  if (!fedcmWanted.has(tabId) || fedcmOn.has(tabId)) return Promise.resolve();
  const flight = fedcmFlight.get(tabId);
  if (flight) return flight;
  const work = enableFedCm(tabId).finally(() => {
    if (fedcmFlight.get(tabId) === work) fedcmFlight.delete(tabId);
  });
  fedcmFlight.set(tabId, work);
  return work;
}

/** Drops FedCM state for a tab that detached. The next click can enable it again. */
export function forgetFedCm(tabId: number): void {
  clickedAt.delete(tabId);
  notes.delete(tabId);
  fedcmOn.delete(tabId);
  fedcmWanted.delete(tabId);
  fedcmFlight.delete(tabId);
}

/** What Aeon did with a sign-in dialog since the last step, once. */
export function takeFedCmNote(tabId: number): string | undefined {
  const note = notes.get(tabId);
  notes.delete(tabId);
  return note;
}

function asked(tabId: number): boolean {
  return Date.now() - (clickedAt.get(tabId) ?? 0) < ASKED_WITHIN_MS;
}

function command(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  return send({ tabId }, method, params, { label }).catch(() => undefined);
}

function enableFedCm(tabId: number): Promise<void> {
  return send({ tabId }, "FedCm.enable", { disableRejectionDelay: true }, { label: "enableFedCm" })
    .then(() => {
      fedcmOn.add(tabId);
    })
    .catch(() => {
      fedcmOn.delete(tabId);
    });
}

export async function answerDialog(tabId: number, dialog: DialogShown): Promise<void> {
  const accounts = dialog.accounts ?? [];
  const label = (account: FedCmAccount | undefined) => account?.email ?? account?.name ?? "?";
  if (!asked(tabId)) {
    await command(tabId, "FedCm.dismissDialog", { dialogId: dialog.dialogId }, "answerDialog");
    notes.set(tabId, "The page opened Chrome's own sign-in prompt by itself; Aeon dismissed it.");
    return;
  }
  if (dialog.dialogType === "AccountChooser" && accounts.length === 1) {
    await command(
      tabId,
      "FedCm.selectAccount",
      { dialogId: dialog.dialogId, accountIndex: 0 },
      "answerDialog",
    );
    notes.set(
      tabId,
      `Chrome's own sign-in dialog opened (${dialog.title ?? "sign in"}); Aeon chose its only account, ${label(accounts[0])}. Wait for the page to finish signing in.`,
    );
    return;
  }
  if (dialog.dialogType === "ConfirmIdpLogin") {
    await command(
      tabId,
      "FedCm.clickDialogButton",
      { dialogId: dialog.dialogId, dialogButton: "ConfirmIdpLoginContinue" },
      "answerDialog",
    );
    notes.set(
      tabId,
      "Chrome's sign-in dialog asked to sign in to the provider first; Aeon continued.",
    );
    return;
  }
  if (dialog.dialogType === "AccountChooser") {
    const list = accounts.map((account, index) => `${index}: ${label(account)}`).join(", ");
    notes.set(
      tabId,
      `Chrome's own sign-in dialog is open with several accounts (${list}). Pick one with await page.cdp('FedCm.selectAccount', {dialogId: '${dialog.dialogId}', accountIndex: N}).`,
    );
    return;
  }
  await command(tabId, "FedCm.dismissDialog", { dialogId: dialog.dialogId }, "answerDialog");
  notes.set(tabId, `Chrome's sign-in dialog showed "${dialog.dialogType}"; Aeon closed it.`);
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || method !== "FedCm.dialogShown") return;
    void answerDialog(source.tabId, params as DialogShown);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetFedCm(tabId);
  });
});
