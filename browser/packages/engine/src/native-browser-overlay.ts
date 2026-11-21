// Aeon's own overlay (the cursor, the orb, the hand-off card, labelled-screenshot marks) is painted
// on the page, but it is not the page. Its accessibility nodes stay out of the state the agent
// reads. Most overlay hosts carry data-aeon-overlay. The cursor's host has no attribute (a page must
// not be able to select it), so it is found by the expando its painter sets, in the page's own world.
import { send } from "./cdp/send.js";
import { queryNodes, subtreeBackendIds } from "./native-browser-dom.js";

const OVERLAY_SELECTOR = "[data-aeon-overlay]";
const CURSOR_HOST =
  "([...(document.documentElement || document.body).children].find((node) => node.__cursorSurface) || null)";

/**
 * Backend node ids inside Aeon's overlay, each host's whole subtree included (shadow roots too).
 * Never throws: when the page has no overlay, or a read fails, the set is simply smaller.
 */
export async function overlayBackendIds(debuggee: chrome.debugger.Debuggee): Promise<Set<number>> {
  const ids = new Set<number>();
  const hosts = await queryNodes(debuggee, { by: "css", value: OVERLAY_SELECTOR }).catch(
    () => [] as number[],
  );
  for (const backendNodeId of hosts) await addSubtree(debuggee, { backendNodeId }, ids);
  await addCursor(debuggee, ids);
  return ids;
}

async function addCursor(debuggee: chrome.debugger.Debuggee, ids: Set<number>): Promise<void> {
  const evaluated = (await send(
    debuggee,
    "Runtime.evaluate",
    { expression: CURSOR_HOST, returnByValue: false },
    { label: "overlayIds", ms: 5_000 },
  ).catch(() => undefined)) as { result?: { objectId?: string } } | undefined;
  const objectId = evaluated?.result?.objectId;
  if (!objectId) return;
  await addSubtree(debuggee, { objectId }, ids);
  await send(debuggee, "Runtime.releaseObject", { objectId }, { label: "overlayIds" }).catch(
    () => undefined,
  );
}

async function addSubtree(
  debuggee: chrome.debugger.Debuggee,
  target: { backendNodeId: number } | { objectId: string },
  ids: Set<number>,
): Promise<void> {
  const subtree = await subtreeBackendIds(debuggee, target, "overlayIds").catch(
    () => new Set<number>(),
  );
  for (const id of subtree) ids.add(id);
}
