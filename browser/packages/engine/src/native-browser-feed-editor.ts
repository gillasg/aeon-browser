// Page-side halves of page.feed.collect, page.editor and page.cache.read. Each is self-contained
// (it runs in the page by source), takes one plain argument and returns plain data.

// One screen of a virtualized feed: read the items drawn now, then scroll the container (or the
// window) one screen further. Items are keyed by id attribute, data-* key, link or text hash.
export function feedStep(arg: {
  container?: string;
  item?: string;
  scroll?: boolean;
  fraction?: number;
}): unknown {
  const doc = document as any;
  const guess = (): any => {
    const sel =
      '[data-testid="cellInnerDiv"],[role="listitem"],[role="article"],[role="row"],[data-index],[data-item-index],li,article';
    return sel;
  };
  const root: any = arg.container ? doc.querySelector(arg.container) : null;
  if (arg.container && !root) return { missing: arg.container };
  const scope: any = root || doc;
  const nodes: any[] = [...scope.querySelectorAll(arg.item || guess())];
  const outer = nodes.filter((el) => !nodes.some((other) => other !== el && other.contains(el)));
  const hash = (text: string): string => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };
  const items = outer.map((el) => {
    const text = String(el.innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const link = el.querySelector && el.querySelector("a[href]");
    const id =
      el.getAttribute("data-id") ||
      el.getAttribute("data-key") ||
      el.getAttribute("data-message-id") ||
      el.getAttribute("data-item-id") ||
      el.id ||
      (link && link.getAttribute("href")) ||
      null;
    return {
      key: id ? "id:" + id : "h:" + hash(text),
      text: text.slice(0, 2000),
      href: link ? link.href || link.getAttribute("href") : null,
      index: el.getAttribute("data-index") ?? el.getAttribute("aria-posinset"),
    };
  });
  const box: any = root || doc.scrollingElement || doc.documentElement;
  const before = root ? root.scrollTop : ((globalThis as any).scrollY ?? box.scrollTop);
  const view = root ? root.clientHeight : (globalThis as any).innerHeight || box.clientHeight;
  if (arg.scroll !== false) {
    const step = Math.max(120, view * (arg.fraction || 0.85));
    if (root) root.scrollTop = before + step;
    else if (typeof (globalThis as any).scrollTo === "function")
      (globalThis as any).scrollTo(0, before + step);
    else box.scrollTop = before + step;
    (root || globalThis).dispatchEvent?.(new Event("scroll"));
  }
  const after = root ? root.scrollTop : ((globalThis as any).scrollY ?? box.scrollTop);
  return { items, moved: Math.abs(after - before) >= 2, top: before, height: box.scrollHeight };
}

// Which rich editor holds the target (or the focused element, or the first editor on the page).
export function editorDetect(arg: {
  target?: string;
  op?: string;
  text?: string;
  at?: string;
}): unknown {
  const doc = document as any;
  const win = globalThis as any;
  const start: any = arg.target
    ? doc.querySelector(arg.target)
    : doc.activeElement && doc.activeElement !== doc.body
      ? doc.activeElement
      : null;
  const pick = (sel: string): any =>
    (start && start.closest ? start.closest(sel) : null) ||
    (!arg.target
      ? doc.querySelector(sel)
      : start && start.matches && start.matches(sel)
        ? start
        : null);
  const kinds: [string, string][] = [
    ["monaco", ".monaco-editor"],
    ["codemirror", ".cm-editor"],
    ["codemirror5", ".CodeMirror"],
    ["prosemirror", ".ProseMirror"],
    ["lexical", "[data-lexical-editor]"],
    ["slate", "[data-slate-editor]"],
    ["textarea", "textarea,input[type=text],input:not([type])"],
    [
      "contenteditable",
      "[contenteditable=''],[contenteditable=true],[contenteditable=plaintext-only]",
    ],
  ];
  let kind = "";
  let el: any = null;
  for (const [name, sel] of kinds) {
    el = pick(sel);
    if (el) {
      kind = name;
      break;
    }
  }
  if (!el)
    return {
      kind: null,
      error: "NOT_FOUND: no editor on the page" + (arg.target ? " at " + arg.target : ""),
    };
  const monaco = kind === "monaco" && win.monaco && win.monaco.editor;
  const model = monaco
    ? (monaco
        .getEditors?.()
        .find((e: any) => el.contains(e.getDomNode?.()) || e.getDomNode?.() === el)
        ?.getModel() ?? monaco.getModels?.()[0])
    : null;
  const cm6 =
    kind === "codemirror" ? ((el.querySelector(".cm-content") || el).cmView?.view ?? null) : null;
  const cm5 = kind === "codemirror5" ? (el.CodeMirror ?? null) : null;
  const editable =
    kind === "textarea"
      ? el
      : kind === "monaco" || kind === "codemirror5"
        ? null
        : kind === "codemirror"
          ? el.querySelector(".cm-content") || el
          : el;
  const read = (): string => {
    if (model) return model.getValue();
    if (cm6) return cm6.state.doc.toString();
    if (cm5) return cm5.getValue();
    if (kind === "textarea") return el.value;
    if (kind === "monaco" || kind === "codemirror")
      return [...el.querySelectorAll(".view-line,.cm-line")]
        .map((line: any) => line.textContent)
        .join("\n");
    return String(editable.innerText ?? editable.textContent ?? "");
  };
  const meta = {
    kind,
    api: Boolean(model || cm6 || cm5),
    selector: el.id
      ? "#" + el.id
      : el.tagName.toLowerCase() +
        (el.className && typeof el.className === "string"
          ? "." + el.className.trim().split(/\s+/)[0]
          : ""),
  };
  if (!arg.op || arg.op === "detect") return { ...meta, length: read().length };
  if (arg.op === "read") {
    const text = read();
    return { ...meta, text, lines: text.split("\n") };
  }
  const text = String(arg.text ?? "");
  const replace = arg.op === "replace";
  if (model) {
    const range = replace
      ? model.getFullModelRange()
      : (model.getFullModelRange().collapseToEnd?.() ?? model.getFullModelRange());
    model.pushEditOperations([], [{ range, text }], () => null);
  } else if (cm6) {
    const len = cm6.state.doc.length;
    cm6.dispatch({
      changes: replace
        ? { from: 0, to: len, insert: text }
        : { from: arg.at === "start" ? 0 : len, insert: text },
    });
  } else if (cm5) {
    if (replace) cm5.setValue(text);
    else
      cm5.replaceRange(
        text,
        arg.at === "start"
          ? { line: 0, ch: 0 }
          : { line: cm5.lastLine(), ch: cm5.getLine(cm5.lastLine()).length },
      );
  } else if (kind === "textarea") {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = replace ? text : arg.at === "start" ? text + el.value : el.value + text;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(
      new (win.InputEvent || Event)("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // ProseMirror, Lexical, Slate and plain contenteditable all handle beforeinput/insertText
    // themselves; execCommand drives that path and keeps their state in step with the DOM.
    editable.focus?.();
    const selection = win.getSelection?.();
    if (selection && doc.createRange) {
      const range = doc.createRange();
      range.selectNodeContents(editable);
      if (!replace) range.collapse(arg.at === "start");
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const ok = typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text);
    if (!ok) {
      editable.dispatchEvent(
        new (win.InputEvent || Event)("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        }),
      );
      if (replace) editable.textContent = text;
      else
        editable.textContent =
          arg.at === "start" ? text + editable.textContent : editable.textContent + text;
      editable.dispatchEvent(
        new (win.InputEvent || Event)("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }),
      );
    }
  }
  return { ...meta, done: arg.op, length: read().length };
}

// Cache Storage on this origin, read from disk by the browser: no request leaves the page.
export async function cacheRead(arg: {
  cacheName?: string;
  url?: string | [string, string];
  contentType?: string;
  limit?: number;
  maxBytes?: number;
  body?: boolean;
}): Promise<unknown> {
  const store = (globalThis as any).caches;
  if (!store)
    return {
      origin: (globalThis as any).location?.origin,
      caches: [],
      entries: [],
      error: "UNSUPPORTED: Cache Storage is not available here",
    };
  const names: string[] = await store.keys();
  const wanted = names.filter(
    (name) => !arg.cacheName || name === arg.cacheName || name.includes(arg.cacheName),
  );
  const urlTest = Array.isArray(arg.url) ? new RegExp(arg.url[0], arg.url[1]) : null;
  const limit = Math.min(arg.limit ?? 50, 500);
  const maxBytes = Math.min(arg.maxBytes ?? 200000, 2000000);
  const entries: any[] = [];
  let total = 0;
  for (const cacheName of wanted) {
    const cache = await store.open(cacheName);
    for (const request of await cache.keys()) {
      if (entries.length >= limit) break;
      const url = String(request.url);
      if (urlTest ? !urlTest.test(url) : typeof arg.url === "string" && !url.includes(arg.url))
        continue;
      const response = await cache.match(request);
      if (!response) continue;
      const type = String(response.headers.get("content-type") || "");
      if (arg.contentType && !type.includes(arg.contentType)) continue;
      total += 1;
      const row: any = {
        cacheName,
        url,
        method: request.method,
        status: response.status,
        contentType: type,
        date: response.headers.get("date"),
      };
      if (arg.body !== false) {
        const text: string = await response.clone().text();
        row.bytes = text.length;
        row.truncated = text.length > maxBytes;
        const cut = text.slice(0, maxBytes);
        if (/json/.test(type) || /^\s*[[{]/.test(cut)) {
          try {
            row.json = JSON.parse(text.length > maxBytes ? "" : cut);
          } catch {
            row.text = cut;
          }
        } else if (/^text\/|javascript|xml/.test(type)) row.text = cut;
      }
      entries.push(row);
    }
  }
  return { origin: (globalThis as any).location?.origin, caches: names, entries, matched: total };
}
