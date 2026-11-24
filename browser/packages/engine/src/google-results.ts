// Google results parsed with the browser's own HTML parser, in the offscreen document: the
// browser_code realm runs outside the browser and has no DOM. Results are {title, url, source,
// snippet}; a results page that is a bot check fails with GOOGLE_BLOCKED.
export interface GoogleResult {
  title: string;
  url: string;
  source: string;
  snippet: string;
}

const clean = (text: string | null | undefined) => (text || "").replace(/\s+/g, " ").trim();
const sourceOf = (href: string) => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

function resultHref(link: Element | null): string {
  let href = link?.getAttribute("href") || "";
  if (href.startsWith("/url?"))
    href = new URL(href, "https://www.google.com").searchParams.get("q") || "";
  return href;
}

export function parseGoogleResults(html: string, limit: number): GoogleResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const seen = new Set<string>();
  const results: GoogleResult[] = [];
  for (const heading of doc.querySelectorAll("a[href] h3, h3 a[href]")) {
    const link = heading.closest("a[href]") || heading.querySelector("a[href]");
    const href = resultHref(link);
    if (!/^https?:/.test(href) || /^https?:\/\/([a-z]+\.)?google\./.test(href) || seen.has(href))
      continue;
    seen.add(href);
    const block = link?.closest("[data-rpos], [data-hveid], .g") || link?.parentElement;
    const title = clean(heading.textContent);
    const snippet = clean(block?.textContent).replace(title, "").slice(0, 400);
    results.push({ title, url: href, source: sourceOf(href), snippet });
    if (results.length >= limit) break;
  }
  if (!results.length && /unusual traffic|detected unusual|captcha/i.test(html))
    throw new Error(
      "GOOGLE_BLOCKED: Google asked for a check. Use the websearch tool, or open the results in a tab.",
    );
  return results;
}
