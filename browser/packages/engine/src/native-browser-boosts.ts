import { startBoostEngine, type BoostEngine, type BoostEngineOptions } from "site-boosts/embed";
import { installWire, syncAllWireTabs } from "./native-browser-wire-tabs.js";

// Boosts from Site Boosts' engine, built into this extension: saved page changes (styles, hidden
// elements, actions, network rules, scripts) that apply in every tab and survive restarts.
// Host extensions call installBoosts() in their service worker and include the content script
// from @browserkit/engine/boosts-build in their build.

let engine: BoostEngine | undefined;

export function installBoosts(
  contentScript = "boosts-content.js",
  options: Omit<BoostEngineOptions, "contentScript"> = {},
): void {
  engine ??= startBoostEngine({ contentScript, ...options });
  const started = engine;
  installWire((url) => started.wireFor(url));
}

type Request = Record<string, unknown>;

export function isBoostsRequest(value: Request | null): boolean {
  return typeof value?.boosts === "string";
}

export async function boostsCall(value: Request): Promise<unknown> {
  const result = await boostsCallOnce(value);
  // Wire rules follow every change at once, so an undo stops the interception too.
  if (!["list", "get", "viewAdd", "viewRemove"].includes(String(value.boosts)))
    await syncAllWireTabs().catch(() => undefined);
  return result;
}

async function boostsCallOnce(value: Request): Promise<unknown> {
  if (!engine) throw new Error("UNSUPPORTED: boosts are not built into this extension");
  const id = String(value.id ?? "");
  if (value.boosts === "list")
    return engine.list(typeof value.url === "string" ? value.url : undefined);
  if (value.boosts === "get") return (await engine.get(id)) ?? null;
  if (value.boosts === "save") {
    const boost = (value.boost ?? {}) as Request;
    return withScriptWarning(await engine.save(boost), boost);
  }
  // A live viewer browser.liveView.start opened: boosts push to it, its token stays here.
  if (value.boosts === "viewAdd") return engine.rememberView((value.view ?? {}) as Request);
  if (value.boosts === "viewRemove") {
    await engine.forgetView(id);
    return { forgotten: id };
  }
  if (value.boosts === "remove") {
    await engine.remove(id);
    return { removed: id };
  }
  if (value.boosts === "undo") {
    // One call takes a boost off every page: widgets unmount, styles go, wire rules stop.
    await engine.setEnabled(id, false);
    return { id, enabled: false, undone: true };
  }
  if (value.boosts === "enable") {
    await engine.setEnabled(id, value.enabled !== false);
    return { id, enabled: value.enabled !== false };
  }
  throw new Error("UNSUPPORTED: browser.boosts." + String(value.boosts));
}

// Boost scripts run as user scripts, which Chrome only allows once the user switches on "Allow
// User Scripts" for this extension. Without it a saved script silently never runs, so say so.
// Every save-time finding is in `warnings` ({code, message}); `warning` joins their messages.
async function withScriptWarning(
  saved: { warnings?: { code: string; message: string }[] },
  boost: Request,
): Promise<unknown> {
  const warnings = [...(saved.warnings ?? [])];
  if (typeof boost.js === "string" && boost.js.trim() && !(await userScriptsAllowed()))
    warnings.unshift({
      code: "USER_SCRIPTS_OFF",
      message:
        "USER_SCRIPTS_OFF: the boost was saved, but its js will not run until the user turns on " +
        '"Allow User Scripts" for this extension (chrome://extensions > Details). Its css, zaps, ' +
        "actions and network rules apply already. Tell the user.",
    });
  const { warnings: _old, ...rest } = saved;
  void _old;
  return warnings.length
    ? { ...rest, warnings, warning: warnings.map((w) => w.message).join("\n") }
    : { ...rest, warnings };
}
async function userScriptsAllowed(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}
