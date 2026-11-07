import { evaluate, scanFields, type SignInFields } from "./native-browser-signin-page.js";

// An account chooser ("Choose an account", "Welcome back, continue as …", a list of remembered
// accounts each with its own Log in button) stands between the agent and the sign-in form on many
// sites once a session expires. bu.signIn() picks the account itself, the way a person would, and
// only asks the agent when it cannot tell which one is meant.

const MARK = "data-signin-account";

export interface ChooserEntry {
  label: string;
}

const SCAN = `(() => {
  const mark = ${JSON.stringify(MARK)};
  document.querySelectorAll("[" + mark + "]").forEach((el) => el.removeAttribute(mark));
  const text = (document.body && document.body.innerText || "").slice(0, 5000);
  if (!/(choose|select|pick) (an|your) account|use (another|a different) account|add (an|another) account|continue as|log ?in again|sign ?in again|remembered accounts|switch accounts?/i.test(text)) return null;
  const shown = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || "").trim();
  const clickable = [...document.querySelectorAll("a, button, [role=button], [role=link], [role=option], [data-identifier]")].filter(shown);
  const other = /add (an|another) account|use (another|a different) account|create (an )?account|sign ?up|register|forgot|remove/i;
  const action = /^(log ?in|sign ?in|continue|choose|select|use)$/i;
  const email = /[^\\s@]+@[^\\s@]+\\.[a-z]{2,}/i;
  const entries = [];
  const used = new Set();
  // A row with its own button: climb while the parent still holds only this one button.
  for (const button of clickable.filter((el) => action.test(label(el)))) {
    let row = button;
    while (row.parentElement && row.parentElement !== document.body && clickable.filter((el) => action.test(label(el)) && row.parentElement.contains(el)).length === 1) row = row.parentElement;
    const name = label(row).replace(label(button), "").split("\\n").map((line) => line.trim()).filter(Boolean)[0] || "";
    if (!name || other.test(name) || row === button) continue;
    entries.push({ el: button, name });
    used.add(row);
  }
  // A row that is itself the button (Google: the account's email is the link).
  for (const el of clickable) {
    const name = label(el);
    if (!email.test(name) || name.length > 200 || other.test(name) || [...used].some((row) => row.contains(el))) continue;
    entries.push({ el, name: name.split("\\n").map((line) => line.trim()).filter(Boolean).join(" ") });
  }
  entries.forEach((entry, index) => entry.el.setAttribute(mark, String(index)));
  const otherButton = clickable.find((el) => /add (an|another) account|use (another|a different) account/i.test(label(el)));
  if (otherButton) otherButton.setAttribute(mark, "other");
  return { entries: entries.map((entry) => ({ label: entry.name.slice(0, 120) })), other: Boolean(otherButton) };
})()`;

const CLICK = (key: string) => `(() => {
  const el = document.querySelector('[${MARK}="${key}"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
})()`;

interface Chooser {
  entries: ChooserEntry[];
  other: boolean;
}

export type ChooserOutcome =
  | { kind: "none" }
  | { kind: "picked"; fields: SignInFields | undefined; account: string }
  | { kind: "choose"; accounts: string[] };

/** Index of the entry naming this account: the full name, or an email's local part. */
export function matchAccount(entries: ChooserEntry[], wanted: string | undefined): number {
  if (!wanted) return entries.length === 1 ? 0 : -1;
  const want = wanted.toLowerCase();
  const local = want.split("@")[0] ?? want;
  const exact = entries.findIndex((entry) => entry.label.toLowerCase().includes(want));
  if (exact >= 0) return exact;
  return entries.findIndex((entry) => {
    const name = entry.label.toLowerCase().split(/\s/)[0] ?? "";
    return name === local || name.split("@")[0] === local;
  });
}

interface Page {
  run: (tabId: number, expression: string) => Promise<unknown>;
  scan: (tabId: number) => Promise<SignInFields | undefined>;
}
const realPage: Page = { run: evaluate, scan: scanFields };

async function waitForForm(
  tabId: number,
  page: Page,
  timeoutMs = 10_000,
): Promise<SignInFields | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: SignInFields | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await page.scan(tabId);
    if (last && (last.user || last.password || last.code)) return last;
  }
  return last;
}

/**
 * With no sign-in form on the page, an account chooser may be what is shown: click the wanted
 * account (or the only one), or "use another account" when the wanted one is not listed.
 */
export async function passAccountChooser(
  tabId: number,
  wanted: string | undefined,
  page: Page = realPage,
): Promise<ChooserOutcome> {
  const chooser = (await page.run(tabId, SCAN).catch(() => null)) as Chooser | null;
  if (!chooser || !(chooser.entries.length || chooser.other)) return { kind: "none" };
  const index = matchAccount(chooser.entries, wanted);
  const key = index >= 0 ? String(index) : wanted && chooser.other ? "other" : undefined;
  if (key === undefined)
    return { kind: "choose", accounts: chooser.entries.map((entry) => entry.label) };
  if (!(await page.run(tabId, CLICK(key)).catch(() => false))) return { kind: "none" };
  const account = index >= 0 ? (chooser.entries[index]?.label ?? "") : (wanted ?? "");
  return { kind: "picked", fields: await waitForForm(tabId, page), account };
}

/** Whether an account chooser is still on the page (after picking, nothing moved). */
export async function chooserShown(tabId: number): Promise<boolean> {
  return Boolean(await evaluate(tabId, SCAN).catch(() => null));
}
