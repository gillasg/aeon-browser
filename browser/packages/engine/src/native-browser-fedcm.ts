// Chrome's own "Sign in with Google" dialog (FedCM) is browser UI, not page content: the agent can
// neither see nor click it, so sign-ups through "Continue with Google" stalled at it. Through the
// DevTools FedCm domain Aeon answers it the way a person would:
// - after the agent clicked in the tab (it asked for this sign-in) and one account is offered,
//   pick that account; with several, leave it open and tell the agent which call picks one;
// - a dialog the page opened by itself (One Tap) is dismissed: no site is signed into unasked.
import { onBrowserDebuggerAttached } from "./native-browser-session.js";
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

/** The agent clicked or pressed in this tab: a sign-in dialog that follows is one it asked for. */
export function noteAgentClick(tabId: number): void {
  clickedAt.set(tabId, Date.now());
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

function send(tabId: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params).catch(() => undefined);
}

export async function answerDialog(tabId: number, dialog: DialogShown): Promise<void> {
  const accounts = dialog.accounts ?? [];
  const label = (account: FedCmAccount | undefined) => account?.email ?? account?.name ?? "?";
  if (!asked(tabId)) {
    await send(tabId, "FedCm.dismissDialog", { dialogId: dialog.dialogId });
    notes.set(tabId, "The page opened Chrome's own sign-in prompt by itself; Aeon dismissed it.");
    return;
  }
  if (dialog.dialogType === "AccountChooser" && accounts.length === 1) {
    await send(tabId, "FedCm.selectAccount", { dialogId: dialog.dialogId, accountIndex: 0 });
    notes.set(
      tabId,
      `Chrome's own sign-in dialog opened (${dialog.title ?? "sign in"}); Aeon chose its only account, ${label(accounts[0])}. Wait for the page to finish signing in.`,
    );
    return;
  }
  if (dialog.dialogType === "ConfirmIdpLogin") {
    await send(tabId, "FedCm.clickDialogButton", {
      dialogId: dialog.dialogId,
      dialogButton: "ConfirmIdpLoginContinue",
    });
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
  await send(tabId, "FedCm.dismissDialog", { dialogId: dialog.dialogId });
  notes.set(tabId, `Chrome's sign-in dialog showed "${dialog.dialogType}"; Aeon closed it.`);
}

onEngineInstall(() => {
  onBrowserDebuggerAttached((tabId) =>
    send(tabId, "FedCm.enable", { disableRejectionDelay: true }).then(() => undefined),
  );
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || method !== "FedCm.dialogShown") return;
    void answerDialog(source.tabId, params as DialogShown);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    clickedAt.delete(tabId);
    notes.delete(tabId);
  });
});
