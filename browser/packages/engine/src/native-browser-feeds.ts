// Declared side doors, pure: <link rel=alternate> RSS, Atom, JSON Feed and oEmbed links, and a
// parse of one bounded peek at each. page.feeds() embeds these by source
// (code-api-posthoc-net.ts): self-contained, calling only this file's functions by name.

export type FeedType = "rss" | "atom" | "json" | "oembed";

export interface FeedLink {
  type: FeedType;
  href: string;
  title?: string;
}

export interface FeedItem {
  title?: string;
  link?: string;
  date?: string;
}

/** Runs in the page: every <link> with a type, as {rel, type, href, title}. */
export function feedLinkFacts(): Array<{ rel: string; type: string; href: string; title: string }> {
  return Array.from(document.querySelectorAll("link[type][href]"))
    .slice(0, 100)
    .map((link) => ({
      rel: String(link.getAttribute("rel") || ""),
      type: String(link.getAttribute("type") || ""),
      href: String(link.getAttribute("href") || ""),
      title: String(link.getAttribute("title") || ""),
    }));
}

export function feedTypeOf(mime: string): FeedType | null {
  const type = mime.toLowerCase().trim();
  if (type === "application/rss+xml") return "rss";
  if (type === "application/atom+xml") return "atom";
  if (type === "application/feed+json" || type === "application/json+feed") return "json";
  if (/^(application\/json|text\/xml)\+oembed$/.test(type)) return "oembed";
  return null;
}

/** The last two host labels (three under a short second level, as in co.uk): a close-enough site. */
export function feedSite(host: string): string {
  const labels = host.toLowerCase().split(".");
  const tail = labels.slice(-2);
  if (labels.length > 2 && tail[0]!.length <= 3 && tail[1]!.length === 2)
    return labels.slice(-3).join(".");
  return tail.join(".");
}

/** Allowed to peek: same origin, or an oEmbed endpoint on the same site. */
export function feedAllowed(type: FeedType, href: string, pageUrl: string): boolean {
  try {
    const target = new URL(href);
    const page = new URL(pageUrl);
    if (!/^https?:$/.test(target.protocol)) return false;
    if (target.origin === page.origin) return true;
    return (
      type === "oembed" &&
      target.protocol === page.protocol &&
      feedSite(target.hostname) === feedSite(page.hostname)
    );
  } catch {
    return false;
  }
}

/** The page's declared feeds, resolved against its URL, deduped, with foreign ones flagged. */
export function feedLinksOf(
  links: Array<{ rel: string; type: string; href: string; title?: string }>,
  pageUrl: string,
): Array<FeedLink & { allowed: boolean }> {
  const seen = new Set<string>();
  const feeds: Array<FeedLink & { allowed: boolean }> = [];
  for (const link of links) {
    const type = feedTypeOf(link.type);
    if (!type || !/\balternate\b/i.test(link.rel || "alternate")) continue;
    let href: string;
    try {
      href = new URL(link.href, pageUrl).href;
    } catch {
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    feeds.push({
      type,
      href,
      ...(link.title ? { title: link.title.slice(0, 200) } : {}),
      allowed: feedAllowed(type, href, pageUrl),
    });
  }
  return feeds.slice(0, 20);
}

export function feedText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
    .slice(0, 300);
}

export function feedTag(block: string, tag: string): string | undefined {
  const found = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i").exec(block);
  return found ? feedText(found[1]!) : undefined;
}

/** RSS <item> or Atom <entry> blocks as {title, link, date}. */
export function feedXmlItems(xml: string, type: "rss" | "atom", limit: number): FeedItem[] {
  const tag = type === "rss" ? "item" : "entry";
  const blocks = xml.match(new RegExp("<" + tag + "[\\s>][\\s\\S]*?</" + tag + ">", "gi")) || [];
  return blocks.slice(0, limit).map((block) => {
    const href = /<link[^>]*\shref=["']([^"']+)["']/i.exec(block);
    const link = type === "atom" && href ? href[1] : feedTag(block, "link");
    const date =
      feedTag(block, type === "rss" ? "pubDate" : "updated") || feedTag(block, "published");
    const item: FeedItem = {};
    const title = feedTag(block, "title");
    if (title) item.title = title;
    if (link) item.link = link;
    if (date) item.date = date;
    return item;
  });
}

/** A peeked body as items (feeds) or a sample (oEmbed), with the feed's own title. */
export function feedParse(
  type: FeedType,
  body: unknown,
  limit = 5,
): { title?: string; items?: FeedItem[]; sample?: Record<string, unknown> } {
  const text = typeof body === "string" ? body.slice(0, 65536) : "";
  if (type === "rss" || type === "atom") {
    const head = text.split(/<(item|entry)[\s>]/i)[0] || "";
    const title = feedTag(head, "title");
    return { ...(title ? { title } : {}), items: feedXmlItems(text, type, limit) };
  }
  let json: unknown = body;
  if (typeof body === "string") {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  if (type === "oembed") {
    if (!json || typeof json !== "object") {
      const title = feedTag(text, "title");
      return title ? { title, sample: { title } } : {};
    }
    const record = json as Record<string, unknown>;
    const sample: Record<string, unknown> = {};
    for (const key of [
      "type",
      "title",
      "author_name",
      "author_url",
      "provider_name",
      "thumbnail_url",
      "width",
      "height",
    ])
      if (record[key] !== undefined) sample[key] = record[key];
    return { ...(typeof record.title === "string" ? { title: record.title } : {}), sample };
  }
  const feed = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const items = Array.isArray(feed.items) ? feed.items : [];
  return {
    ...(typeof feed.title === "string" ? { title: feed.title } : {}),
    items: items.slice(0, limit).map((raw) => {
      const entry = (raw || {}) as Record<string, unknown>;
      const item: FeedItem = {};
      if (typeof entry.title === "string") item.title = entry.title.slice(0, 300);
      if (typeof entry.url === "string") item.link = entry.url;
      if (typeof entry.date_published === "string") item.date = entry.date_published;
      return item;
    }),
  };
}
