// X's built-in abilities, as browser code written for each call: read a thread from X's own
// responses (the user's login, no developer API), and research a topic with Grok, opening every
// cited post to check it. No regex here uses a backslash: the code travels inside strings.

import { uiScript } from "./providers.js";

type Inputs = Record<string, unknown>;

// Collects every post object in an X response (TweetDetail, SearchTimeline…) into a Map by id.
const WALK = `const walk = (node, out) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, out); return; }
    const post = node.__typename === "TweetWithVisibilityResults" ? node.tweet : node;
    if (post && post.rest_id && post.legacy && typeof post.legacy.full_text === "string" && !out.has(post.rest_id)) {
      const user = post.core && post.core.user_results && post.core.user_results.result || {};
      const handle = (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name) || "";
      const note = post.note_tweet && post.note_tweet.note_tweet_results && post.note_tweet.note_tweet_results.result;
      const legacy = post.legacy;
      out.set(post.rest_id, {
        id: post.rest_id,
        url: "https://x.com/" + (handle || "i") + "/status/" + post.rest_id,
        author: handle,
        name: (user.core && user.core.name) || (user.legacy && user.legacy.name) || "",
        text: (note && note.text) || legacy.full_text,
        createdAt: legacy.created_at,
        likes: legacy.favorite_count, reposts: legacy.retweet_count, replies: legacy.reply_count, quotes: legacy.quote_count,
        views: Number(post.views && post.views.count) || undefined,
        replyTo: legacy.in_reply_to_status_id_str || undefined,
      });
    }
    for (const key in node) walk(node[key], out);
  };`;

// Reads every new response matching a URL part from the tab's recorded traffic.
const HARVEST = `const seen = new Set();
  const harvest = async (tab, match, out) => {
    const entries = await tab.network.list(match).catch(() => []);
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      walk(await tab.network.body(entry.id).catch(() => null), out);
    }
  };`;

// Scrolls for more, opening "Show replies" buttons, until nothing new arrives three times.
const SCROLL = `const scrollFor = async (tab, match, out, max) => {
    let still = 0;
    for (let round = 0; round < 25 && out.size < max && still < 3; round++) {
      const before = out.size;
      await tab.evaluate(() => {
        for (const el of document.querySelectorAll("[role=button], button"))
          if (/^show (more )?replies|^show probable spam|^show additional replies/i.test((el.innerText || "").trim())) el.click();
        window.scrollBy(0, window.innerHeight * 2);
      });
      await tab.waitForTimeout(1200);
      await harvest(tab, match, out);
      still = out.size === before ? still + 1 : 0;
    }
  };`;

// The posts on screen, when X's responses were not readable.
const SHOWN = `const shown = (tab) => tab.evaluate(() => [...document.querySelectorAll("article[data-testid=tweet]")].map((article) => {
    const link = [...article.querySelectorAll("a[href*='/status/']")].map((a) => a.href).find((href) => /^[0-9]+$/.test(href.split("/status/")[1] || ""));
    const text = article.querySelector("[data-testid=tweetText]");
    const time = article.querySelector("time");
    return { url: link || "", author: link ? new URL(link).pathname.split("/")[1] : "", text: text ? text.innerText : "", createdAt: time ? time.getAttribute("datetime") : undefined };
  }).filter((post) => post.url));
  const signedOut = async (tab) => /[/]i[/]flow[/]login|[/]login/.test(await tab.url());`;

function clamp(value: unknown, fallback: number, max: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : fallback;
}

function statusUrl(value: unknown): string {
  const url = String(value ?? "")
    .trim()
    .replace("twitter.com", "x.com");
  if (!/^https:\/\/(www\.|mobile\.)?x\.com\/[^/]+\/status\/\d+/.test(url))
    throw new Error("INVALID_INPUT: thread needs a post link like https://x.com/user/status/123");
  return url.replace(/^https:\/\/(www\.|mobile\.)/, "https://");
}

export function xThreadCode(inputs: Inputs): string {
  const url = statusUrl(inputs.url);
  const max = clamp(inputs.max, 100, 500);
  return `async (page) => {
  ${WALK}
  ${HARVEST}
  ${SCROLL}
  ${SHOWN}
  const posts = new Map();
  page = await browser.openTab(${JSON.stringify(url)}, { newTab: true });
  await page.network.waitFor({ match: "TweetDetail", timeoutMs: 15000 }).catch(() => null);
  if (await signedOut(page)) throw new Error("SIGNED_OUT: sign in to x.com in Chrome to read threads");
  await harvest(page, "TweetDetail", posts);
  await scrollFor(page, "TweetDetail", posts, ${max});
  if (posts.size) return { url: ${JSON.stringify(url)}, via: "responses", count: Math.min(posts.size, ${max}), posts: [...posts.values()].slice(0, ${max}) };
  const visible = await shown(page);
  return { url: ${JSON.stringify(url)}, via: "page", count: visible.length, posts: visible.slice(0, ${max}), note: "X's responses were not readable; these are the posts on screen" };
}`;
}

function grokPrompt(topic: string, budget: number, since: string): string {
  return `Search X (Twitter) for: ${topic}${since ? ` (posts since ${since})` : ""}. List the ${budget} most relevant, high-signal posts. For each give the post's full https://x.com/<user>/status/<id> link, the author's handle and one line on what it says. Only list posts you actually found on X; never invent links.`;
}

export function xResearchCode(inputs: Inputs): string {
  const topic = String(inputs.topic ?? "").trim();
  if (!topic) throw new Error("INVALID_INPUT: research needs a topic");
  const budget = clamp(inputs.budget, 8, 25);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(inputs.since ?? "")) ? String(inputs.since) : "";
  const query = `${topic}${since ? ` since:${since}` : ""}`;
  const order = inputs.latest === true ? "live" : "top";
  return `async (page) => {
  ${WALK}
  ${HARVEST}
  ${SCROLL}
  const notes = [];
  let grok = "";
  try {
    page = await browser.openTab("https://grok.com/", { newTab: true });
    await page.waitForTimeout(1200);
    grok = String(await ${uiScript("grok", grokPrompt(topic, budget, since), { timeoutMs: 180_000 })});
  } catch (error) { notes.push("grok: " + (error && error.message || error)); }
  const cited = [...new Set((grok.match(/https?:[/][/](?:www[.])?(?:x|twitter)[.]com[/][A-Za-z0-9_]+[/]status[/][0-9]+/g) || []).map((url) => url.replace("twitter.com", "x.com").replace("www.", "")))].slice(0, ${budget});
  const found = new Map(), posts = [], unverified = [];
  let tab;
  for (const url of cited) {
    tab = tab ? (await tab.goto(url), tab) : await browser.openTab(url, { newTab: true });
    await tab.network.waitFor({ match: "TweetDetail", timeoutMs: 12000 }).catch(() => null);
    await harvest(tab, "TweetDetail", found);
    const post = found.get(url.split("/status/")[1]);
    if (post) posts.push({ ...post, source: "grok" }); else unverified.push(url);
  }
  if (posts.length < 3) {
    const search = new Map();
    const url = "https://x.com/search?q=" + encodeURIComponent(${JSON.stringify(query)}) + "&src=typed_query&f=${order}";
    tab = tab ? (await tab.goto(url), tab) : await browser.openTab(url, { newTab: true });
    await tab.network.waitFor({ match: "SearchTimeline", timeoutMs: 15000 }).catch(() => null);
    await harvest(tab, "SearchTimeline", search);
    await scrollFor(tab, "SearchTimeline", search, ${budget * 2});
    const have = new Set(posts.map((post) => post.id));
    const top = [...search.values()].filter((post) => !have.has(post.id) && !post.replyTo).sort((a, b) => (b.likes || 0) - (a.likes || 0));
    for (const post of top.slice(0, ${budget} - posts.length)) posts.push({ ...post, source: "x-search" });
    if (!search.size) notes.push("x search: nothing readable (signed out of x.com?)");
  }
  return { topic: ${JSON.stringify(topic)}, grok, posts, unverified, checked: cited.length, notes };
}`;
}
