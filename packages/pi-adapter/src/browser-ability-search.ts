import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// tool_search only knows tools, so a model that searched for "browser history" heard "No
// matching tools" and told the user it could not see their history, though browser_code can.
// This adds the browser_code abilities that match the query to tool_search's answer. It only
// appends to a tool result, so the system prompt and tool list stay the same all chat.

interface Ability {
  call: string;
  what: string;
  words: string;
}

const ABILITIES: Ability[] = [
  {
    call: "browser.history.search(text, {days, max})",
    what: "pages the user visited",
    words: "history visited visit past seen pages watched",
  },
  {
    call: "browser.bookmarks.search(text) / tree() / create(...)",
    what: "the user's bookmarks",
    words: "bookmarks saved favourites favorites",
  },
  {
    call: "browser.tabs() with bu.use(tab) then page.data() or page.markdown()",
    what: "the tabs the user has open, read in place",
    words: "tabs open my tabs these pages windows",
  },
  {
    call: "browser.downloads.list(text?)",
    what: "recent downloads",
    words: "downloads downloaded files",
  },
  {
    call: "google.search(query, {limit, time, country})",
    what: "a real Google search in the user's browser",
    words: "google search web results query",
  },
  {
    call: "siteApi.call / watch / write / batch",
    what: "a site's own API, learned while using it",
    words: "api site endpoint json bulk batch many items fast mapped operations",
  },
  {
    call: "browser.boosts.save({name, sites, css, zaps, actions})",
    what: "a lasting change to a site on every visit",
    words: "boost userscript userstyle hide restyle dark mode every visit always",
  },
  {
    call: "skills.save / skills.load",
    what: "site helpers saved for next time",
    words: "skill helper recipe reuse save remember",
  },
  {
    call: "page.network.start / list / save, page.replay",
    what: "a page's network requests",
    words: "network requests xhr fetch har traffic capture",
  },
  {
    call: "page.screenshot({labels}) / page.diffScreenshot",
    what: "screenshots and visual diffs",
    words: "screenshot image picture visual diff compare",
  },
  {
    call: "page.saveMedia(selectorOrUrl) / page.download(url)",
    what: "save images, videos and files",
    words: "image video media download save file picture",
  },
  {
    call: "page.upload(selector, files)",
    what: "upload files to a page",
    words: "upload attach file drop",
  },
  {
    call: "page.pdf(name) / page.pdfText()",
    what: "save a page as PDF, read a PDF",
    words: "pdf print document",
  },
  {
    call: "page.recordMedia / page.recordTab",
    what: "record audio, video or the tab",
    words: "record recording audio video capture frames",
  },
  {
    call: "page.recordDemonstration()",
    what: "record the user doing a task, as a skill",
    words: "demonstration show me watch me teach record user",
  },
  {
    call: "page.emulate({device, locale, timezone}) / page.setLocation",
    what: "mobile versions, regions, location",
    words: "mobile phone device emulate location region locale timezone",
  },
  {
    call: "page.permissions.allow(name) / page.rules.block(...)",
    what: "permission prompts and blocking ads or images",
    words: "permission notifications camera block ads trackers images",
  },
  {
    call: "page.waitForChange / waitForResponse / waitForMessage",
    what: "waiting for live changes",
    words: "wait live change update websocket realtime",
  },
  {
    call: "bu.progress(done, total, label)",
    what: "show progress of a long job in one call",
    words: "progress long job loop many items",
  },
  {
    call: "bu.handoff(message)",
    what: "hand the tab to the user (sign-in, 2FA, payment)",
    words: "handoff login sign in password 2fa captcha user payment",
  },
];

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2)
    .map((term) => term.replace(/(ies|es|s)$/, ""));
}

/** browser_code abilities that match a search, best first. */
export function matchAbilities(query: string, limit = 4): Ability[] {
  const wanted = new Set(terms(query));
  return ABILITIES.map((ability) => ({
    ability,
    score: terms(`${ability.words} ${ability.what} ${ability.call}`).filter((term) =>
      wanted.has(term),
    ).length,
  }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.ability);
}

export function browserAbilitySearch(): InlineExtension {
  return {
    name: "browser-abilities",
    factory: (pi) => {
      pi.on("tool_result", (event) => {
        if (event.toolName !== "tool_search") return undefined;
        const found = matchAbilities(String(event.input.query ?? ""));
        if (!found.length) return undefined;
        const text =
          "In browser_code (always available, nothing to load):\n" +
          found.map((ability) => `- ${ability.call}: ${ability.what}`).join("\n");
        return { content: [...event.content, { type: "text", text }] };
      });
    },
  };
}
