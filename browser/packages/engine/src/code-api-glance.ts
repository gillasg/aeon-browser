// page.glance(): the everyday look at a page. What is on screen now (headings, text, cards) and
// the controls a next step can use, in one page call: no settle wait, no "Show more" clicks, no
// walk of the whole document. page.read() stays the deep, whole-page extraction.

/** Query keys that only track a click: they are dropped from links shown to the agent. */
const TRACKING_KEY =
  /^(?:utm_[a-z]+|gclid|fbclid|msclkid|dclid|yclid|mc_[a-z]+|ref_?|pf_rd_[a-z]+|pd_rd_[a-z]+|qid|sr|crid|sprefix|spla|dib|dib_tag|content-id|_encoding|psc|smid)$/i;
/** Ad click redirects: the real page is in a query parameter, or nowhere useful. */
const REDIRECT_PATH = /\/(?:sspa\/click|gp\/slredirect|aclk|pagead\/|clk\b|redirect\b)/i;

/**
 * A link as the agent should see it: an ad redirect unwrapped to its real target, tracking
 * parameters dropped, and anything still over 180 characters cut. Pure, so the realm and the
 * page both run it from its source.
 */
export function cleanLinkUrl(raw: string, max = 180): string {
  const text = String(raw ?? "").trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  if (REDIRECT_PATH.test(url.pathname)) {
    const inner = url.searchParams.get("url") ?? url.searchParams.get("adurl");
    if (inner) {
      const unwrapped = cleanLinkUrl(
        inner.startsWith("/") ? url.origin + inner : decodeURIComponent(inner),
        max,
      );
      if (unwrapped) return unwrapped;
    }
  }
  for (const key of [...url.searchParams.keys()])
    if (TRACKING_KEY.test(key)) url.searchParams.delete(key);
  // Amazon-style "/ref=..." path tails carry only tracking.
  url.pathname = url.pathname.replace(/\/ref=[^/]*$/, "");
  url.hash = /^#(?:[\w-]{1,40})?$/.test(url.hash) ? url.hash : "";
  const clean = url.toString();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** Every Markdown link target in a text cleaned the same way: `](long tracker)` → `](page)`. */
export function cleanMarkdownLinks(markdown: string, max = 180): string {
  return String(markdown ?? "").replace(
    /\]\((https?:\/\/[^)\s]+)\)/g,
    (_, url: string) => "](" + cleanLinkUrl(url, max) + ")",
  );
}

/**
 * Page-side: the viewport only. Visible text blocks top to bottom and the visible controls, each
 * with a short label; Graft's own overlay is never part of it.
 */
export function readGlance(options: { maxChars?: number; maxControls?: number }): unknown {
  const maxChars = Math.max(500, Math.min(20000, Number(options.maxChars) || 6000));
  const maxControls = Math.max(5, Math.min(200, Number(options.maxControls) || 60));
  const vh = innerHeight;
  const vw = innerWidth;
  const ours = (el: Element): boolean =>
    !!el.closest('[data-graft-overlay="true"], [data-ux-overlay], #graft-labels');
  const onScreen = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > vh) return false;
    if (box.right < 0 || box.left > vw) return false;
    const style = getComputedStyle(el);
    return (
      style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05
    );
  };
  const label = (el: Element): string =>
    String(
      el.getAttribute("aria-label") ||
        el.querySelector("[aria-label]")?.getAttribute("aria-label") ||
        (el as HTMLElement).innerText ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        (el as HTMLInputElement).value ||
        "",
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  const blocks: string[] = [];
  let used = 0;
  const textSelector = "h1,h2,h3,h4,p,li,td,th,figcaption,blockquote,[role=heading],[role=option]";
  for (const el of Array.from(document.querySelectorAll(textSelector))) {
    if (used >= maxChars || ours(el) || !onScreen(el)) continue;
    if (el.parentElement?.closest(textSelector)) continue;
    const text = String((el as HTMLElement).innerText || "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 2) continue;
    const line = /^H[1-4]$/.test(el.tagName)
      ? "#".repeat(Number(el.tagName[1])) + " " + text
      : text;
    const cut = line.slice(0, Math.min(400, maxChars - used));
    blocks.push(cut);
    used += cut.length + 1;
  }
  const controlSelector =
    'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=combobox],[role=option],[role=tab],[role=checkbox],[role=menuitem],[role=gridcell][aria-label],[contenteditable="true"]';
  const controls: { role: string; name: string; href?: string; value?: string }[] = [];
  for (const el of Array.from(document.querySelectorAll(controlSelector))) {
    if (controls.length >= maxControls) break;
    if (ours(el) || !onScreen(el)) continue;
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = label(el);
    if (!name && role !== "input" && role !== "textarea") continue;
    const href = el instanceof HTMLAnchorElement ? el.href : undefined;
    const value =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : undefined;
    controls.push({
      role,
      name,
      ...(href ? { href } : {}),
      ...(value ? { value: value.slice(0, 80) } : {}),
    });
  }
  return {
    url: location.href,
    title: document.title,
    text: blocks.join("\n"),
    controls,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: vh },
  };
}

// Built by concatenation, not a template literal, so the regexes and the page function keep
// their backslashes exactly.
export const browserGlanceApi = [
  "var __cleanLinkUrl = (() => { var TRACKING_KEY = " +
    TRACKING_KEY.toString() +
    "; var REDIRECT_PATH = " +
    REDIRECT_PATH.toString() +
    "; return " +
    cleanLinkUrl.toString() +
    "; })();",
  "var __cleanMarkdownLinks = (() => { var cleanLinkUrl = __cleanLinkUrl; return " +
    cleanMarkdownLinks.toString() +
    "; })();",
  "var __glanceSource = " + JSON.stringify(readGlance.toString()) + ";",
  "async function __glance(base, target, options = {}) {",
  "  __noteRead(target);",
  "  var page = await base.inspect('(' + __glanceSource + ')(' + JSON.stringify(options) + ')');",
  "  var controls = (page.controls || []).map((control) => control.href ? {...control, href: __cleanLinkUrl(control.href)} : control);",
  "  return {...page, controls, text: __cleanMarkdownLinks(String(page.text || ''))};",
  "}",
].join("\n");
