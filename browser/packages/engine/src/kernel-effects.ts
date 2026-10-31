// Every kernel effect, declared once: the call that reaches it, what it does, what the kernel
// checks before it runs (a tab this cell may use, a site the user allows) and the errors it may
// raise. cellEffects() is checked against this table at startup, and help('effects') is written
// from it, so the reference and the kernel never drift.
import type { ErrorCode } from "@browserkit/protocol";

export type EffectNeed = "tab" | "site";

export interface EffectDoc {
  name: string;
  call: string;
  does: string;
  needs: readonly EffectNeed[];
  errors: readonly ErrorCode[];
}

export const EFFECTS = [
  {
    name: "secret.forbidden",
    call: "a password or profile values in browser code",
    does: "refused: secrets travel only between the machine and the page",
    needs: [],
    errors: ["INVALID_INPUT"],
  },
  {
    name: "secret.signIn",
    call: "bu.signIn({account?})",
    does: "signs in from the user's password manager; the model never sees the password",
    needs: ["tab"],
    errors: ["SIGNED_OUT", "PROTECTED_UI"],
  },
  {
    name: "secret.fill",
    call: "bu.fillCode(), bu.fillProfile()",
    does: "types a one-time code or the user's profile values into the page",
    needs: ["tab"],
    errors: ["TARGET_NOT_FOUND", "INPUT_FAILED"],
  },
  {
    name: "net.sessionHeaders",
    call: "mapped-site calls",
    does: "the sign-in headers a site's own code sends, for calls made without a tab",
    needs: [],
    errors: [],
  },
  {
    name: "net.fetch",
    call: "browser.fetch(url, options)",
    does: "fetches with the user's cookies and no tab",
    needs: ["site"],
    errors: ["NETWORK", "BOT_WALL", "TIMEOUT"],
  },
  {
    name: "site.call",
    call: "siteMapper.call/watch/write/batch, site.run(name, inputs)",
    does: "calls a mapped site's API or runs a saved ability",
    needs: ["site"],
    errors: ["NOT_MAPPED", "SIGNED_OUT", "BOT_WALL", "SITE_BROKEN", "ABILITY_NEEDS"],
  },
  {
    name: "net.google",
    call: "google(query, options)",
    does: "Google results as data",
    needs: ["site"],
    errors: ["NETWORK", "BOT_WALL"],
  },
  {
    name: "page.media",
    call: "page.media.inspect(), page.recordMedia()",
    does: "what is playing in the tab, or a recording of a media element",
    needs: ["tab"],
    errors: ["TARGET_NOT_FOUND", "UNSUPPORTED"],
  },
  {
    name: "user.handoff",
    call: "bu.handoff(message, {selector?, wait?, start?})",
    does: "asks the user to do a step in the tab and waits for it",
    needs: ["tab"],
    errors: ["TIMEOUT"],
  },
  {
    name: "tab.quiet",
    call: "browser.openTab(url, {quiet: true})",
    does: "mutes the tab and keeps it from stealing focus",
    needs: ["tab"],
    errors: [],
  },
  {
    name: "page.recording",
    call: "page.recordVideo(), page.recordTab()",
    does: "records the tab as a video or frames in the workspace",
    needs: ["tab"],
    errors: ["UNSUPPORTED", "INVALID_INPUT"],
  },
  {
    name: "net.capture",
    call: "page.network.list/waitFor/get/body/save, page.replay()",
    does: "the tab's recorded requests, and replaying one",
    needs: ["tab"],
    errors: ["TIMEOUT", "INVALID_INPUT"],
  },
  {
    name: "net.rules",
    call: "page.rules.block/headers/mock/clear",
    does: "per-tab network rules",
    needs: ["tab"],
    errors: ["INVALID_INPUT"],
  },
  {
    name: "page.permission",
    call: "page.permissions.allow/block/reset, page.setLocation()",
    does: "presets a site permission the page would prompt for",
    needs: ["tab"],
    errors: ["INVALID_INPUT"],
  },
  {
    name: "browser.info",
    call: "browser.openTab(url) with no tab yet",
    does: "finds the connected browser to open the first tab in",
    needs: [],
    errors: [],
  },
  {
    name: "job.start",
    call: "browser.job(items, fn, options), browser.snipe(), browser.job.cancel(id)",
    does: "background work that outlives the cell",
    needs: [],
    errors: ["INVALID_INPUT", "TIMEOUT"],
  },
  {
    name: "job.progress",
    call: "bu.progress(done, total, label)",
    does: "shows the user how far long work has got",
    needs: [],
    errors: [],
  },
  {
    name: "tab.reset",
    call: "browser.reset()",
    does: "stops this chat's jobs and closes the tabs it opened (kept ones stay)",
    needs: [],
    errors: [],
  },
  {
    name: "tab.reap",
    call: "end of a run",
    does: "closes pop-ups this chat's tabs opened",
    needs: [],
    errors: [],
  },
  {
    name: "tab.close",
    call: "browser.closeTab(id), page.close()",
    does: "closes a tab this chat opened",
    needs: [],
    errors: ["USER_TAB", "INVALID_TARGET"],
  },
  {
    name: "browser.settings",
    call: "browser.settings(changes?)",
    does: "reads or changes presentation settings (tab groups, cursor, glow, recording)",
    needs: [],
    errors: ["INVALID_INPUT"],
  },
  {
    name: "extension.reload",
    call: "browser.reloadExtension()",
    does: "reloads the extension after this answer is sent",
    needs: [],
    errors: [],
  },
  {
    name: "browser.windows",
    call: "browser.windows.list/resize/close",
    does: "the user's Chrome windows",
    needs: [],
    errors: ["INVALID_INPUT"],
  },
  {
    name: "browser.tabGroups",
    call: "browser.tabGrouping(enabled?)",
    does: "whether the agent's tabs are grouped",
    needs: [],
    errors: [],
  },
  {
    name: "browser.library",
    call: "browser.history, browser.bookmarks, browser.downloads, browser.identity, browser.context()",
    does: "the user's history, bookmarks, downloads and Google accounts",
    needs: [],
    errors: ["INVALID_INPUT"],
  },
] as const satisfies readonly EffectDoc[];

export type EffectName = (typeof EFFECTS)[number]["name"];

// What the kernel itself may raise before an effect runs.
const NEED_ERRORS: Record<EffectNeed, readonly ErrorCode[]> = {
  tab: ["INVALID_TARGET", "TAB_DEAD", "SITE_BLOCKED"],
  site: ["SITE_BLOCKED"],
};

/** Everything a call to this effect may raise: the kernel's checks first, then its own. */
export function effectErrors(doc: EffectDoc): ErrorCode[] {
  return [...new Set([...doc.needs.flatMap((need) => NEED_ERRORS[need]), ...doc.errors])];
}

const NEED_TEXT: Record<EffectNeed, string> = {
  tab: "a tab this chat may use, on an allowed site",
  site: "a site the user allows",
};

/** help('effects'): one line per effect, from the declarations. */
export function effectsHelp(): string {
  const lines = EFFECTS.map((doc: EffectDoc) => {
    const needs = doc.needs.length
      ? ` Needs ${doc.needs.map((n) => NEED_TEXT[n]).join(" and ")}.`
      : "";
    const errors = effectErrors(doc);
    return `${doc.call}: ${doc.does}.${needs}${errors.length ? ` May raise ${errors.join(", ")}.` : ""}`;
  });
  return (
    "What browser code can ask of Chrome besides page steps, and what each call needs and may raise (help('errors') says what to do about each code). " +
    lines.join(" ")
  );
}

/**
 * Throws unless the effects match the declarations exactly: every effect declared, every
 * declaration implemented, and each effect asks the kernel to check exactly what it declares.
 */
export function checkDeclared(
  effects: readonly { name: string; tab?: unknown; site?: unknown }[],
): void {
  const docs = new Map<string, EffectDoc>(EFFECTS.map((doc) => [doc.name, doc]));
  const seen = new Set<string>();
  for (const effect of effects) {
    const doc = docs.get(effect.name);
    if (!doc) throw new Error(`INTERNAL: effect ${effect.name} is not declared in kernel-effects`);
    if (seen.has(effect.name)) throw new Error(`INTERNAL: effect ${effect.name} is defined twice`);
    seen.add(effect.name);
    const wantsTab = doc.needs.includes("tab");
    const wantsSite = doc.needs.includes("site");
    if (wantsTab !== Boolean(effect.tab) || wantsSite !== Boolean(effect.site))
      throw new Error(`INTERNAL: effect ${effect.name} does not check what it declares`);
  }
  const missing = [...docs.keys()].filter((name) => !seen.has(name));
  if (missing.length)
    throw new Error(`INTERNAL: declared effects not implemented: ${missing.join(", ")}`);
}
