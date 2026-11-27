// @ts-nocheck
// Self-contained page readers. Each runs in the page (an isolated-world executeScript on the
// debugger-free path, or Runtime.evaluate), so none may reference anything outside itself. The
// sandbox realm gets the same source through toString(), so both paths run identical code.

export function __readMetadata() {
  var meta = {};
  document.querySelectorAll("meta[property],meta[name]").forEach((tag) => {
    var key = tag.getAttribute("property") || tag.getAttribute("name");
    var value = tag.getAttribute("content");
    if (
      key &&
      value &&
      /^(og:|twitter:|article:|product:|description$|keywords$|author$|robots$)/i.test(key)
    )
      meta[key] = value;
  });
  var link = (rel) => document.querySelector('link[rel="' + rel + '"]')?.href;
  return {
    url: location.href,
    title: document.title,
    lang: (document.documentElement && document.documentElement.lang) || undefined,
    description: meta.description,
    canonical: link("canonical"),
    icon: link("icon") || link("shortcut icon"),
    alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((tag) => ({
      lang: tag.hreflang,
      url: tag.href,
    })),
    meta,
  };
}

export function __readPageData(readMetadata, options) {
  // Every array of objects inside the embedded data, by path: a Next/Nuxt/Redux page keeps what
  // it renders in here, so this is the cheapest way to the data behind the layout.
  function dataLists(root, limit) {
    var found = [];
    function walk(value, path, depth) {
      if (!value || typeof value !== "object" || depth > 8 || found.length >= limit) return;
      if (Array.isArray(value)) {
        var first = value[0];
        if (!value.length) return;
        if (first && typeof first === "object" && !Array.isArray(first))
          found.push({
            path: path,
            count: value.length,
            keys: Object.keys(first).slice(0, 12),
            sample: value.slice(0, 5),
          });
        // Nested lists live inside the items too (a page of orders with its lines).
        walk(first, path + "[]", depth + 1);
        return;
      }
      for (var key of Object.keys(value).slice(0, 60))
        walk(value[key], path ? path + "." + key : key, depth + 1);
    }
    walk(root, "", 0);
    return found;
  }
  var parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  var plain = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  };
  var data = {},
    notes = [],
    partial = false;
  var jsonLdTags = [...document.querySelectorAll('script[type="application/ld+json"]')];
  var jsonLd = jsonLdTags.map((tag) => parse(tag.textContent)).filter(Boolean);
  if (jsonLd.length) data.jsonLd = jsonLd;
  if (jsonLd.length < jsonLdTags.length) {
    partial = true;
    notes.push(jsonLdTags.length - jsonLd.length + " JSON-LD block(s) were not valid JSON");
  }
  var next = document.getElementById("__NEXT_DATA__");
  if (next) {
    data.nextData = parse(next.textContent);
    if (data.nextData === undefined) {
      partial = true;
      notes.push("__NEXT_DATA__ was not valid JSON");
    }
  }
  for (var name of [
    "__NUXT__",
    "__NUXT_DATA__",
    "__APOLLO_STATE__",
    "__INITIAL_STATE__",
    "__PRELOADED_STATE__",
    "__REDUX_STATE__",
    "__INITIAL_DATA__",
    "__DATA__",
    "__STATE__",
    "__remixContext",
    "__staticRouterHydrationData",
  ]) {
    var value = window[name];
    if (value && typeof value === "object") {
      var copy = plain(value);
      if (copy !== undefined) data[name] = copy;
    }
  }
  if (Array.isArray(window.__next_f)) {
    var flight = window.__next_f
      .map((chunk) => chunk && chunk[1])
      .filter((chunk) => typeof chunk === "string")
      .join("");
    data.nextFlight = flight.slice(0, 1000000);
    if (flight.length > 1000000) {
      partial = true;
      notes.push("nextFlight cut at 1,000,000 characters");
    }
  }
  var scripts = [...document.querySelectorAll('script[type="application/json"]')].filter(
    (tag) => tag.id !== "__NEXT_DATA__",
  );
  var kept = scripts
    .filter((tag) => tag.textContent.length < 3000000)
    .map((tag) => ({ id: tag.id || undefined, data: parse(tag.textContent) }))
    .filter((item) => item.data !== undefined);
  if (kept.length) data.jsonScripts = kept;
  if (kept.length < scripts.length) {
    partial = true;
    notes.push(scripts.length - kept.length + " JSON script(s) were too large or not valid JSON");
  }
  if (options && options.summary) {
    var sources = {};
    for (var source of Object.keys(data)) {
      var item = data[source];
      if (Array.isArray(item)) sources[source] = { items: item.length };
      else if (item && typeof item === "object") {
        var arrays = {};
        for (var field of Object.keys(item))
          if (Array.isArray(item[field])) arrays[field] = item[field].length;
        sources[source] = { keys: Object.keys(item).slice(0, 10), arrays: arrays };
      } else sources[source] = {};
    }
    var params = [];
    try {
      params = [...new URL(location.href).searchParams.keys()];
    } catch {}
    return { sources: sources, urlParams: params, partial, notes };
  }
  var find = options && Array.isArray(options.find) ? options.find.map(String).slice(0, 12) : [];
  var lists = dataLists(data, 20);
  if (find.length) {
    var hits = lists.filter((list) => list.sample[0] && find.every((key) => key in list.sample[0]));
    if (!hits.length)
      notes.push(
        "no array of objects with " +
          find.join(", ") +
          " in the page data; source keys: " +
          Object.keys(data).join(", "),
      );
    return {
      find: find,
      lists: hits.map((list) => ({
        path: list.path,
        count: list.count,
        keys: list.keys,
        items: list.sample.slice(0, Math.max(1, Math.min(50, Number(options.max) || 10))),
      })),
      sources: Object.keys(data),
      partial,
      notes,
    };
  }
  if (lists.length)
    data.lists = lists
      .slice(0, 5)
      .map((list) => ({ path: list.path, count: list.count, keys: list.keys }));
  data.metadata = typeof readMetadata === "function" ? readMetadata() : readMetadata;
  if (partial) {
    data.partial = true;
    data.notes = notes;
  }
  return data;
}

export function __readMarkdown(options) {
  var skip =
    /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|SELECT|BUTTON|INPUT|TEXTAREA)$/;
  var chrome = /^(NAV|HEADER|FOOTER|ASIDE|FORM)$/;
  var noise =
    /(^|[-_ ])(nav|menu|footer|header|sidebar|cookie|consent|banner|share|social|related|newsletter|breadcrumb|advert|promo|popup|modal)([-_ ]|$)/i;
  var main = document.querySelector('main, [role="main"], #main, #content, .content');
  var articles = [...document.querySelectorAll("article")];
  var root,
    outside = 0;
  if (options.selector) root = document.querySelector(options.selector);
  else if (options.mainOnly === false) root = document.body;
  else if (main) root = main;
  else if (articles.length)
    root = articles.length === 1 ? articles[0] : articles[0].parentElement || document.body;
  else root = document.body;
  if (!options.selector && options.mainOnly !== false && main && articles.length) {
    var missing = articles.filter((article) => !main.contains(article));
    var parent = main.parentElement;
    if (missing.length && parent && missing.every((article) => parent.contains(article)))
      root = parent;
  }
  if (!root) return { markdown: "", partial: false, notes: [], chars: 0 };
  if (main && options.mainOnly !== false && !options.selector)
    outside = articles.filter((article) => !root.contains(article)).length;
  if (!options.selector && options.mainOnly !== false)
    outside = Math.max(outside, articles.filter((article) => !root.contains(article)).length);
  var hidden = (element) => {
    var style = getComputedStyle(element);
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      element.getAttribute("aria-hidden") === "true"
    );
  };
  var hiddenArticles = articles.filter(
    (article) => hidden(article) || !!article.closest("[hidden]"),
  );
  var absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  };
  var clean = (text) => text.replace(/\s+/g, " ");
  function inline(node) {
    if (node.nodeType === 3) return clean(node.textContent);
    if (node.nodeType !== 1 || skip.test(node.tagName) || hidden(node)) return "";
    var inner = () => [...node.childNodes].map(inline).join("");
    switch (node.tagName) {
      case "A": {
        var text = inner().trim();
        var href = node.getAttribute("href");
        return href && text && !href.startsWith("javascript:")
          ? "[" + text + "](" + absolute(href) + ")"
          : text;
      }
      case "STRONG":
      case "B": {
        var bold = inner().trim();
        return bold ? "**" + bold + "** " : "";
      }
      case "EM":
      case "I": {
        var italic = inner().trim();
        return italic ? "_" + italic + "_ " : "";
      }
      case "CODE":
        return "`" + node.textContent + "`";
      case "BR":
        return "\n";
      case "IMG": {
        var alt = node.getAttribute("alt");
        return alt ? "![" + clean(alt) + "](" + absolute(node.getAttribute("src") || "") + ")" : "";
      }
      default:
        return block(node) ? "\n" + blocks(node) + "\n" : inner();
    }
  }
  function block(node) {
    return /^(P|DIV|SECTION|ARTICLE|MAIN|UL|OL|LI|H[1-6]|PRE|BLOCKQUOTE|TABLE|FIGURE|FIGCAPTION|DL|DT|DD|HR|HEADER|FOOTER|NAV|ASIDE)$/.test(
      node.tagName,
    );
  }
  function table(node) {
    var rows = [...node.querySelectorAll("tr")].map((row) =>
      [...row.children].map((cell) => clean(inline(cell)).trim().replace(/\|/g, "\\|")),
    );
    if (!rows.length) return "";
    var width = Math.max(...rows.map((row) => row.length));
    var line = (row) =>
      "| " + Array.from({ length: width }, (_, index) => row[index] || "").join(" | ") + " |";
    return [
      line(rows[0]),
      "| " + Array(width).fill("---").join(" | ") + " |",
      ...rows.slice(1).map(line),
    ].join("\n");
  }
  function element(node, depth) {
    var tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + clean(inline(node)).trim();
    if (tag === "PRE") return "```\n" + node.textContent.replace(/\n$/, "") + "\n```";
    if (tag === "BLOCKQUOTE")
      return blocks(node, depth)
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    if (tag === "TABLE") return table(node);
    if (tag === "HR") return "---";
    if (tag === "UL" || tag === "OL")
      return [...node.children]
        .filter((child) => child.tagName === "LI")
        .map(
          (item, index) =>
            "  ".repeat(depth) +
            (tag === "OL" ? index + 1 + ". " : "- ") +
            blocks(item, depth + 1).trim(),
        )
        .join("\n");
    return blocks(node, depth);
  }
  function blocks(node, depth = 0) {
    var parts = [],
      line = "";
    var flush = () => {
      if (line.trim()) parts.push(line.trim());
      line = "";
    };
    for (var child of node.childNodes) {
      if (child.nodeType === 1 && (skip.test(child.tagName) || hidden(child))) continue;
      if (
        child.nodeType === 1 &&
        options.mainOnly !== false &&
        child !== root &&
        (chrome.test(child.tagName) ||
          noise.test(
            (child.id || "") + " " + (typeof child.className === "string" ? child.className : ""),
          ))
      )
        continue;
      if (child.nodeType === 1 && block(child)) {
        flush();
        var text = element(child, depth);
        if (text.trim()) parts.push(text.trim());
      } else line += inline(child);
    }
    flush();
    return parts.join(depth ? "\n" : "\n\n");
  }
  var title = options.title === false ? "" : "# " + document.title.trim() + "\n\n";
  var markdown = (title + blocks(root)).replace(/\n{3,}/g, "\n\n").trim();
  var max = options.max || 200000;
  var notes = [],
    partial = false;
  if (outside) {
    partial = true;
    notes.push(
      outside +
        " repeated item" +
        (outside === 1 ? "" : "s") +
        " (a feed or replies) outside the read area",
    );
  }
  if (hiddenArticles.length) {
    partial = true;
    notes.push(
      hiddenArticles.length +
        " repeated item" +
        (hiddenArticles.length === 1 ? "" : "s") +
        " hidden behind Show more/Show replies",
    );
  }
  if (markdown.length > max) {
    markdown = markdown.slice(0, max);
    partial = true;
    notes.push("cut at " + max + " characters");
  }
  return { markdown, partial, notes, chars: markdown.length };
}

export function __expandRead(options) {
  var root =
    document.querySelector('main, [role="main"], #main, #content, .content') || document.body;
  var allowed =
    /^(show more|show replies|show \d+ more|show more replies|read more|view more|see more|load more|more replies)$/i;
  var danger =
    /\b(post|reply|follow|like|buy|order|purchase|subscribe|send|share|delete|block|report|retweet|repost|message|pay)\b/i;
  var clicked = [],
    skipped = [];
  if (!root) return { clicked, skipped };
  var max = Math.max(0, Math.min(10, Number(options.max) || 10));
  for (var button of root.querySelectorAll('button, [role="button"], a[role="button"]')) {
    if (clicked.length >= max || button.disabled) break;
    if (button.tagName === "A" || button.closest("a[href]")) continue;
    var text = (button.innerText || button.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (!allowed.test(text) && !allowed.test(button.getAttribute("aria-label") || "")) {
      skipped.push(text.slice(0, 60));
      continue;
    }
    if (danger.test(text) && !/^(show replies|show more replies|more replies)$/i.test(text)) {
      skipped.push(text.slice(0, 60));
      continue;
    }
    try {
      button.click();
      clicked.push(text);
    } catch {}
  }
  // Every other button on the page is skipped: report each label once, a dozen at most.
  var unique = [...new Set(skipped)];
  return {
    clicked,
    skipped: unique.slice(0, 12),
    ...(skipped.length > 12 ? { skippedTotal: skipped.length } : {}),
  };
}

export function __waitRead(options) {
  var root =
    document.querySelector('main, [role="main"], #main, #content, .content') || document.body;
  var max = Math.max(200, Math.min(5000, Number(options.maxMs) || 5000));
  // A loaded document without scripts cannot draw anything later: it needs no floor.
  var still =
    document.readyState === "complete" && document.scripts && document.scripts.length === 0;
  var min = still ? 0 : Math.min(max, Math.max(0, Number(options.minMs) || 1500));
  var started = Date.now(),
    lastText = -1,
    lastResources = -1,
    stable = 0;
  return new Promise((done) => {
    var finish = (settled) =>
      done({
        settled,
        ms: Date.now() - started,
        chars: root ? root.innerText.length : 0,
        partial: !settled,
        ...(settled ? {} : { note: "content was still changing after " + max + " ms" }),
      });
    var tick = () => {
      var text = root ? root.innerText.length : 0;
      var resources = performance.getEntriesByType("resource").length;
      if (text === lastText && resources === lastResources) stable += 1;
      else {
        stable = 0;
        lastText = text;
        lastResources = resources;
      }
      // The floor counts from the page's own load, not this call: a page that loaded long ago and
      // is quiet returns after two quiet ticks; a fresh one still gets time to render. The ticks
      // before the floor do not count: a page in its first 1.5s can still gain its first content
      // (a client render, a timer), and ending on a tick that ran before the floor read the page
      // one tick too early (the flaky "Late reply" read on a loaded CI runner).
      if (performance.now() < min) stable = 0;
      else if (stable >= 2) return finish(true);
      if (Date.now() - started >= max) return finish(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// What page.read needs to decide its next steps, read in the same call as the Markdown: are there
// repeated rows (a list worth collecting), panels that scroll, frames, a window that scrolls on?
export function __readProbe() {
  var visible = (el) => el.getClientRects().length > 0;
  var guesses = [
    "[data-index]",
    "[data-key]",
    "[role=row]",
    "[role=listitem]",
    "[role=article]",
    "article",
    "li",
  ];
  var rows = 0;
  for (var css of guesses) {
    var count = [...document.querySelectorAll(css)].filter(visible).length;
    if (count >= 3) {
      rows = count;
      break;
    }
  }
  var scrollers = 0;
  for (var el of document.querySelectorAll("body *")) {
    if (el.scrollHeight <= el.clientHeight + 40) continue;
    var box = el.getBoundingClientRect();
    if (
      box.width >= 120 &&
      box.height >= 80 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY)
    )
      scrollers += 1;
  }
  var page = document.scrollingElement || document.documentElement;
  var shadows = [];
  var walk = (root) => {
    for (var host of root.querySelectorAll("*")) {
      if (!host.shadowRoot) continue;
      var text = Array.from(host.shadowRoot.children)
        .map((child) => child.innerText || "")
        .join("\n")
        .trim();
      if (text)
        shadows.push({
          kind: "shadow",
          where: host.tagName.toLowerCase() + (host.id ? "#" + host.id : ""),
          text,
        });
      walk(host.shadowRoot);
    }
  };
  walk(document);
  return {
    rows,
    scrollers,
    frames: document.querySelectorAll("iframe, frame").length,
    windowScrolls: page.scrollHeight > window.innerHeight + 200,
    bodyChars: document.body ? document.body.innerText.trim().length : 0,
    shadows: shadows.slice(0, 30),
  };
}

// Scrolls the window to its end so an infinite feed loads its next page, again while it grows,
// until two rounds in a row add nothing or the budget runs out; then puts the scroll back.
export function __readWindowScroll(options) {
  var page = document.scrollingElement || document.documentElement;
  var start = page.scrollTop;
  var began = Date.now();
  var budget = Math.max(300, Math.min(5500, Number(options.budgetMs) || 4000));
  var stable = 0,
    rounds = 0;
  return new Promise((done) => {
    var finish = (complete) => {
      page.scrollTop = start;
      window.dispatchEvent(new Event("scroll"));
      done({ complete, rounds, height: page.scrollHeight });
    };
    var round = () => {
      if (Date.now() - began >= budget) return finish(false);
      rounds += 1;
      var height = page.scrollHeight;
      page.scrollTop = height;
      window.dispatchEvent(new Event("scroll"));
      var pollStart = Date.now();
      var poll = () => {
        if (page.scrollHeight > height) {
          stable = 0;
          return setTimeout(round, 0);
        }
        if (Date.now() - pollStart < 400 && Date.now() - began < budget) {
          return setTimeout(poll, 50);
        }
        if (++stable >= 2) return finish(true);
        if (Date.now() - began >= budget) return finish(false);
        setTimeout(round, 0);
      };
      setTimeout(poll, 50);
    };
    round();
  });
}

// One page call for page.read: expand, settle, then Markdown, title, URL, data and the probe.
export function __readBatch(fns, options) {
  var expand =
    options.expand === false
      ? { clicked: [], skipped: [] }
      : fns.expand({ max: options.maxClicks ?? 10 });
  var waiting = options.skipWait
    ? Promise.resolve({ settled: false, partial: true, note: "time budget spent" })
    : fns.wait({ maxMs: options.waitMs });
  return waiting.then((wait) => ({
    expand,
    wait,
    markdown: fns.markdown(options.markdown),
    title: document.title,
    url: location.href,
    data: fns.data(fns.metadata, options.data),
    probe: fns.probe(),
  }));
}

// A request the page itself makes: its cookies, origin, Sec-Fetch-* headers and TLS session.
export function __pageRequest(request) {
  return (async () => {
    var headers = new Headers(request.headers || {});
    if (request.csrf) {
      var meta = document.querySelector(
        'meta[name="csrf-token"],meta[name="_csrf"],meta[name="csrf"],meta[name="x-csrf-token"]',
      );
      var cookie = document.cookie.match(
        /(?:^|; )(?:XSRF-TOKEN|xsrf-token|csrftoken|_csrf|csrf_token)=([^;]+)/,
      );
      var token =
        (meta && meta.getAttribute("content")) || (cookie && decodeURIComponent(cookie[1]));
      if (token && !headers.has("x-csrf-token")) headers.set("x-csrf-token", token);
      if (token && cookie && !headers.has("x-xsrf-token")) headers.set("x-xsrf-token", token);
    }
    var body = request.json !== undefined ? JSON.stringify(request.json) : request.body;
    if (request.json !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    var init = {
      method: request.method || "GET",
      headers,
      body,
      credentials: request.credentials || "include",
      redirect: request.redirect || "follow",
    };
    var response;
    try {
      response = await fetch(request.url, init);
    } catch (error) {
      // A site's bot defense can wrap window.fetch and fail calls it did not expect: retry once
      // through an untouched fetch from a fresh same-origin frame.
      if (!(error instanceof TypeError)) throw error;
      var frame = document.createElement("iframe");
      frame.style.display = "none";
      (document.body || document.documentElement).appendChild(frame);
      try {
        var pristine = frame.contentWindow && frame.contentWindow.fetch;
        if (typeof pristine !== "function") throw error;
        response = await pristine.call(
          frame.contentWindow,
          new URL(request.url, location.href).href,
          init,
        );
      } finally {
        frame.remove();
      }
    }
    if (response.type === "opaqueredirect")
      return { status: 0, ok: false, url: request.url, type: "opaqueredirect", headers: {} };
    var text = await response.text();
    var result = {
      status: response.status,
      ok: response.ok,
      url: response.url,
      headers: Object.fromEntries(response.headers),
    };
    try {
      result.json = JSON.parse(text);
    } catch {
      result.text = text.slice(0, 2000000);
    }
    if (response.type) result.type = response.type;
    return result;
  })();
}
