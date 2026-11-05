import { withBrowserDebugger } from "./native-browser-session.js";
import { fieldPoint, scanFields, type SignInFields } from "./native-browser-signin-page.js";

// Chrome's own saved passwords, for bu.signIn() when no external password manager has a login.
// Chrome never hands a saved password to an extension, but it fills one for a person: a real
// click in the sign-in field opens its suggestions, and ArrowDown then Enter picks the first.
// The engine only learns whether the field filled, never the value; the page is already marked
// as a password page, so agent code cannot read it afterwards.

const OPEN_WAIT_MS = 1200;
const PICK_WAIT_MS = 300;
const FILL_WAIT_MS = 700;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickAt(tabId: number, point: { x: number; y: number }): Promise<void> {
  await withBrowserDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
    });
    for (const type of ["mousePressed", "mouseReleased"] as const)
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  });
}

const KEY_CODES = { ArrowDown: 40, Enter: 13, Escape: 27 } as const;

async function press(tabId: number, key: keyof typeof KEY_CODES): Promise<void> {
  const code = KEY_CODES[key];
  await withBrowserDebugger(tabId, async (debuggee) => {
    for (const type of ["rawKeyDown", "keyUp"] as const)
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
      });
  });
}

/** The field Chrome's suggestions open from: the username when it is empty, else the password. */
export function chromeField(fields: SignInFields): "user" | "password" | undefined {
  if (fields.user && !fields.userValue) return "user";
  if (fields.password) return "password";
  return fields.user ? "user" : undefined;
}

/** Whether Chrome's suggestion filled what this screen asks for. */
export function chromeFilled(before: SignInFields, after: SignInFields | undefined): boolean {
  if (!after) return false;
  if (before.password) return Boolean(after.passwordFilled);
  return Boolean(after.userValue) && after.userValue !== before.userValue;
}

/**
 * Picks Chrome's first saved login for this screen. Returns the fields after filling, or
 * undefined when Chrome had nothing to offer here.
 */
export async function chromeFill(
  tabId: number,
  fields: SignInFields,
): Promise<SignInFields | undefined> {
  if (fields.password && fields.passwordFilled) return fields;
  const field = chromeField(fields);
  const point = field ? await fieldPoint(tabId, field) : undefined;
  if (!point) return undefined;
  await clickAt(tabId, point);
  await wait(OPEN_WAIT_MS);
  // Chrome may fill a single saved login on the click alone.
  const clicked = await scanFields(tabId);
  if (chromeFilled(fields, clicked)) return clicked;
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
  return chromeFilled(fields, after) ? after : undefined;
}
