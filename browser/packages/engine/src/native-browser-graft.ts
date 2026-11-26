// page.graft, pure: a live overlay on a site (badges, extra columns, bulk buttons, data from other
// sites) saved as a boost in the folded Boosts engine, so it comes back on every reload with no
// model call. Nothing touches a page until a graft is applied there; at rest a site carries no
// graft node, attribute or global.

export const GRAFT_PREFIX = "graft-";
export const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// The host a graft applies to: an explicit match ('example.com', '*.example.com', a URL) or the
// page's own host. Only http(s) sites take grafts; internal and file pages never do.
export function graftMatch(match: unknown, pageUrl: unknown): string {
  let raw = typeof match === "string" && match.trim() ? match.trim().toLowerCase() : "";
  if (!raw) {
    let url: URL;
    try {
      url = new URL(String(pageUrl));
    } catch {
      throw new Error("INVALID_INPUT: page.graft needs a match host on a page with no URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("INVALID_INPUT: page.graft works on http(s) sites, not " + url.protocol);
    raw = url.hostname;
  } else if (/^[a-z][a-z0-9+.-]*:/.test(raw)) {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error(
        "INVALID_INPUT: page.graft match must be an http(s) site, not " + url.protocol,
      );
    raw = url.hostname;
  }
  raw = raw.replace(/\/.*$/, "");
  if (!HOST.test(raw))
    throw new Error(
      "INVALID_INPUT: page.graft match " +
        JSON.stringify(match) +
        " is not a host such as example.com or *.example.com",
    );
  return raw;
}

export function graftId(id: unknown): string {
  const text = String(id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text))
    throw new Error("INVALID_INPUT: graft id is 1-64 letters, digits, - or _");
  return text.startsWith(GRAFT_PREFIX) ? text : GRAFT_PREFIX + text;
}

export interface GraftSpec {
  id?: string;
  match?: string;
  css?: string;
  js?: string;
  data?: unknown;
  widgets?: unknown[];
  persist?: boolean;
}

// The boost a graft saves as. data rides in the script as a frozen constant, so a cross-site
// overlay needs no request at render time.
export function graftBoost(spec: GraftSpec, host: string): Record<string, unknown> {
  if (!spec || typeof spec !== "object")
    throw new Error("INVALID_INPUT: page.graft.apply takes {id?, match?, css?, js?, data?}");
  const css = typeof spec.css === "string" ? spec.css : "";
  const js = typeof spec.js === "string" ? spec.js : "";
  if (!css.trim() && !js.trim() && !Array.isArray(spec.widgets))
    throw new Error("INVALID_INPUT: a graft needs css, js or widgets");
  const data = spec.data === undefined ? undefined : JSON.stringify(spec.data);
  if (data && data.length > 500_000) throw new Error("INVALID_INPUT: graft data is over 500 kB");
  const id = graftId(
    spec.id ??
      host
        .replace(/^\*\./, "")
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40) +
        "-" +
        graftHash(css + js + (data ?? "")),
  );
  const script = js.trim()
    ? "(function(){var data=" +
      (data ? "Object.freeze(" + data + ")" : "undefined") +
      ";\n" +
      js +
      "\n})();"
    : undefined;
  return {
    id,
    name: id.slice(GRAFT_PREFIX.length),
    sites: [host],
    ...(css ? { css } : {}),
    ...(script ? { js: script } : {}),
    ...(Array.isArray(spec.widgets) ? { widgets: spec.widgets } : {}),
  };
}

export function graftHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function isGraft(boost: unknown): boolean {
  return Boolean(
    boost &&
    typeof boost === "object" &&
    String((boost as { id?: unknown }).id ?? "").startsWith(GRAFT_PREFIX),
  );
}

// Page side, for a graft that is not persisted: one <style> for this visit only, removed by id.
// Returns whether this page now carries it; called with css null it removes it.
export function graftLive(arg: { id: string; css: string | null }): unknown {
  const doc = document as unknown as Document;
  const existing = [...doc.querySelectorAll("style")].find(
    (el) => el.dataset && el.dataset.graft === arg.id,
  );
  if (arg.css === null) {
    existing?.remove();
    return { removed: Boolean(existing) };
  }
  const style = existing ?? doc.createElement("style");
  style.dataset.graft = arg.id;
  style.textContent = arg.css;
  if (!existing) (doc.head || doc.documentElement).appendChild(style);
  return { applied: true };
}

// Whether a graft for host ('example.com' or '*.example.com') covers the page at url.
export function graftCovers(host: string, url: unknown): boolean {
  let page: string;
  try {
    page = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.replace(/^\*\./, "");
  return page === bare || (host.startsWith("*.") && page.endsWith("." + bare));
}
