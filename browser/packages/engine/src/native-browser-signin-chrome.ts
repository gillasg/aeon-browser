import { send } from "./cdp/send.js";
import { withLock } from "./native-browser-scheduler.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { fieldPoint, scanFields, type SignInFields } from "./native-browser-signin-page.js";

// Chrome's own saved passwords, for bu.signIn() when no external password manager has a login.
// Chrome never hands a saved password to an extension, but it fills one for a person: a real
// click in the sign-in field opens its suggestions, and ArrowDown then Enter picks the first.
// The engine only learns whether the field filled, never the value; the page is already marked
// as a password page, so agent code cannot read it afterwards. Chrome shows its suggestions only
// in the active tab of a focused window, as it would to a person, so the tab comes forward for
// the sign-in and the tab the user was on goes back in front afterwards.

const OPEN_WAIT_MS = 1200;
const PICK_WAIT_MS = 300;
const FILL_WAIT_MS = 700;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickAt(tabId: number, point: { x: number; y: number }): Promise<void> {
  await withBrowserDebugger(tabId, async (debuggee) => {
    await send(
      debuggee,
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...point },
      { label: "clickAt" },
    );
    for (const type of ["mousePressed", "mouseReleased"] as const)
      await send(
        debuggee,
        "Input.dispatchMouseEvent",
        { type, ...point, button: "left", clickCount: 1 },
        { label: "clickAt" },
      );
  });
}

const KEY_CODES = { ArrowDown: 40, Enter: 13, Escape: 27 } as const;

async function press(tabId: number, key: keyof typeof KEY_CODES): Promise<void> {
  const code = KEY_CODES[key];
  await withBrowserDebugger(tabId, async (debuggee) => {
    for (const type of ["rawKeyDown", "keyUp"] as const)
      await send(
        debuggee,
        "Input.dispatchKeyEvent",
        { type, key, code: key, windowsVirtualKeyCode: code },
        { label: "press" },
      );
  });
}

/** The field Chrome's suggestions open from: the username when it is empty, else the password. */
export function chromeField(fields: SignInFields): "user" | "password" | undefined {
  if (fields.user && !fields.userValue) return "user";
  if (fields.password) return "password";
  return fields.user ? "user" : undefined;
}

/**
 * Whether Chrome filled what this screen asks for. Its autofill highlight is not enough: on page
 * load Chrome only shows a suggestion, and the page holds the values once a real click commits it.
 */
export function chromeFilled(before: SignInFields, after: SignInFields | undefined): boolean {
  if (!after) return false;
  if (before.password) return Boolean(after.passwordFilled);
  return Boolean(after.userValue) && after.userValue !== before.userValue;
}

/** The screen went away: Enter on a field Chrome had already filled submits its form. */
export function screenLeft(before: SignInFields, after: SignInFields | undefined): boolean {
  if (!after) return true;
  if (after.url !== before.url) return true;
  return before.password ? !after.password : !after.user;
}

export type ChromeFill = { fields: SignInFields; submitted: boolean };

/**
 * Picks Chrome's first saved login for this screen. Returns the fields after filling (and
 * whether that already submitted the form), or undefined when Chrome had nothing to offer here.
 */
export async function chromeFill(
  tabId: number,
  fields: SignInFields,
): Promise<ChromeFill | undefined> {
  if (fields.password && fields.passwordFilled) return { fields, submitted: false };
  const field = chromeField(fields);
  const point = field ? await fieldPoint(tabId, field) : undefined;
  if (!point) return undefined;
  await clickAt(tabId, point);
  await wait(OPEN_WAIT_MS);
  // Chrome may fill a single saved login on the click alone.
  const clicked = await scanFields(tabId);
  if (clicked && chromeFilled(fields, clicked)) return { fields: clicked, submitted: false };
  await press(tabId, "ArrowDown");
  await wait(PICK_WAIT_MS);
  // Enter with no suggestion showing would submit the empty form: only pick a shown one.
  if (!(await scanFields(tabId))?.autofill) {
    await press(tabId, "Escape");
    return undefined;
  }
  await press(tabId, "Enter");
  await wait(FILL_WAIT_MS);
  const after = await scanFields(tabId);
  if (screenLeft(fields, after)) return { fields: after ?? fields, submitted: true };
  return after && chromeFilled(fields, after) ? { fields: after, submitted: false } : undefined;
}

/** Runs the sign-in with the tab in front, then puts back the tab its window showed before.
 * The window lock covers only the focus change, not the fill. */
export async function inFront<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const tab = await chrome.tabs.get(tabId);
  const scope = `window:${tab.windowId}`;
  const previousId = await withLock(scope, () => showTab(tabId, tab.windowId));
  try {
    return await run();
  } finally {
    if (previousId !== undefined && previousId !== tabId)
      await withLock(scope, async () => {
        await chrome.tabs.update(previousId, { active: true }).catch(() => undefined);
      });
  }
}

async function showTab(tabId: number, windowId: number): Promise<number | undefined> {
  const [previous] = await chrome.tabs.query({ active: true, windowId });
  await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  return previous?.id;
}
